import { describe, expect, it } from 'vitest';
import { REGULAR_BUSINESS, SMALL_BUSINESS, meal } from '@/lib/meals/__tests__/fixtures';
import type { MealRecord } from '@/lib/meals/types';
import { computeYear } from '../compute';
import { cashDayOf, resolveItem, resolveItems, withFiledHold, type ReceiptFacts } from '../facts';
import { rulesForYear } from '../rules';
import { answerFor, berlinDay, boundaryDay, decideBoundary, filedHoldOf, filedWithOf, otherYearOf, recursMonthly, touchesYear, vatStatusDay, vatStatusOn, type BoundaryFacts } from '../year-boundary';

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

describe('recurring counterparties', () => {
  it('needs three distinct months among the twelve before the payment month', () => {
    expect(recursMonthly('2025-12-26', ['2025-09-26', '2025-10-26', '2025-11-26'])).toBe(true);
    expect(recursMonthly('2025-12-26', ['2025-10-26', '2025-11-26'])).toBe(false);
    // Twelve months back is the earliest that counts; thirteen is too long ago.
    expect(recursMonthly('2026-01-04', ['2025-01-04', '2025-06-04', '2025-12-04'])).toBe(true);
    expect(recursMonthly('2026-01-04', ['2024-12-04', '2025-06-04', '2025-12-04'])).toBe(false);
  });

  it('does not let the payment month, a later day or a second receipt of one month vouch for it', () => {
    expect(recursMonthly('2025-12-26', ['2025-12-01', '2025-12-26', '2025-11-02', '2025-11-20'])).toBe(false);
    expect(recursMonthly('2025-12-26', ['2026-01-26', '2026-02-26', '2025-11-26'])).toBe(false);
    expect(recursMonthly('2025-12-26', ['', 'kein Datum', '2025-11-26', '2025-10-26', '2025-09-26'])).toBe(true);
  });
});

describe('berlinDay', () => {
  it('is the day in Berlin, also late in the evening UTC', () => {
    expect(berlinDay(new Date('2026-10-17T21:30:00Z'))).toBe('2026-10-17');
    expect(berlinDay(new Date('2026-10-17T22:30:00Z'))).toBe('2026-10-18');
  });
});

