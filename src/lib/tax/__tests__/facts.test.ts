import { describe, expect, it } from 'vitest';
import { REGULAR_BUSINESS, SMALL_BUSINESS, UNANSWERED, meal } from '@/lib/meals/__tests__/fixtures';
import type { MealRecord } from '@/lib/meals/types';
import { computeYear } from '../compute';
import type { TreatmentInput, VendorRule } from '../decisions';
import { legacyAllocations } from '../defaults';
import { resolveItem, type ReceiptFacts } from '../facts';
import { rulesForYear } from '../rules';

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

  it('carries the section 19 answer onto the item', () => {
    expect(resolveItem(facts(receipt()), [], UNANSWERED).item.smallBusiness).toBeNull();
    expect(resolveItem(facts(receipt()), [], REGULAR_BUSINESS).item.smallBusiness).toBe(false);
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
