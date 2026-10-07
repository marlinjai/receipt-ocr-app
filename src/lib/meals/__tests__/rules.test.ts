import { describe, it, expect } from 'vitest';
import {
  estimatedVatRate,
  hostMustBeNamedOnReceipt,
  mealDeduction,
  mealStatus,
  occasionQuality,
  parseTaxLines,
  serializeTaxLines,
  toCents,
  vatSplit,
} from '../rules';
import { GUEST_A, GUEST_B, REGULAR_BUSINESS, SMALL_BUSINESS, UNANSWERED, meal } from './fixtures';

describe('mealStatus', () => {
  it('a fully documented external business meal is complete', () => {
    expect(mealStatus(meal())).toEqual({ kind: 'complete' });
  });

  it('a row of another category is not a meal, whatever meal details it still carries', () => {
    expect(mealStatus(meal({ category: 'Reisekosten' }))).toEqual({ kind: 'not_a_meal' });
    expect(mealStatus(meal({ category: null }))).toEqual({ kind: 'not_a_meal' });
  });

  it('"Keine Bewirtung" takes a Bewirtung row out of the register', () => {
    expect(mealStatus(meal({ mealType: 'not_a_meal' }))).toEqual({ kind: 'not_a_meal' });
  });

  it('a private meal is excluded, not incomplete', () => {
    expect(mealStatus(meal({ zuordnung: 'Privat', guests: [] }))).toEqual({
      kind: 'excluded',
      reason: 'private',
    });
  });

  it('staff meals and travel meals are recorded but excluded from the register', () => {
    expect(mealStatus(meal({ mealType: 'staff_meal_internal' }))).toEqual({
      kind: 'excluded',
      reason: 'staff_meal_internal',
    });
    expect(mealStatus(meal({ mealType: 'travel_meal', guests: [] }))).toEqual({
      kind: 'excluded',
      reason: 'travel_meal',
    });
  });

  it('a Bewirtung row from before the feature (no meal cells at all) is incomplete, not an error', () => {
    const legacy = meal({
      mealType: null,
      occasion: '',
      place: '',
      host: '',
      tip: null,
      consumption: null,
      detailsAt: null,
      guests: [],
    });
    expect(mealStatus(legacy)).toEqual({
      kind: 'incomplete',
      missing: ['mealType', 'place', 'occasion', 'host', 'guests'],
    });
  });

  it('a meal eaten alone is not complete: the host does not count as a guest', () => {
    expect(mealStatus(meal({ guests: [] }))).toEqual({ kind: 'incomplete', missing: ['guests'] });
  });

  it('each legally required fact is checked on its own', () => {
    expect(mealStatus(meal({ date: null }))).toEqual({ kind: 'incomplete', missing: ['date'] });
    expect(mealStatus(meal({ place: '   ' }))).toEqual({ kind: 'incomplete', missing: ['place'] });
    expect(mealStatus(meal({ gross: null }))).toEqual({ kind: 'incomplete', missing: ['gross'] });
    expect(mealStatus(meal({ gross: 0 }))).toEqual({ kind: 'incomplete', missing: ['gross'] });
    expect(mealStatus(meal({ host: '' }))).toEqual({ kind: 'incomplete', missing: ['host'] });
    expect(mealStatus(meal({ occasion: '' }))).toEqual({ kind: 'incomplete', missing: ['occasion'] });
  });

  it('a generic occasion is rejected with its own reason', () => {
    expect(mealStatus(meal({ occasion: 'Geschäftsessen' }))).toEqual({
      kind: 'incomplete',
      missing: ['occasionTooGeneric'],
    });
  });

  it('a foreign-currency receipt without an exchange rate is incomplete instead of exporting a zero', () => {
    expect(mealStatus(meal({ currency: 'USD', fxRate: null }))).toEqual({
      kind: 'incomplete',
      missing: ['fxRate'],
    });
    expect(mealStatus(meal({ currency: 'USD', fxRate: 0.92 }))).toEqual({ kind: 'complete' });
  });
});

describe('mealStatus is derived (backtrack and revise)', () => {
  it('reclassifying away and back restores the same entry, details untouched', () => {
    const original = meal();
    const away = { ...original, category: 'Reisekosten' };
    expect(mealStatus(away).kind).toBe('not_a_meal');
    // The details are still on the record; only the status changed.
    expect(away.occasion).toBe(original.occasion);
    expect(away.guests).toEqual(original.guests);
    const back = { ...away, category: 'Bewirtung' };
    expect(mealStatus(back)).toEqual({ kind: 'complete' });
  });

  it('clearing the guests makes a complete meal incomplete on the next read', () => {
    expect(mealStatus(meal({ guests: [GUEST_A, GUEST_B] })).kind).toBe('complete');
    expect(mealStatus(meal({ guests: [] })).kind).toBe('incomplete');
  });
});

