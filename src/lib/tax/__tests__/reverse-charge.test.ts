import { describe, expect, it } from 'vitest';
import { computeYear } from '../compute';
import type { AssetFact } from '../assets';
import {
  ReverseChargeInputError,
  earlierDay,
  reverseChargeFor,
  reverseChargeTax,
  validateEffectiveFrom,
  validateReverseChargeRate,
  withReverseCharge,
  type ReverseChargeEntry,
} from '../reverse-charge';
import { rulesForYear } from '../rules';
import type { LedgerItem, YearFacts } from '../types';
import { vatYear } from '../vat';
import { SYNTHETIC_YEAR, item } from './fixtures';

const run = (facts: Partial<YearFacts>, year = 2026) => computeYear({ year, items: [], ...facts }, rulesForYear(year));

/** A software subscription from a supplier abroad: 100.00 euros, no German tax on the invoice. */
function foreignService(overrides: Partial<LedgerItem> & { id: string }, rateBp = 1900): LedgerItem {
  const base = item({ date: '2026-05-20', formLineKey: 'euer.it_running', ...overrides });
  return withReverseCharge(base, rateBp as 1900 | 700, overrides.date ?? '2026-05-20', base.smallBusiness);
}

const entry = (overrides: Partial<ReverseChargeEntry> & { id: string }): ReverseChargeEntry => ({
  scope: 'vendor',
  subject: 'cloud host',
  label: 'Cloud Host Ltd',
  effectiveFrom: '',
  rateBp: 1900,
  ...overrides,
});

describe('which statement applies to a receipt', () => {
  it('nothing stated: no section 13b', () => {
    expect(reverseChargeFor([], 'r1', 'cloud host', '2026-05-20')).toBeNull();
  });

  it('the vendor entry in force on the document day, the latest that started on or before it', () => {
    const entries = [entry({ id: 'v0', effectiveFrom: '', rateBp: 700 }), entry({ id: 'v1', effectiveFrom: '2026-04-01', rateBp: 1900 })];
    expect(reverseChargeFor(entries, 'r1', 'cloud host', '2026-03-31')).toEqual({ rateBp: 700, origin: 'vendor_rule', entryId: 'v0' });
    expect(reverseChargeFor(entries, 'r1', 'cloud host', '2026-04-01')).toEqual({ rateBp: 1900, origin: 'vendor_rule', entryId: 'v1' });
    // Without a date only an entry from the beginning applies.
    expect(reverseChargeFor(entries, 'r1', 'cloud host', null)).toEqual({ rateBp: 700, origin: 'vendor_rule', entryId: 'v0' });
    expect(reverseChargeFor(entries, 'r1', 'another vendor', '2026-05-01')).toBeNull();
    expect(reverseChargeFor(entries, 'r1', null, '2026-05-01')).toBeNull();
  });

  it('a vendor entry without a rate ends an earlier one', () => {
    const entries = [entry({ id: 'v0' }), entry({ id: 'v1', effectiveFrom: '2026-07-01', rateBp: null })];
    expect(reverseChargeFor(entries, 'r1', 'cloud host', '2026-06-30')?.rateBp).toBe(1900);
    expect(reverseChargeFor(entries, 'r1', 'cloud host', '2026-07-01')).toBeNull();
  });

  it("the receipt's own statement wins, also when it says no", () => {
    const vendor = entry({ id: 'v0' });
    expect(reverseChargeFor([vendor, entry({ id: 'own', scope: 'row', subject: 'r1', rateBp: 700 })], 'r1', 'cloud host', '2026-05-20')).toEqual({
      rateBp: 700,
      origin: 'item',
      entryId: 'own',
    });
    expect(reverseChargeFor([vendor, entry({ id: 'own', scope: 'row', subject: 'r1', rateBp: null })], 'r1', 'cloud host', '2026-05-20')).toBeNull();
    // Another receipt's own statement does not touch this one.
    expect(reverseChargeFor([vendor, entry({ id: 'own', scope: 'row', subject: 'r2', rateBp: null })], 'r1', 'cloud host', '2026-05-20')?.rateBp).toBe(1900);
  });
});

