import { describe, expect, it } from 'vitest';
import { REGULAR_BUSINESS, SMALL_BUSINESS, UNANSWERED, meal } from '@/lib/meals/__tests__/fixtures';
import type { MealRecord } from '@/lib/meals/types';
import { computeYear } from '../compute';
import type { TreatmentInput, VendorRule } from '../decisions';
import { legacyAllocations } from '../defaults';
import { resolveItem, type ReceiptFacts } from '../facts';
import { rulesForYear } from '../rules';
import { vatYear } from '../vat';

/** An ordinary receipt (not a meal) as the meal module's mapper hands it over. */
function receipt(overrides: Partial<MealRecord> = {}): MealRecord {
  return meal({
    rowId: 'r-1',
    name: 'Rechnung 4711',
    vendor: 'Netzwerk Nord GmbH',
    category: 'Telefon & Internet',
    mealType: null,
    gross: 39.99,
    occasion: '',
    place: '',
    host: '',
    tip: null,
    guests: [],
    ...overrides,
  });
}

const facts = (record: MealRecord, extra: Partial<ReceiptFacts> = {}): ReceiptFacts => ({
  record,
  businessSharePercent: null,
  decision: null,
  ...extra,
});

const RULE: VendorRule = {
  id: 'rule-1',
  vendorKey: 'netzwerk nord',
  vendorLabel: 'Netzwerk Nord GmbH',
  effectiveFrom: '',
  allocations: [{ purpose: 'business', shareBp: 5000 }, { purpose: 'study', shareBp: 3000 }],
  formLineKey: 'euer.telecom',
  employmentLineKey: 'employment.study_costs',
};

const DECISION: TreatmentInput = {
  allocations: [{ purpose: 'business', shareBp: 10000 }],
  formLineKey: 'euer.work_equipment',
  employmentLineKey: null,
};

describe('resolveItem: where a treatment comes from', () => {
  it('falls back to the older columns and the category default', () => {
    const r = resolveItem(facts(receipt(), { businessSharePercent: 50 }), [], SMALL_BUSINESS);
    expect(r.item.allocations).toEqual([{ purpose: 'business', shareBp: 5000 }]);
    expect(r.item.formLineKey).toBe('euer.telecom');
    expect(r).toMatchObject({ allocationOrigin: 'legacy_columns', formLineOrigin: 'category_default', vendorKey: 'netzwerk nord' });
  });

  it('a vendor rule beats the older columns', () => {
    const r = resolveItem(facts(receipt(), { businessSharePercent: 100 }), [RULE], SMALL_BUSINESS);
    expect(r.item.allocations).toEqual(RULE.allocations);
    expect(r.item.employmentLineKey).toBe('employment.study_costs');
    expect(r).toMatchObject({ allocationOrigin: 'vendor_rule', vendorRuleId: 'rule-1' });
  });

  it('a decision on the item beats the vendor rule, and removing it restores the rule', () => {
    const decided = resolveItem(facts(receipt(), { decision: DECISION }), [RULE], SMALL_BUSINESS);
    expect(decided.item.formLineKey).toBe('euer.work_equipment');
    expect(decided).toMatchObject({ allocationOrigin: 'item', vendorRuleId: 'rule-1' });
    const restored = resolveItem(facts(receipt()), [RULE], SMALL_BUSINESS);
    expect(restored.item.allocations).toEqual(RULE.allocations);
  });

  it('a rule from a later date leaves earlier receipts alone', () => {
    const later = { ...RULE, effectiveFrom: '2025-07-01' };
    const before = resolveItem(facts(receipt({ date: '2025-03-14' })), [later], SMALL_BUSINESS);
    const after = resolveItem(facts(receipt({ date: '2025-07-02' })), [later], SMALL_BUSINESS);
    expect(before.allocationOrigin).toBe('legacy_columns');
    expect(after.allocationOrigin).toBe('vendor_rule');
  });

  it('nobody decided: no allocation, an open check', () => {
    const r = resolveItem(facts(receipt({ zuordnung: null })), [], SMALL_BUSINESS);
    expect(r.item.allocations).toBeNull();
    expect(r.allocationOrigin).toBeNull();
    const result = computeYear({ year: 2025, items: [r.item] }, rulesForYear(2025));
    expect(result.checks.map((c) => c.kind)).toEqual(['no_allocation']);
  });

  it('a university receipt goes to the study line of the employment annex', () => {
    const r = resolveItem(facts(receipt({ zuordnung: 'Universität', category: 'Fachliteratur' })), [], SMALL_BUSINESS);
    expect(r.item.allocations).toEqual([{ purpose: 'study', shareBp: 10000 }]);
    expect(r.item.employmentLineKey).toBe('employment.study_costs');
  });

  it('a category without a default asks for a line', () => {
    const r = resolveItem(facts(receipt({ category: null })), [], SMALL_BUSINESS);
    expect(r.item.formLineKey).toBeNull();
    const result = computeYear({ year: 2025, items: [r.item] }, rulesForYear(2025));
    expect(result.checks.map((c) => c.kind)).toEqual(['no_form_line']);
  });
});