describe('occasionQuality', () => {
  it.each(['', '   ', null, undefined])('empty: %j', (v) => {
    expect(occasionQuality(v)).toBe('empty');
  });
  it.each(['Meeting', 'Besprechung', 'Geschäftsessen', 'geschaeftsessen.', 'Business Lunch', ' ESSEN '])(
    'generic: %s',
    (v) => {
      expect(occasionQuality(v)).toBe('generic');
    },
  );
  it.each(['Besprechung Angebot Fotoproduktion', 'Jahresplanung 2026', 'Meeting Relaunch'])('ok: %s', (v) => {
    expect(occasionQuality(v)).toBe('ok');
  });
});

describe('mealDeduction', () => {
  it('shows nothing while the section 19 question is unanswered', () => {
    expect(mealDeduction(meal(), UNANSWERED)).toEqual({ kind: 'setting_missing' });
  });

  it('small business (section 19): 70 percent of gross plus tip, no input tax', () => {
    expect(mealDeduction(meal({ gross: 119, tip: 11 }), SMALL_BUSINESS)).toEqual({
      kind: 'ok',
      basis: 'gross',
      gross: 119,
      tip: 11,
      net: null,
      inputVat: null,
      base: 130,
      deductible: 91,
      nonDeductible: 39,
      vatEstimated: false,
      vatLinesMismatch: false,
    });
  });

  it('regular business: 70 percent of net plus tip, input tax listed in full', () => {
    const d = mealDeduction(
      meal({ gross: 119, tip: 11, taxLines: [{ rate: 19, net: 100, tax: 19 }] }),
      REGULAR_BUSINESS,
    );
    expect(d).toEqual({
      kind: 'ok',
      basis: 'net',
      gross: 119,
      tip: 11,
      net: 100,
      inputVat: 19,
      base: 111,
      deductible: 77.7,
      nonDeductible: 33.3,
      vatEstimated: false,
      vatLinesMismatch: false,
    });
  });

  it('a tip counts only when entered', () => {
    const d = mealDeduction(meal({ gross: 100, tip: null }), SMALL_BUSINESS);
    expect(d).toMatchObject({ tip: 0, base: 100, deductible: 70, nonDeductible: 30 });
  });

  it('changing the gross, the tip or the setting changes the result (nothing is cached)', () => {
    const base = meal({ gross: 100, tip: 0 });
    expect(mealDeduction(base, SMALL_BUSINESS)).toMatchObject({ deductible: 70 });
    expect(mealDeduction({ ...base, gross: 200 }, SMALL_BUSINESS)).toMatchObject({ deductible: 140 });
    expect(mealDeduction({ ...base, tip: 10 }, SMALL_BUSINESS)).toMatchObject({ deductible: 77 });
    expect(mealDeduction(base, REGULAR_BUSINESS)).toMatchObject({ basis: 'net' });
  });

  it('deductible and non-deductible always add up to the base, to the cent', () => {
    for (const gross of [0.01, 0.05, 9.99, 33.33, 47.11, 101.01, 249.99, 1234.57]) {
      for (const tip of [0, 0.5, 3.33]) {
        const d = mealDeduction(meal({ gross, tip }), SMALL_BUSINESS);
        if (d.kind !== 'ok') throw new Error('expected ok');
        expect(toCents(d.deductible) + toCents(d.nonDeductible)).toBe(toCents(d.base));
        expect(toCents(d.base)).toBe(toCents(gross) + toCents(tip));
      }
    }
  });

  it('rounds the 70 percent to whole cents', () => {
    // 33.33 * 0.7 = 23.331
    expect(mealDeduction(meal({ gross: 33.33, tip: null }), SMALL_BUSINESS)).toMatchObject({
      deductible: 23.33,
      nonDeductible: 10,
    });
  });

  it('converts a foreign-currency receipt with the row exchange rate', () => {
    const d = mealDeduction(meal({ currency: 'USD', fxRate: 0.9, gross: 100, tip: 10 }), SMALL_BUSINESS);
    expect(d).toMatchObject({ gross: 90, tip: 9, base: 99, deductible: 69.3 });
  });

  it('reports no amount instead of a zero when the total or the exchange rate is missing', () => {
    expect(mealDeduction(meal({ gross: null }), SMALL_BUSINESS)).toEqual({ kind: 'no_amount' });
    expect(mealDeduction(meal({ currency: 'USD', fxRate: null }), SMALL_BUSINESS)).toEqual({
      kind: 'no_amount',
    });
  });

  it('does not apply the Business Share column on top (it is not part of the record)', () => {
    expect(Object.keys(meal())).not.toContain('businessShare');
  });
});