describe('the answer that applies to a payment at the turn of the year', () => {
  const none = new Map<number, string>();
  const filed2025 = new Map([[2025, '2026-10-17']]);
  const decide = (o: Partial<BoundaryFacts>) => decideBoundary({ kind: 'receipt', cashDay: '2025-12-26', stored: undefined, filedOn: none, recurring: false, ...o });
  const stored = (belongsToOtherYear: boolean, savedOn: string, cashDay = '2025-12-26') => ({ cashDay, belongsToOtherYear, savedOn });

  it('open years: a recurring receipt and a one-off stay by rule, one without a vendor stays undecided', () => {
    expect(decide({ recurring: true })).toEqual({ answer: false, source: 'rule', reason: 'Abo, Zeitraum beginnt am Zahltag', storedAnswer: null, filedYear: null, filedWith: null, departsFromFiled: null });
    expect(decide({ recurring: false })).toMatchObject({ answer: false, source: 'rule', reason: 'einmalige Zahlung' });
    expect(decide({ recurring: null })).toMatchObject({ answer: null, source: null, storedAnswer: null });
  });

  it('open years, regular taxation with advance returns: value-added tax paid in January belongs to the year before, paid in December it stays', () => {
    const vat = { kind: 'vat_settlement' as const, recurring: null, vatStatus: 'regular' as const };
    expect(decide({ ...vat, cashDay: '2026-01-10' })).toMatchObject({ answer: true, source: 'rule' });
    expect(decide({ ...vat, cashDay: '2026-01-01' })).toMatchObject({ answer: true, source: 'rule' });
    expect(decide({ ...vat, cashDay: '2025-12-22' })).toMatchObject({ answer: false, source: 'rule' });
  });

  it('open years, small business: a payment to the tax office is not recurring and stays; an unanswered status leaves it undecided', () => {
    expect(decide({ kind: 'vat_settlement', cashDay: '2026-01-08', vatStatus: 'small' })).toMatchObject({ answer: false, source: 'rule', reason: 'Kleinunternehmer: keine regelmäßige Vorauszahlung' });
    expect(decide({ kind: 'vat_settlement', cashDay: '2025-12-23', vatStatus: 'small' })).toMatchObject({ answer: false, source: 'rule' });
    expect(decide({ kind: 'vat_settlement', cashDay: '2026-01-08', vatStatus: 'status_unanswered' })).toMatchObject({ answer: null, source: null });
    expect(decide({ kind: 'vat_settlement', cashDay: '2026-01-08', vatStatus: 'frequency_unanswered' })).toMatchObject({ answer: null, source: null });
    // A person can still answer it.
    expect(decide({ kind: 'vat_settlement', cashDay: '2026-01-08', vatStatus: 'small', stored: stored(true, '2026-01-09', '2026-01-08') })).toMatchObject({ answer: true, source: 'person' });
  });

  it('the day whose status decides a settlement: the year before for January, the payment day for December', () => {
    expect(vatStatusDay('2026-01-08')).toBe('2025-12-31');
    expect(vatStatusDay('2025-12-23')).toBe('2025-12-23');
  });

  it('the filed return an answer went into', () => {
    const both = new Map([[2024, '2026-10-11'], [2025, '2026-10-17']]);
    expect(filedWithOf('2025-12-29', '2026-10-01', new Map())).toBeNull();
    expect(filedWithOf('2025-12-29', '2026-10-17', both)).toBe(2025);
    expect(filedWithOf('2025-12-29', '2026-10-18', both)).toBeNull();
    // A January 2025 payment touches 2024 and 2025: saved between the two filing days it went into neither.
    expect(filedWithOf('2025-01-04', '2026-10-14', both)).toBeNull();
    expect(filedWithOf('2025-01-04', '2026-10-10', both)).toBe(2025);
  });

  it('the status a settlement is judged by', () => {
    expect(vatStatusOn(false, true)).toBe('regular');
    expect(vatStatusOn(false, false)).toBe('frequency_unanswered');
    expect(vatStatusOn(true, true)).toBe('small');
    expect(vatStatusOn(true, false)).toBe('small');
    expect(vatStatusOn(null, true)).toBe('status_unanswered');
  });

  it("a person's answer overrides every rule, and only for the day it was given for", () => {
    expect(decide({ recurring: true, stored: stored(true, '2026-01-05') })).toMatchObject({ answer: true, source: 'person', reason: 'Antwort von Hand', storedAnswer: true });
    expect(decide({ kind: 'vat_settlement', cashDay: '2026-01-08', stored: stored(false, '2026-01-09', '2026-01-08') })).toMatchObject({ answer: false, source: 'person' });
    // Another payment day: the answer does not apply, the rule does.
    expect(decide({ recurring: true, stored: stored(true, '2026-01-05', '2025-12-27') })).toMatchObject({ answer: false, source: 'rule', storedAnswer: null });
  });

  it('a filed year fixes its turn, whichever of the two years is filed, before any rule', () => {
    expect(decide({ filedOn: filed2025 })).toEqual({ answer: false, source: 'filed', reason: 'Festgelegt durch die abgegebene Erklärung 2025', storedAnswer: null, filedYear: 2025, filedWith: null, departsFromFiled: null });
    // Paid in January 2026, other year 2025 filed: the January rule for value-added tax does not apply.
    expect(decide({ kind: 'vat_settlement', cashDay: '2026-01-08', filedOn: filed2025 })).toMatchObject({ answer: false, source: 'filed', filedYear: 2025 });
    expect(decide({ recurring: null, filedOn: filed2025 })).toMatchObject({ answer: false, source: 'filed' });
    // Both years filed: the paid year is named.
    expect(decide({ cashDay: '2026-01-03', filedOn: new Map([[2025, '2026-10-17'], [2026, '2027-05-02']]) })).toMatchObject({ reason: 'Festgelegt durch die abgegebene Erklärung 2026', filedYear: 2026 });
  });

  it('an answer saved up to the filing day was filed that way and applies; one saved later that would move the payment is reported, never applied', () => {
    expect(decide({ filedOn: filed2025, stored: stored(true, '2026-10-16') })).toMatchObject({ answer: true, source: 'person', storedAnswer: true, filedWith: 2025, departsFromFiled: null, reason: 'Antwort von Hand, vor der Abgabe der Erklärung 2025 gegeben und so erklärt' });
    expect(decide({ filedOn: filed2025, stored: stored(true, '2026-10-17') })).toMatchObject({ answer: true, source: 'person' });
    expect(decide({ filedOn: filed2025, stored: stored(true, '2026-10-18') })).toEqual({ answer: false, source: 'filed', reason: 'Weicht von der abgegebenen Erklärung 2025 ab', storedAnswer: true, filedYear: 2025, filedWith: null, departsFromFiled: 2025 });
    // "Stays" after the filing day agrees with the return.
    expect(decide({ filedOn: filed2025, stored: stored(false, '2026-10-18') })).toMatchObject({ answer: false, source: 'person', filedWith: null, departsFromFiled: null });
    // Both years filed, saved between the two filing days: it departs from the return it was saved after.
    const both = new Map([[2025, '2026-10-17'], [2026, '2027-05-02']]);
    expect(decide({ cashDay: '2026-01-03', filedOn: both, stored: stored(true, '2026-11-01', '2026-01-03') })).toMatchObject({ answer: false, departsFromFiled: 2025 });
  });
});