describe('resolveItem: amounts', () => {
  it('converts a foreign-currency receipt at the reference rate and marks it as an estimate', () => {
    const r = resolveItem(facts(receipt({ currency: 'USD', gross: 100, fxRate: 0.8437 })), [], SMALL_BUSINESS);
    expect(r.item).toMatchObject({ amountCents: 8437, amountBasis: 'reference_rate' });
  });

  it('never invents an amount without a rate or a total', () => {
    const noRate = resolveItem(facts(receipt({ currency: 'USD', gross: 100, fxRate: null })), [], SMALL_BUSINESS);
    expect(noRate.item).toMatchObject({ amountCents: null, missingAmount: 'no_exchange_rate' });
    const noTotal = resolveItem(facts(receipt({ gross: null })), [], SMALL_BUSINESS);
    expect(noTotal.item).toMatchObject({ amountCents: null, missingAmount: 'no_amount' });
  });

  it('reads the net amount of a credit note: negative like its total', () => {
    const credit = resolveItem(facts(receipt({ gross: -119, net: -100 })), [], REGULAR_BUSINESS);
    expect(credit.item).toMatchObject({ amountCents: -11_900, netCents: -10_000 });
    const usd = resolveItem(facts(receipt({ currency: 'USD', gross: -119, net: -100, fxRate: 0.9 })), [], REGULAR_BUSINESS);
    expect(usd.item).toMatchObject({ amountCents: -10_710, netCents: -9_000 });
  });

  it('a net amount that does not fit its total is no net amount, for an invoice and a credit note alike', () => {
    const net = (gross: number, n: number) => resolveItem(facts(receipt({ gross, net: n })), [], REGULAR_BUSINESS).item.netCents;
    expect(net(119, 100)).toBe(10_000);
    expect(net(119, 120)).toBeNull();
    expect(net(-119, -120)).toBeNull();
    // Opposite signs, and a zero net beside a total.
    expect(net(-119, 100)).toBeNull();
    expect(net(119, -100)).toBeNull();
    expect(net(119, 0)).toBeNull();
    // A credit note without tax: net equals the total.
    expect(net(-50, -50)).toBe(-5_000);
  });

  it('a refund linked to a credit note does not reduce it further', () => {
    const credit = resolveItem(facts(receipt({ gross: -119, net: -100 }), { refundedCents: 11_900 }), [], REGULAR_BUSINESS);
    expect(credit.item).toMatchObject({ amountCents: -11_900, netCents: -10_000 });
  });

  it('a credit note paid back counts on the day the money came back, with that amount', () => {
    // As linked payments arrive for it: money back, no money out.
    const credit = resolveItem(
      facts(receipt({ gross: -119, net: -100, date: '2025-12-20' }), { paid: null, refundedCents: 11_900, moneyBack: { day: '2026-01-08', cents: 11_900 }, moneyOutCents: 0 }),
      [],
      REGULAR_BUSINESS,
    );
    expect(credit.item).toMatchObject({ date: '2026-01-08', dateBasis: 'payment', amountCents: -11_900, netCents: -10_000, amountBasis: 'payment' });
  });

  it('a credit note with money out linked to it is a question, never an expense', () => {
    // As linked payments arrive for an offset: money out, so `paid` is positive.
    const credit = resolveItem(
      facts(receipt({ gross: -119, net: -100, date: '2026-03-01' }), { paid: { day: '2026-03-05', cents: 5_000 }, refundedCents: 0, moneyBack: null, moneyOutCents: 5_000 }),
      [],
      REGULAR_BUSINESS,
    );
    expect(credit.item).toMatchObject({ amountCents: -11_900, creditNotePaymentOut: true, dateBasis: 'document' });
    const result = computeYear({ year: 2026, items: [{ ...credit.item, allocations: [{ purpose: 'business', shareBp: 10000 }], formLineKey: 'euer.telecom' }] }, rulesForYear(2026));
    expect(result.checks.map((c) => c.kind)).toEqual(['credit_note_payment_out']);
    expect(result.businessExpenseCents).toBe(0);
  });

  it('rounds a foreign-currency credit note exactly like its invoice, half away from zero', () => {
    const invoice = resolveItem(facts(receipt({ currency: 'USD', gross: 45.25, net: 45.25, fxRate: 0.1 })), [], REGULAR_BUSINESS).item;
    const credit = resolveItem(facts(receipt({ currency: 'USD', gross: -45.25, net: -45.25, fxRate: 0.1 })), [], REGULAR_BUSINESS).item;
    // 4,525 cents times 0.1 is 452.5.
    expect(invoice.amountCents).toBe(453);
    expect(credit.amountCents).toBe(-453);
    expect(credit.netCents).toBe(-453);
  });

  it('a credit note in another currency without a rate is still a credit note', () => {
    const usd = (extra: Partial<ReceiptFacts>) =>
      resolveItem(facts(receipt({ currency: 'USD', gross: -119, net: -100, fxRate: null, date: '2026-03-01' }), extra), [], REGULAR_BUSINESS).item;
    // Settled by the euro money back: it counts with that amount and its net in proportion.
    expect(usd({ moneyBack: { day: '2026-03-10', cents: 10_710 }, moneyOutCents: 0 })).toMatchObject({ amountCents: -10_710, netCents: -9_000, date: '2026-03-10' });
    // Money out linked to it is a question, never an expense.
    const out = usd({ paid: { day: '2026-03-05', cents: 10_710 }, moneyBack: null, moneyOutCents: 10_710 });
    expect(out).toMatchObject({ amountCents: null, creditNotePaymentOut: true });
    const result = computeYear({ year: 2026, items: [{ ...out, allocations: [{ purpose: 'business', shareBp: 10000 }], formLineKey: 'euer.telecom' }] }, rulesForYear(2026));
    expect(result.checks.map((c) => c.kind)).toContain('credit_note_payment_out');
    expect(result.businessExpenseCents).toBe(0);
  });

  it('a linked payment whose euro amount is itself an estimate gives the day, not the amount (plan 2026-10-23)', () => {
    const usd = (extra: Partial<ReceiptFacts>, fxRate: number | null = 0.9) =>
      resolveItem(facts(receipt({ currency: 'USD', gross: 10, net: 10, fxRate, date: '2026-10-01' }), extra), [], REGULAR_BUSINESS).item;
    // A real euro amount settles the receipt: what was charged, on the payment's day.
    expect(usd({ paid: { day: '2026-10-06', cents: 948 }, moneyOutCents: 948 })).toMatchObject({ amountCents: 948, amountBasis: 'payment', date: '2026-10-06' });
    // An estimate does not: the receipt keeps its own estimate, the day is the payment's.
    expect(usd({ paid: { day: '2026-10-06', cents: 912, estimated: true }, moneyOutCents: 912 })).toMatchObject({ amountCents: 900, amountBasis: 'reference_rate', date: '2026-10-06' });
    // Without a rate of its own, the payment's estimate is the best there is, and stays an estimate.
    expect(usd({ paid: { day: '2026-10-06', cents: 912, estimated: true }, moneyOutCents: 912 }, null)).toMatchObject({ amountCents: 912, amountBasis: 'reference_rate' });
    // A euro receipt paid by an estimated payment keeps its own amount.
    const eur = resolveItem(facts(receipt({ gross: 9.5, net: 9.5, date: '2026-10-01' }), { paid: { day: '2026-10-06', cents: 912, estimated: true }, moneyOutCents: 912 }), [], REGULAR_BUSINESS).item;
    expect(eur).toMatchObject({ amountCents: 950, amountBasis: 'document', date: '2026-10-06' });
  });

  it('a net amount of the other sign is reported as not fitting, not as missing', () => {
    const r = resolveItem(facts(receipt({ gross: -119, net: 100, date: '2025-03-01' })), [], REGULAR_BUSINESS).item;
    expect(r).toMatchObject({ netCents: null, netDoesNotFit: true });
    const result = computeYear({ year: 2025, items: [{ ...r, allocations: [{ purpose: 'business', shareBp: 10000 }], formLineKey: 'euer.telecom' }] }, rulesForYear(2025));
    expect(result.checks.map((c) => c.kind)).toContain('net_does_not_fit');
    expect(result.checks.map((c) => c.kind)).not.toContain('net_amount_missing');
  });

  it('carries the section 19 answer onto the item', () => {
    expect(resolveItem(facts(receipt()), [], UNANSWERED).item.smallBusiness).toBeNull();
    expect(resolveItem(facts(receipt()), [], REGULAR_BUSINESS).item.smallBusiness).toBe(false);
  });
});