describe('value-added tax: date- and item-aware', () => {
  it('2025 receipt without tax lines: 19 percent for food eaten in, flagged as estimated', () => {
    const d = mealDeduction(meal({ date: '2025-11-20', gross: 119, tip: null }), REGULAR_BUSINESS);
    expect(d).toMatchObject({ net: 100, inputVat: 19, vatEstimated: true });
  });

  it('2025 takeaway without tax lines: 7 percent', () => {
    expect(estimatedVatRate('2025-11-20', 'takeaway')).toBe(7);
    const d = mealDeduction(
      meal({ date: '2025-11-20', consumption: 'takeaway', gross: 107, tip: null }),
      REGULAR_BUSINESS,
    );
    expect(d).toMatchObject({ net: 100, inputVat: 7, vatEstimated: true });
  });

  it('2026 receipt with 7 percent food and 19 percent drinks on one receipt is summed per rate, exact', () => {
    const d = mealDeduction(
      meal({
        date: '2026-02-03',
        gross: 80.7,
        tip: null,
        taxLines: [
          { rate: 7, net: 50, tax: 3.5 },
          { rate: 19, net: 22.86, tax: 4.34 },
        ],
      }),
      REGULAR_BUSINESS,
    );
    expect(d).toMatchObject({
      net: 72.86,
      inputVat: 7.84,
      base: 72.86,
      deductible: 51,
      vatEstimated: false,
      vatLinesMismatch: false,
    });
  });

  it('2026 receipt without tax lines falls back to 7 percent and is flagged as estimated', () => {
    expect(estimatedVatRate('2026-01-01', 'dine_in')).toBe(7);
    expect(estimatedVatRate('2025-12-31', 'dine_in')).toBe(19);
    expect(estimatedVatRate(null, null)).toBe(19);
    const d = mealDeduction(meal({ date: '2026-02-03', gross: 107, tip: null }), REGULAR_BUSINESS);
    expect(d).toMatchObject({ net: 100, inputVat: 7, vatEstimated: true });
  });

  it('flags tax lines that do not add up to the receipt total', () => {
    const split = vatSplit(meal({ gross: 119, taxLines: [{ rate: 19, net: 90, tax: 17.1 }] }));
    expect(split.linesMismatch).toBe(true);
    expect(split.estimated).toBe(false);
  });

  it('tolerates a rounding difference of up to two cents', () => {
    const split = vatSplit(meal({ gross: 119.02, taxLines: [{ rate: 19, net: 100, tax: 19 }] }));
    expect(split.linesMismatch).toBe(false);
  });
});

describe('tax line parsing', () => {
  it('round-trips well-formed lines', () => {
    const lines = [
      { rate: 7, net: 50, tax: 3.5 },
      { rate: 19, net: 10, tax: 1.9 },
    ];
    expect(parseTaxLines(serializeTaxLines(lines))).toEqual(lines);
  });

  it.each(['', '   ', 'not json', '{}', '[]', '[{"rate":"19"}]', '[{"rate":19,"net":-1,"tax":0}]', null, 42])(
    'reads malformed input as "no tax lines": %j',
    (cell) => {
      expect(parseTaxLines(cell)).toBeNull();
    },
  );

  it('drops only the malformed lines', () => {
    expect(parseTaxLines('[{"rate":19,"net":10,"tax":1.9},{"rate":"x"}]')).toEqual([
      { rate: 19, net: 10, tax: 1.9 },
    ]);
  });
});

describe('hostMustBeNamedOnReceipt', () => {
  it('warns above the threshold only', () => {
    expect(hostMustBeNamedOnReceipt(meal({ gross: 250 }), SMALL_BUSINESS)).toBe(false);
    expect(hostMustBeNamedOnReceipt(meal({ gross: 250.01 }), SMALL_BUSINESS)).toBe(true);
    expect(
      hostMustBeNamedOnReceipt(meal({ gross: 260 }), { ...SMALL_BUSINESS, hostAddressThresholdEur: 300 }),
    ).toBe(false);
  });
});