describe('putting the statement on an item', () => {
  it('the amount is the net amount, and the tax carries its own day and the status of that day', () => {
    const paidLater = item({ id: 'a', date: '2026-06-03', dateBasis: 'payment', amountCents: 12_000, netCents: null });
    const result = withReverseCharge(paidLater, 1900, '2026-05-20', true);
    expect(result.netCents).toBe(12_000);
    expect(result.reverseCharge).toEqual({ rateBp: 1900, taxDay: '2026-05-20', smallBusinessOnTaxDay: true });
  });

  it('without a tax day the day it counts on stands in', () => {
    expect(withReverseCharge(item({ id: 'a', date: '2026-06-03' }), 700, null, false).reverseCharge).toEqual({
      rateBp: 700,
      taxDay: '2026-06-03',
      smallBusinessOnTaxDay: false,
    });
  });

  it('no rate, or a meal: the item is left exactly as it was', () => {
    const plain = item({ id: 'a' });
    expect(withReverseCharge(plain, null, '2026-05-20', true)).toBe(plain);
    const meal = item({ id: 'm', meal: { status: 'complete', deductibleCents: 7000, nonDeductibleCents: 3000 } });
    expect(withReverseCharge(meal, 1900, '2026-05-20', true)).toBe(meal);
  });

  it('a payment before the invoice makes the tax arise on the payment day (section 13b (4) sentence 2)', () => {
    expect(earlierDay('2026-05-20', '2026-04-28')).toBe('2026-04-28');
    expect(earlierDay('2026-05-20', '2026-06-03')).toBe('2026-05-20');
    expect(earlierDay(null, '2026-06-03')).toBe('2026-06-03');
    expect(earlierDay('2026-05-20', undefined)).toBe('2026-05-20');
    expect(earlierDay(null, null)).toBeNull();
  });

  it('the tax is rounded to the cent', () => {
    expect(reverseChargeTax(10_000, 1900)).toBe(1900);
    expect(reverseChargeTax(1234, 1900)).toBe(234); // 234.46
    expect(reverseChargeTax(1250, 700)).toBe(88); // 87.5
  });
});

describe('what a person may send', () => {
  it('19 or 7 percent, or null for "not under section 13b"', () => {
    expect(validateReverseChargeRate(1900)).toBe(1900);
    expect(validateReverseChargeRate(700)).toBe(700);
    expect(validateReverseChargeRate(null)).toBeNull();
    for (const bad of [0, 1600, '1900', undefined, 19]) {
      expect(() => validateReverseChargeRate(bad)).toThrow(ReverseChargeInputError);
    }
  });

  it('a start day is empty or a real day', () => {
    expect(validateEffectiveFrom('')).toBe('');
    expect(validateEffectiveFrom(undefined)).toBe('');
    expect(validateEffectiveFrom('2026-02-28')).toBe('2026-02-28');
    expect(() => validateEffectiveFrom('2026-02-30')).toThrow(ReverseChargeInputError);
  });
});

