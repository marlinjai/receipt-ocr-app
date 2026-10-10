import { mealDeduction, mealStatus, smallBusinessOn, toCents } from '@/lib/meals/rules';
import type { MealRecord, MealTaxSettings } from '@/lib/meals/types';
import { ruleInForce, type TreatmentInput, type VendorRule, vendorKey } from './decisions';
import { CATEGORY_FORM_LINE, DEFAULT_EMPLOYMENT_LINE, DEFAULT_STUDY_LINE, legacyAllocations } from './defaults';
import type { FormLineKey } from './rules/types';
import type { Allocation, LedgerItem, MealFact } from './types';

/**
 * The ONE mapper from a receipt row (already normalized by the meal module's
 * `rowToMealRecord`) to the facts the tax rules work on.
 *
 * Where a treatment comes from, strongest first:
 *   1. a decision on the item itself,
 *   2. the vendor rule in force on the item's date,
 *   3. the older columns and the category default.
 * The origin travels with the item so the screen can say why an item is
 * treated the way it is.
 */

export type TreatmentOrigin = 'item' | 'vendor_rule' | 'legacy_columns' | 'category_default' | 'meal_register';

export interface ReceiptFacts {
  record: MealRecord;
  /** The "Business Share %" cell, null when empty. */
  businessSharePercent: number | null;
  decision: TreatmentInput | null;
}

export interface ResolvedItem {
  item: LedgerItem;
  vendorKey: string | null;
  /** Null when no source gave an allocation (an open check). */
  allocationOrigin: TreatmentOrigin | null;
  formLineOrigin: TreatmentOrigin | null;
  /** The vendor rule that applies, even when a decision on the item overrides it. */
  vendorRuleId: string | null;
  /** True when the row is something the meal register judges (complete, incomplete or excluded). */
  isMeal: boolean;
}

/** The receipt's net amount in euro cents, when it states one that fits its total. */
function netOf(record: MealRecord): number | null {
  if (record.net === null || !Number.isFinite(record.net) || record.net <= 0) return null;
  if (record.gross === null || record.net > record.gross) return null;
  if (record.currency === 'EUR') return toCents(record.net);
  if (record.fxRate === null || !(record.fxRate > 0)) return null;
  return Math.round(toCents(record.net) * record.fxRate);
}

function amountOf(record: MealRecord): Pick<LedgerItem, 'amountCents' | 'amountBasis' | 'missingAmount'> {
  if (record.gross === null || !Number.isFinite(record.gross) || record.gross === 0) {
    return { amountCents: null, amountBasis: 'document', missingAmount: 'no_amount' };
  }
  if (record.currency === 'EUR') return { amountCents: toCents(record.gross), amountBasis: 'document' };
  if (record.fxRate === null || !(record.fxRate > 0)) {
    return { amountCents: null, amountBasis: 'reference_rate', missingAmount: 'no_exchange_rate' };
  }
  // A foreign-currency document converted at the reference rate: an estimate
  // until the euro amount the bank charged is known.
  return { amountCents: Math.round(toCents(record.gross) * record.fxRate), amountBasis: 'reference_rate' };
}

function mealFact(record: MealRecord, settings: MealTaxSettings): MealFact | null {
  const status = mealStatus(record);
  if (status.kind === 'not_a_meal') return null;
  if (status.kind === 'excluded') return { status: 'excluded' };
  if (status.kind === 'incomplete') return { status: 'incomplete' };
  const deduction = mealDeduction(record, settings);
  // An unanswered section 19 question is reported once, on the item itself.
  if (deduction.kind === 'setting_missing') return { status: 'setting_missing' };
  if (deduction.kind !== 'ok') return { status: 'no_amount' };
  return {
    status: 'complete',
    deductibleCents: toCents(deduction.deductible),
    nonDeductibleCents: toCents(deduction.nonDeductible),
    // On the net basis the meal's input tax is deductible in full beside the 70 percent.
    ...(deduction.inputVat !== null ? { inputVatCents: toCents(deduction.inputVat) } : {}),
  };
}

function employmentDefault(allocations: Allocation[] | null): FormLineKey | null {
  if (!allocations) return null;
  if (allocations.some((a) => a.purpose === 'study' && a.shareBp > 0)) return DEFAULT_STUDY_LINE;
  if (allocations.some((a) => a.purpose === 'employment' && a.shareBp > 0)) return DEFAULT_EMPLOYMENT_LINE;
  return null;
}

export function resolveItem(
  facts: ReceiptFacts,
  vendorRules: readonly VendorRule[],
  settings: MealTaxSettings,
): ResolvedItem {
  const { record, decision } = facts;
  const key = vendorKey(record.vendor);
  const rule = ruleInForce(vendorRules, key, record.date);
  const meal = mealFact(record, settings);
  const base = {
    id: record.rowId,
    label: record.name || record.vendor || 'Beleg ohne Namen',
    vendor: record.vendor,
    date: record.date,
    dateBasis: 'document' as const,
    ...amountOf(record),
    netCents: netOf(record),
    // The status on the receipt's own date: a later change leaves earlier receipts alone.
    smallBusiness: smallBusinessOn(settings, record.date),
  };

  // A row the meal register judges is treated by the register alone: its line
  // is the meal line and its worth is the register's 70 percent, so that the
  // statement and the register can never show two different figures.
  if (meal !== null) {
    return {
      item: {
        ...base,
        formLineKey: 'euer.meals',
        employmentLineKey: null,
        allocations: [{ purpose: meal.status === 'excluded' ? 'private' : 'business', shareBp: 10000 }],
        meal,
      },
      vendorKey: key,
      allocationOrigin: 'meal_register',
      formLineOrigin: 'meal_register',
      vendorRuleId: rule?.id ?? null,
      isMeal: true,
    };
  }

  let allocations: Allocation[] | null;
  let allocationOrigin: TreatmentOrigin | null;
  let formLineKey: FormLineKey | null;
  let formLineOrigin: TreatmentOrigin | null;
  let employmentLineKey: FormLineKey | null;

  const chosen = decision ?? rule;
  if (chosen) {
    const origin: TreatmentOrigin = decision ? 'item' : 'vendor_rule';
    allocations = chosen.allocations;
    allocationOrigin = origin;
    formLineKey = chosen.formLineKey;
    formLineOrigin = chosen.formLineKey ? origin : null;
    employmentLineKey = chosen.employmentLineKey;
  } else {
    allocations = legacyAllocations(record.zuordnung, facts.businessSharePercent);
    allocationOrigin = allocations ? 'legacy_columns' : null;
    // A receipt filed under the meal category that the register says is not a
    // meal has no sensible default line: it asks for a decision.
    const byCategory = record.category ? CATEGORY_FORM_LINE[record.category] : undefined;
    formLineKey = byCategory && byCategory !== 'euer.meals' ? byCategory : null;
    formLineOrigin = formLineKey ? 'category_default' : null;
    employmentLineKey = employmentDefault(allocations);
  }

  return {
    item: {
      ...base,
      formLineKey,
      employmentLineKey,
      allocations,
      meal: null,
      severalLowValueItems: decision?.severalLowValueItems === true && formLineKey === 'euer.low_value_assets',
    },
    vendorKey: key,
    allocationOrigin,
    formLineOrigin,
    vendorRuleId: rule?.id ?? null,
    isMeal: false,
  };
}