describe('a credit note in the statement, under both statuses', () => {
  // A credit note of 119.00 (100.00 net, 19.00 tax) against a telecom invoice of 238.00 (200.00 net).
  const year = (settings: typeof REGULAR_BUSINESS, share = 10000) => {
    const decision: TreatmentInput = { allocations: [{ purpose: 'business', shareBp: share }], formLineKey: 'euer.telecom', employmentLineKey: null };
    const invoice = resolveItem(facts(receipt({ rowId: 'inv', gross: 238, net: 200, date: '2025-03-10' }), { decision }), [], settings).item;
    const credit = resolveItem(facts(receipt({ rowId: 'cn', gross: -119, net: -100, date: '2025-04-02' }), { decision }), [], settings).item;
    return computeYear({ year: 2025, items: [invoice, credit] }, rulesForYear(2025));
  };
  const line = (result: ReturnType<typeof year>, key: string) => result.lines.find((l) => l.key === key)?.cents ?? 0;

  it('regular taxation: the credit note reduces the expense by its net amount and the input tax by its tax', () => {
    const result = year(REGULAR_BUSINESS);
    expect(result.checks).toEqual([]);
    expect(line(result, 'euer.telecom')).toBe(20_000 - 10_000);
    expect(line(result, 'euer.input_vat')).toBe(3_800 - 1_900);
    const periods = vatYear(2025, 'quarterly', 'issued', { inputVat: result.inputVatEvents, outputVatByIssue: [], outputVatByPayment: [] });
    // The invoice in the first quarter, the credit note in the second.
    expect(periods.periods.map((p) => p.inputVatCents)).toEqual([3_800, -1_900, 0, 0]);
  });

  it('regular taxation at a business share: both reductions at that share', () => {
    const result = year(REGULAR_BUSINESS, 5000);
    expect(line(result, 'euer.telecom')).toBe(10_000 - 5_000);
    expect(line(result, 'euer.input_vat')).toBe(1_900 - 950);
  });

  it('the private share of a credit note is negative, so its parts add up to its amount', () => {
    const result = year(SMALL_BUSINESS, 5000);
    const credit = result.items.find((i) => i.itemId === 'cn');
    expect(credit?.parts.map((p) => p.cents)).toEqual([-5_950]);
    expect(credit?.privateCents).toBe(-5_950);
  });

  it('refunded in the next year: the expense and the input tax are reduced in the year and the period of the money back', () => {
    const decision: TreatmentInput = { allocations: [{ purpose: 'business', shareBp: 10000 }], formLineKey: 'euer.telecom', employmentLineKey: null };
    const credit = resolveItem(
      facts(receipt({ rowId: 'cn', gross: -119, net: -100, date: '2025-12-20' }), { decision, moneyBack: { day: '2026-01-08', cents: 11_900 }, moneyOutCents: 0 }),
      [],
      REGULAR_BUSINESS,
    ).item;
    const in2025 = computeYear({ year: 2025, items: [credit] }, rulesForYear(2025));
    const in2026 = computeYear({ year: 2026, items: [credit] }, rulesForYear(2026));
    expect(in2025.businessExpenseCents).toBe(0);
    expect(in2026.lines.find((l) => l.key === 'euer.telecom')?.cents).toBe(-10_000);
    const periods = vatYear(2026, 'quarterly', 'issued', { inputVat: in2026.inputVatEvents, outputVatByIssue: [], outputVatByPayment: [] });
    expect(periods.periods[0].inputVatCents).toBe(-1_900);
  });

  it('a credit note on the meal line is its own question; the meal register holds no credit notes', () => {
    const decision: TreatmentInput = { allocations: [{ purpose: 'business', shareBp: 10000 }], formLineKey: 'euer.meals', employmentLineKey: null };
    const credit = resolveItem(facts(meal({ rowId: 'cm', gross: -40, date: '2025-05-02' }), { decision }), [], SMALL_BUSINESS);
    expect(credit.isMeal).toBe(false);
    const result = computeYear({ year: 2025, items: [credit.item] }, rulesForYear(2025));
    expect(result.checks.map((c) => c.kind)).toEqual(['credit_note_on_meal_line']);
  });

  it('a credit note in the year after a status change asks which status the purchase had', () => {
    const changed = { ...REGULAR_BUSINESS, statusChanges: [{ effectiveFrom: '2025-07-01', smallBusiness: false }], smallBusiness: true };
    const credit = resolveItem(facts(receipt({ rowId: 'cn', gross: -119, net: -100, date: '2025-09-01' }), { decision: { allocations: [{ purpose: 'business', shareBp: 10000 }], formLineKey: 'euer.telecom', employmentLineKey: null } }), [], changed).item;
    expect(credit.creditNoteStatusChanged).toBe(true);
    const result = computeYear({ year: 2025, items: [credit] }, rulesForYear(2025));
    expect(result.checks).toEqual([{ itemId: 'cn', kind: 'credit_note_status_review', blocking: false }]);
    expect(result.lines.find((l) => l.key === 'euer.input_vat')?.cents).toBe(-1_900);
    // A change and a change back within the year are caught too.
    const back = { ...REGULAR_BUSINESS, smallBusiness: true, statusChanges: [{ effectiveFrom: '2025-02-01', smallBusiness: false }, { effectiveFrom: '2025-06-01', smallBusiness: true }] };
    expect(resolveItem(facts(receipt({ rowId: 'cn2', gross: -119, net: -100, date: '2025-09-01' })), [], back).item.creditNoteStatusChanged).toBe(true);
    // A change more than a year back asks nothing.
    const long = { ...REGULAR_BUSINESS, smallBusiness: true, statusChanges: [{ effectiveFrom: '2024-01-01', smallBusiness: false }] };
    expect(resolveItem(facts(receipt({ rowId: 'cn3', gross: -119, net: -100, date: '2025-09-01' })), [], long).item.creditNoteStatusChanged).toBeUndefined();
    // An invoice in the same situation asks nothing.
    const invoice = resolveItem(facts(receipt({ rowId: 'inv', gross: 119, net: 100, date: '2025-09-01' })), [], changed).item;
    expect(invoice.creditNoteStatusChanged).toBeUndefined();
  });

  it('small business: the credit note reduces the expense by its whole amount, and there is no input tax', () => {
    const result = year(SMALL_BUSINESS);
    expect(line(result, 'euer.telecom')).toBe(23_800 - 11_900);
    expect(line(result, 'euer.input_vat')).toBe(0);
    expect(result.inputVatEvents).toEqual([]);
  });
});