describe('computing the tax owed', () => {
  it('regular taxation: owed and deductible in the same amount, the cost is the whole amount without input tax of its own', () => {
    const result = run({ items: [foreignService({ id: 'svc', smallBusiness: false })] });
    expect(result.reverseChargeEvents).toEqual([{ date: '2026-05-20', cents: 1900, source: 'item', id: 'svc' }]);
    expect(result.reverseChargeInputEvents).toEqual([{ date: '2026-05-20', cents: 1900, source: 'item', id: 'svc' }]);
    expect(result.businessExpenseCents).toBe(10_000);
    // Neither figure is money paid: the input tax line stays empty.
    expect(result.lines.find((l) => l.key === 'euer.input_vat')).toBeUndefined();
    expect(result.inputVatEvents).toEqual([]);
  });

  it('regular taxation with a private share: the whole tax is owed, only the business share is deductible', () => {
    const result = run({ items: [foreignService({ id: 'svc', smallBusiness: false, allocations: [{ purpose: 'business', shareBp: 6000 }] })] });
    expect(result.reverseChargeEvents[0].cents).toBe(1900);
    expect(result.reverseChargeInputEvents[0].cents).toBe(1140);
  });

  it('small business: the tax is owed and nothing is deductible; the cost stays the amount paid', () => {
    const result = run({ items: [foreignService({ id: 'svc', smallBusiness: true })] });
    expect(result.reverseChargeEvents).toEqual([{ date: '2026-05-20', cents: 1900, source: 'item', id: 'svc' }]);
    expect(result.reverseChargeInputEvents).toEqual([]);
    expect(result.businessExpenseCents).toBe(10_000);
  });

  it('the reduced rate', () => {
    expect(run({ items: [foreignService({ id: 'svc' }, 700)] }).reverseChargeEvents[0].cents).toBe(700);
  });

  it('the whole tax is owed also on shares outside the business (section 13b (5) sentence 7); that part is reported, never deducted', () => {
    const allPrivate = run({ items: [foreignService({ id: 'svc', smallBusiness: false, allocations: [{ purpose: 'private', shareBp: 10_000 }], formLineKey: null })] });
    expect(allPrivate.reverseChargeEvents.map((e) => e.cents)).toEqual([1900]);
    expect(allPrivate.reverseChargeInputEvents).toEqual([]);
    expect(allPrivate.reverseChargeNonBusinessCents).toBe(1900);
    const mixed = run({
      items: [
        foreignService({
          id: 'svc',
          smallBusiness: false,
          employmentLineKey: 'employment.study_costs',
          allocations: [
            { purpose: 'business', shareBp: 5000 },
            { purpose: 'study', shareBp: 3000 },
          ],
        }),
      ],
    });
    expect(mixed.reverseChargeInputEvents.map((e) => e.cents)).toEqual([950]);
    expect(mixed.reverseChargeNonBusinessCents).toBe(950);
    // A small business deducts nothing; the share outside the business is still reported.
    expect(run({ items: [foreignService({ id: 'svc', allocations: [{ purpose: 'business', shareBp: 6000 }] })] }).reverseChargeNonBusinessCents).toBe(760);
  });

  it('belongs to the year of the tax day: a December invoice paid in January is December tax', () => {
    const decemberInvoice = withReverseCharge(item({ id: 'svc', date: '2027-01-08', dateBasis: 'payment' }), 1900, '2026-12-15', true);
    expect(run({ items: [decemberInvoice] }, 2026).reverseChargeEvents.map((e) => e.date)).toEqual(['2026-12-15']);
    const next = run({ items: [decemberInvoice] }, 2027);
    expect(next.reverseChargeEvents).toEqual([]);
    // The expense itself still counts on the payment day (cash basis).
    expect(next.businessExpenseCents).toBe(10_000);
  });

  it('only what cannot be known is pending: an open check, an unknown asset, an unanswered status', () => {
    const blocked = foreignService({ id: 'blocked', allocations: null });
    const unknownAsset = foreignService({ id: 'asset-part', assetId: 'no-such-asset' });
    const unanswered = withReverseCharge(item({ id: 'u', date: '2026-05-20' }), 1900, '2026-05-20', null);
    const result = run({ items: [blocked, unknownAsset, unanswered] });
    expect(result.reverseChargeEvents).toEqual([]);
    expect(result.reverseChargePendingItems).toBe(3);
  });

  it("a receipt that is part of an asset owes the tax on its amount, deductible by the asset's business share", () => {
    const licence: AssetFact = {
      id: 'asset-1',
      label: 'Software licence',
      kind: 'intangible',
      acquisitionDate: '2026-05-20',
      costCents: 200_000,
      netCostCents: 200_000,
      method: 'linear',
      usefulLifeMonths: 36,
      decliningRateBp: null,
      businessShareBp: 8000,
      reminderCents: 0,
      opening: null,
      disposal: null,
      smallBusiness: false,
    };
    const part = foreignService({ id: 'licence', amountCents: 200_000, smallBusiness: false, allocations: null, assetId: 'asset-1' });
    const result = run({ items: [part], assets: [licence] });
    expect(result.reverseChargeEvents.map((e) => e.cents)).toEqual([38_000]);
    expect(result.reverseChargeInputEvents.map((e) => e.cents)).toEqual([30_400]);
    expect(result.reverseChargeNonBusinessCents).toBe(7600);
    expect(result.reverseChargePendingItems).toBe(0);
  });

  it('a status change between the invoice and its payment: the status of the tax day decides the deduction', () => {
    // Invoiced in June under section 19, paid in July after the switch to regular taxation.
    const invoicedUnder19 = withReverseCharge(item({ id: 'a', date: '2026-07-05', dateBasis: 'payment', smallBusiness: false }), 1900, '2026-06-20', true);
    const a = run({ items: [invoicedUnder19] });
    expect(a.reverseChargeEvents.map((e) => e.date)).toEqual(['2026-06-20']);
    expect(a.reverseChargeInputEvents).toEqual([]);
    // The other way round: invoiced under regular taxation, paid after the return to section 19.
    const invoicedRegular = withReverseCharge(item({ id: 'b', date: '2026-07-05', dateBasis: 'payment', smallBusiness: true }), 1900, '2026-06-20', false);
    expect(run({ items: [invoicedRegular] }).reverseChargeInputEvents.map((e) => e.cents)).toEqual([1900]);
  });

  it('a split receipt: each line owes the tax on its own part', () => {
    const lineA = foreignService({ id: 'r#l1', amountCents: 6000 });
    const lineB = foreignService({ id: 'r#l2', amountCents: 4000, allocations: [{ purpose: 'private', shareBp: 10_000 }], formLineKey: null });
    const result = run({ items: [lineA, lineB] });
    expect(result.reverseChargeEvents.map((e) => [e.id, e.cents])).toEqual([
      ['r#l1', 1140],
      ['r#l2', 760],
    ]);
    expect(result.reverseChargeNonBusinessCents).toBe(760);
  });

  it('a receipt in another currency owes the tax on its booked euro amount', () => {
    const usd = foreignService({ id: 'usd', amountCents: 9_231, amountBasis: 'reference_rate' });
    expect(run({ items: [usd] }).reverseChargeEvents.map((e) => e.cents)).toEqual([1754]);
  });

  it('a meal never carries the tax', () => {
    const meal = {
      ...item({ id: 'm', date: '2026-05-20', formLineKey: 'euer.meals', meal: { status: 'complete' as const, deductibleCents: 7000, nonDeductibleCents: 3000 } }),
      reverseCharge: { rateBp: 1900, taxDay: '2026-05-20', smallBusinessOnTaxDay: true },
    };
    expect(run({ items: [meal] }).reverseChargeEvents).toEqual([]);
  });

  it('items without the statement compute exactly as before: same lines, totals and events', () => {
    const before = computeYear({ year: 2025, items: SYNTHETIC_YEAR }, rulesForYear(2025));
    // The same year with one more receipt under section 13b changes the
    // section 13b figures and that receipt's own line, nothing else.
    const withOne = computeYear({ year: 2025, items: [...SYNTHETIC_YEAR, foreignService({ id: 'svc', date: '2025-05-20' })] }, rulesForYear(2025));
    expect(before.reverseChargeEvents).toEqual([]);
    expect(before.reverseChargeInputEvents).toEqual([]);
    expect(before.reverseChargePendingItems).toBe(0);
    expect(withOne.businessExpenseCents - before.businessExpenseCents).toBe(10_000);
    expect(withOne.employmentCostCents).toBe(before.employmentCostCents);
    expect(withOne.inputVatEvents).toEqual(before.inputVatEvents);
    expect(withOne.items.filter((i) => i.itemId !== 'svc')).toEqual(before.items);
    expect(withOne.outputVatByIssue).toEqual(before.outputVatByIssue);
    expect(withOne.outputVatByPayment).toEqual(before.outputVatByPayment);
    // Every line is the same, except the marked receipt's own line, which grew by its amount.
    const lines = (r: typeof before) => new Map(r.lines.map((l) => [l.key, l.cents]));
    const diff = [...lines(withOne)].filter(([key, cents]) => lines(before).get(key) !== cents);
    expect(diff).toEqual([['euer.it_running', (lines(before).get('euer.it_running') ?? 0) + 10_000]]);
    expect([...lines(before).keys()].every((key) => lines(withOne).has(key))).toBe(true);
  });
});

