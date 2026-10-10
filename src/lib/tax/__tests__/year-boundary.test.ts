import { describe, expect, it } from 'vitest';
import { REGULAR_BUSINESS, SMALL_BUSINESS, meal } from '@/lib/meals/__tests__/fixtures';
import type { MealRecord } from '@/lib/meals/types';
import { computeYear } from '../compute';
import { resolveItem, resolveItems, type ReceiptFacts } from '../facts';
import { rulesForYear } from '../rules';
import { answerFor, boundaryDay, otherYearOf, touchesYear } from '../year-boundary';

/** Invented: a monthly rent of 650.00. */
function rent(overrides: Partial<MealRecord> = {}): MealRecord {
  return meal({ rowId: 'r-1', name: 'Miete Januar', vendor: 'Vermieter Beispiel', category: 'Miete', mealType: null, gross: 650, net: null, date: '2025-12-29', occasion: '', place: '', host: '', tip: null, guests: [], ...overrides });
}
const facts = (record: MealRecord, extra: Partial<ReceiptFacts> = {}): ReceiptFacts => ({ record, businessSharePercent: null, decision: null, lines: [], ...extra });
const BUSINESS = { allocations: [{ purpose: 'business' as const, shareBp: 10000 }], formLineKey: 'euer.rent_business_premises' as const, employmentLineKey: null };

describe('the ten-day window', () => {
  it.each([
    ['2025-12-21', null],
    ['2025-12-22', 2026],
    ['2025-12-31', 2026],
    ['2026-01-01', 2025],
    ['2026-01-10', 2025],
    ['2026-01-11', null],
    ['2026-06-30', null],
    ['2026-12-32', null],
    ['', null],
    [null, null],
    ['31.12.2025', null],
  ])('%s can belong to %s', (day, other) => {
    expect(otherYearOf(day)).toBe(other);
  });

  it('a payment that belongs to the other year counts on that year\'s nearest day', () => {
    expect(boundaryDay('2025-12-29')).toBe('2026-01-01');
    expect(boundaryDay('2026-01-08')).toBe('2025-12-31');
    expect(boundaryDay('2026-01-11')).toBeNull();
  });

  it('a payment in the window is of interest in both years it touches, and in no other', () => {
    expect([2024, 2025, 2026, 2027].map((y) => touchesYear('2025-12-29', y))).toEqual([false, true, true, false]);
    expect([2024, 2025, 2026, 2027].map((y) => touchesYear('2026-01-08', y))).toEqual([false, true, true, false]);
    expect(touchesYear('2026-03-01', 2026)).toBe(false);
  });

  it('an answer applies only to the payment day it was given for', () => {
    const stored = { cashDay: '2025-12-29', belongsToOtherYear: true };
    expect(answerFor(stored, '2025-12-29')).toBe(true);
    expect(answerFor({ ...stored, belongsToOtherYear: false }, '2025-12-29')).toBe(false);
    expect(answerFor(stored, '2025-12-30')).toBeNull();
    expect(answerFor(stored, null)).toBeNull();
    expect(answerFor(undefined, '2025-12-29')).toBeNull();
  });
});

describe('a confirmed recurring payment counts in the year it belongs to', () => {
  const year = (y: number, f: ReceiptFacts) => computeYear({ year: y, items: resolveItems(f, [], SMALL_BUSINESS).map((r) => r.item) }, rulesForYear(y)).businessExpenseCents;

  it('January rent paid on 29 December: without an answer in the old year, confirmed in the new one, never in both', () => {
    const unanswered = facts(rent(), { decision: BUSINESS });
    expect([year(2025, unanswered), year(2026, unanswered)]).toEqual([65_000, 0]);
    const confirmed = { ...unanswered, countsOnDay: boundaryDay('2025-12-29') };
    expect([year(2025, confirmed), year(2026, confirmed)]).toEqual([0, 65_000]);
    expect(resolveItem(confirmed, [], SMALL_BUSINESS).item).toMatchObject({ date: '2026-01-01', dateBasis: 'year_boundary', amountCents: 65_000 });
  });

  it('with a linked payment the payment day is what is moved, and the amount paid stays', () => {
    const paid = facts(rent({ date: '2025-12-15' }), { decision: BUSINESS, paid: { day: '2026-01-05', cents: 64_900 }, countsOnDay: boundaryDay('2026-01-05') });
    expect(resolveItem(paid, [], SMALL_BUSINESS).item).toMatchObject({ date: '2025-12-31', dateBasis: 'year_boundary', amountCents: 64_900, amountBasis: 'payment' });
    expect([year(2025, paid), year(2026, paid)]).toEqual([64_900, 0]);
  });

  it('the section 19 status stays the one of the day it was paid', () => {
    const settings = { ...SMALL_BUSINESS, statusChanges: [{ effectiveFrom: '2026-01-01', smallBusiness: false }] };
    const confirmed = facts(rent(), { decision: BUSINESS, countsOnDay: '2026-01-01' });
    expect(resolveItem(confirmed, [], settings).item.smallBusiness).toBe(true);
  });

  it('under regular taxation the input tax stays in the advance return period of the day it was paid', () => {
    // 595.00 with 95.00 of tax, paid on 29 December 2025, confirmed as belonging to 2026.
    const confirmed = facts(rent({ gross: 595, net: 500 }), { decision: BUSINESS, countsOnDay: '2026-01-01' });
    const items = resolveItems(confirmed, [], REGULAR_BUSINESS).map((r) => r.item);
    const old = computeYear({ year: 2025, items }, rulesForYear(2025));
    const next = computeYear({ year: 2026, items }, rulesForYear(2026));
    // Income tax: the whole payment, net and tax, is an expense of 2026.
    expect(old.businessExpenseCents).toBe(0);
    expect(old.items).toEqual([]);
    expect(next.lines.map((l) => [l.key, l.cents])).toEqual([['euer.rent_business_premises', 50_000], ['euer.input_vat', 9_500]]);
    // Value-added tax: the 95.00 belong to the advance return of December 2025, and to no period of 2026.
    expect(old.inputVatEvents).toEqual([{ date: '2025-12-29', cents: 9_500, source: 'item', id: 'r-1' }]);
    expect(next.inputVatEvents).toEqual([]);
  });

  it('a meal is never moved: the meal register lists it by its own day', () => {
    const dinner = facts(meal({ date: '2025-12-29' }), { countsOnDay: '2026-01-01' });
    expect(resolveItem(dinner, [], SMALL_BUSINESS).item).toMatchObject({ date: '2025-12-29', dateBasis: 'document' });
  });
});