describe('resolveItem: business meals follow the register', () => {
  const run = (record: MealRecord, settings = SMALL_BUSINESS) => {
    const r = resolveItem(facts(record), [], settings);
    return { r, result: computeYear({ year: 2025, items: [r.item] }, rulesForYear(2025)) };
  };

  it('a complete meal contributes exactly the register figure', () => {
    // 119.00 plus 11.00 tip, gross basis: 91.00 deductible, 39.00 not.
    const { r, result } = run(meal());
    expect(r.isMeal).toBe(true);
    expect(result.lines[0]).toMatchObject({ key: 'euer.meals', cents: 9100, nonDeductibleCents: 3900 });
  });

  it('a vendor rule or decision cannot change what a meal is worth', () => {
    const r = resolveItem(facts(meal({ vendor: 'Netzwerk Nord GmbH' }), { decision: DECISION }), [RULE], SMALL_BUSINESS);
    expect(r.item.formLineKey).toBe('euer.meals');
    expect(r.allocationOrigin).toBe('meal_register');
  });

  it('an incomplete meal is an open check, not a zero', () => {
    const { result } = run(meal({ guests: [] }));
    expect(result.checks.map((c) => c.kind)).toEqual(['meal_incomplete']);
    expect(result.lines).toEqual([]);
  });

  it('a private or travel meal is outside the statement without a check', () => {
    for (const record of [meal({ zuordnung: 'Privat' }), meal({ mealType: 'travel_meal' })]) {
      const { result } = run(record);
      expect(result.checks).toEqual([]);
      expect(result.lines).toEqual([]);
    }
  });

  it('with the section 19 question open a meal reports that question once', () => {
    const { result } = run(meal(), UNANSWERED);
    expect(result.checks.map((c) => c.kind)).toEqual(['small_business_unanswered']);
  });

  it('a receipt in the meal category that is no meal needs a line of its own', () => {
    const { r, result } = run(meal({ mealType: 'not_a_meal' }));
    expect(r.isMeal).toBe(false);
    expect(result.checks.map((c) => c.kind)).toEqual(['no_form_line']);
  });
});

describe('legacyAllocations', () => {
  it('reads assignment and share', () => {
    expect(legacyAllocations('Geschäftlich', null)).toEqual([{ purpose: 'business', shareBp: 10000 }]);
    expect(legacyAllocations('Geschäftlich', 30)).toEqual([{ purpose: 'business', shareBp: 3000 }]);
    expect(legacyAllocations('Geschäftlich', 0)).toEqual([{ purpose: 'private', shareBp: 10000 }]);
    expect(legacyAllocations('Universität', 70)).toEqual([{ purpose: 'study', shareBp: 7000 }]);
    expect(legacyAllocations('Privat', 100)).toEqual([{ purpose: 'private', shareBp: 10000 }]);
    expect(legacyAllocations(null, 100)).toBeNull();
  });

  it('clamps a share outside 0 to 100', () => {
    expect(legacyAllocations('Geschäftlich', 250)).toEqual([{ purpose: 'business', shareBp: 10000 }]);
    expect(legacyAllocations('Geschäftlich', -5)).toEqual([{ purpose: 'private', shareBp: 10000 }]);
  });
});