describe('a filed year holds a receipt against payment links made after its filing day', () => {
  // Invented, shaped like the defect of 2026-11-05: a phone bill of 16 December paid by direct debit on 2 January.
  const DOC = '2024-12-16';
  const DEBIT = { day: '2025-01-02', linkedOn: '2026-11-01' };
  const filed = new Map([
    [2024, '2026-10-11'],
    [2025, '2026-10-17'],
  ]);

  it('a link made before the filing day moves the receipt, as it always did', () => {
    expect(filedHoldOf(DOC, [{ ...DEBIT, linkedOn: '2026-10-10' }], filed)).toBeNull();
    // On the filing day itself the link counts as filed with it, as an answer saved that day does.
    expect(filedHoldOf(DOC, [{ ...DEBIT, linkedOn: '2026-10-11' }], new Map([[2024, '2026-10-11']]))).toBeNull();
  });

  it('a link made after the filing day does not move the receipt out of the filed year', () => {
    expect(filedHoldOf(DOC, [DEBIT], filed)).toEqual({ day: DOC, filedYear: 2024 });
    // Only the year the receipt leaves is filed: still held.
    expect(filedHoldOf(DOC, [DEBIT], new Map([[2024, '2026-10-11']]))).toEqual({ day: DOC, filedYear: 2024 });
  });

  it('nor into a filed year: a receipt of an open year linked late to a payment of a filed year stays', () => {
    // A receipt of 3 January 2025 paid in advance on 20 December 2024; 2024 filed, 2025 open.
    expect(filedHoldOf('2025-01-03', [{ day: '2024-12-20', linkedOn: '2026-11-01' }], new Map([[2024, '2026-10-11']]))).toEqual({ day: '2025-01-03', filedYear: 2024 });
  });

  it('keeps the day the return saw: an earlier link stays, a later one with an earlier day does not count', () => {
    const links = [
      { day: '2024-12-30', linkedOn: '2026-10-01' },
      { day: '2025-01-02', linkedOn: '2026-11-01' },
    ];
    // The late link pays later: the first payment is unchanged, nothing to hold.
    expect(filedHoldOf(DOC, links, filed)).toBeNull();
    const earlier = [
      { day: '2025-01-05', linkedOn: '2026-10-01' },
      { day: '2024-12-28', linkedOn: '2026-11-01' },
    ];
    // Filed in 2025 by the first link; the late one would pull it back into 2024.
    expect(filedHoldOf(DOC, earlier, filed)).toEqual({ day: '2025-01-05', filedYear: 2024 });
  });

  it('an open year moves as it always did, and a link inside one year holds nothing', () => {
    expect(filedHoldOf(DOC, [DEBIT], new Map())).toBeNull();
    expect(filedHoldOf(DOC, [DEBIT], new Map([[2023, '2026-10-11']]))).toBeNull();
    expect(filedHoldOf('2024-11-03', [{ day: '2024-11-20', linkedOn: '2026-11-01' }], filed)).toBeNull();
    expect(filedHoldOf(DOC, [], filed)).toBeNull();
  });

  it('the statement counts a held receipt on its filed day with what was paid, and says so', () => {
    const phone = rent({ rowId: 'p', name: 'Telefon Dezember', vendor: 'Netzwerk Nord', category: 'Telefon', gross: 39.95, date: DOC });
    const linked = facts(phone, { decision: BUSINESS, paid: { day: DEBIT.day, cents: 3_995 }, outDays: [DEBIT] });
    expect(cashDayOf(linked)).toBe(DEBIT.day);
    const held = withFiledHold(linked, filed);
    expect(held.filedHold).toEqual({ day: DOC, filedYear: 2024 });
    expect(cashDayOf(held)).toBe(DOC);
    expect(resolveItem(held, [], SMALL_BUSINESS).item).toMatchObject({ date: DOC, dateBasis: 'filed', paidOn: DEBIT.day, filedYear: 2024, amountCents: 3_995 });
    // An open year: the link applies and nothing is held.
    const open = withFiledHold(linked, new Map());
    expect(open).toBe(linked);
    expect(resolveItem(open, [], SMALL_BUSINESS).item).toMatchObject({ date: DEBIT.day, dateBasis: 'payment' });
  });

  it('a credit note is held by its money back', () => {
    const credit = rent({ rowId: 'c', gross: -20, date: DOC });
    const linked = facts(credit, { decision: BUSINESS, moneyBack: { day: DEBIT.day, cents: 2_000 }, backDays: [DEBIT] });
    expect(withFiledHold(linked, filed).filedHold).toEqual({ day: DOC, filedYear: 2024 });
    // Money out linked to a credit note sets no day of it, so it holds nothing.
    expect(withFiledHold(facts(credit, { moneyOutCents: 500, outDays: [DEBIT] }), filed).filedHold).toBeUndefined();
  });

  it("a person's answer at the turn of the year is decided as before, and the hold reads the year it gave", () => {
    const filed2025 = new Map([[2025, '2026-10-17']]);
    // Paid 30 December 2025, answered "belongs to 2026" before the filing day: the 2025 return left it out.
    const answer = { cashDay: '2025-12-30', belongsToOtherYear: true, savedOn: '2026-10-01' };
    const first = { day: '2025-12-30', linkedOn: '2026-10-01' };
    // A second payment linked after filing that pays later changes no day: nothing is held, the answer applies as before.
    expect(filedHoldOf('2025-12-15', [first, { day: '2026-01-03', linkedOn: '2026-11-01' }], filed2025, answer)).toBeNull();
    // A late link to an earlier payment of 20 December would pull it into the filed 2025: held on the answered day.
    const pulled = [first, { day: '2025-12-20', linkedOn: '2026-11-01' }];
    expect(filedHoldOf('2025-12-15', pulled, filed2025, answer)).toEqual({ day: '2025-12-30', filedYear: 2025 });
    // Without the answer both days are 2025: nothing crosses (a meal or an asset is judged so).
    expect(filedHoldOf('2025-12-15', pulled, filed2025)).toBeNull();
    // The held day keeps the answer applying, decided exactly as before.
    const held = withFiledHold(facts(rent({ date: '2025-12-15' }), { decision: BUSINESS, paid: { day: '2025-12-20', cents: 65_000 }, outDays: pulled }), filed2025, answer);
    expect(cashDayOf(held)).toBe('2025-12-30');
    expect(decideBoundary({ kind: 'receipt', cashDay: '2025-12-30', stored: answer, filedOn: filed2025, recurring: true })).toMatchObject({ answer: true, source: 'person', filedWith: 2025 });
    // An answer saved after the filing day is not part of the return: the hold does not follow it.
    expect(filedHoldOf('2025-12-15', pulled, filed2025, { ...answer, savedOn: '2026-10-20' })).toBeNull();
  });
});