describe('the advance return periods', () => {
  const owed = [{ date: '2026-02-10', cents: 1900, source: 'item' as const, id: 'a' }, { date: '2026-05-20', cents: 700, source: 'item' as const, id: 'b' }];

  it('regular: owed and deductible land in the period of their day and cancel out for the business share', () => {
    const year = vatYear(2026, 'quarterly', 'issued', {
      inputVat: [{ date: '2026-02-11', cents: 500, source: 'item', id: 'c' }],
      outputVatByIssue: [],
      outputVatByPayment: [],
      reverseCharge: owed,
      reverseChargeInput: owed,
    });
    expect(year.periods[0]).toMatchObject({ reverseChargeVatCents: 1900, reverseChargeInputVatCents: 1900, inputVatCents: 500, dueCents: -500 });
    expect(year.periods[1]).toMatchObject({ reverseChargeVatCents: 700, reverseChargeInputVatCents: 700, dueCents: 0 });
    expect(year).toMatchObject({ reverseChargeVatCents: 2600, reverseChargeInputVatCents: 2600, dueCents: -500 });
  });

  it('small business: what is owed is due, whatever the taxation method', () => {
    for (const method of ['issued', 'received'] as const) {
      const year = vatYear(2026, 'monthly', method, { inputVat: [], outputVatByIssue: [], outputVatByPayment: [], reverseCharge: owed });
      expect(year.periods[1].dueCents).toBe(1900);
      expect(year.periods[4].dueCents).toBe(700);
      expect(year.periods[4].reverseCharge).toEqual([owed[1]]);
      expect(year.dueCents).toBe(2600);
    }
  });

  it('without section 13b events a period is what it was', () => {
    const year = vatYear(2026, 'quarterly', 'issued', { inputVat: [], outputVatByIssue: [{ date: '2026-01-05', cents: 1900, source: 'invoice', id: 'i' }], outputVatByPayment: [] });
    expect(year.periods[0]).toMatchObject({ outputVatCents: 1900, reverseChargeVatCents: 0, reverseChargeInputVatCents: 0, dueCents: 1900 });
  });
});

describe('a marked receipt whose own figures show German tax', () => {
  it('ignores the tax read off the receipt: no input tax from the receipt itself, the expense is the whole amount', () => {
    // The reader took a 19 percent line off a foreign invoice: 119.00 with 100.00 net.
    const read = item({ id: 'r', date: '2026-05-20', amountCents: 11_900, netCents: 10_000, smallBusiness: false, formLineKey: 'euer.it_running' });
    const marked = withReverseCharge(read, 1900, '2026-05-20', false);
    const result = computeYear({ year: 2026, items: [marked] }, rulesForYear(2026));
    expect(result.inputVatEvents.filter((e) => e.source === 'item')).toEqual([]);
    expect(result.lines.find((l) => l.key === 'euer.it_running')?.cents).toBe(11_900);
  });

  it('a credit note owes the same tax as an invoice, with the opposite sign', () => {
    expect(reverseChargeTax(250, 1900)).toBe(48);
    expect(reverseChargeTax(-250, 1900)).toBe(-48);
  });
});
