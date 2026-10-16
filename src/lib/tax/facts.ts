import { mealDeduction, mealStatus, smallBusinessOn, toCents } from '@/lib/meals/rules';
import type { MealRecord, MealTaxSettings } from '@/lib/meals/types';
import { ruleInForce, type TreatmentInput, type VendorRule, vendorKey } from './decisions';
import { CATEGORY_FORM_LINE, DEFAULT_EMPLOYMENT_LINE, DEFAULT_STUDY_LINE, legacyAllocations } from './defaults';
import { itemIdOf, linesMatchTotal, spreadOverLines, type ReceiptLine } from './lines';
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

export type TreatmentOrigin = 'item' | 'vendor_rule' | 'legacy_columns' | 'category_default' | 'meal_register' | 'line';

export interface ReceiptFacts {
  record: MealRecord;
  /** The "Business Share %" cell, null when empty. */
  businessSharePercent: number | null;
  decision: TreatmentInput | null;
  /**
   * What linked payments say the receipt cost and when: the day of the first
   * payment and the euro amount paid, refunds already taken off. Null while
   * no payment is linked.
   */
  paid?: { day: string; cents: number } | null;
  /**
   * Refunds linked to this receipt while no payment out is linked (the
   * purchase was paid in cash, or its payment is not imported): they are
   * taken off the document's amount, which stays on the document's day.
   */
  refundedCents?: number;
  /**
   * Money back and money out linked to the receipt, apart. A credit note
   * (negative total) is paid by money coming back: it counts on the day of the
   * first, with that amount. Money out linked to a credit note is a question.
   */
  moneyBack?: { day: string; cents: number } | null;
  moneyOutCents?: number;
  /**
   * Set when a person confirmed the ten-day rule for this receipt (see
   * `year-boundary.ts`): the day it counts on instead of the day it was paid.
   */
  countsOnDay?: string | null;
  /** The receipt's lines, when it was split. */
  lines?: ReceiptLine[];
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
  /** The receipt row, and the line when this item is one line of a split receipt. */
  rowId: string;
  lineId: string | null;
  /** The line's own text, for a line. */
  lineDescription: string | null;
}

/** The same day one year earlier (29 February gives 28 February). */
function yearBefore(isoDay: string): string {
  const year = Number(isoDay.slice(0, 4)) - 1;
  const rest = isoDay.slice(4) === '-02-29' ? '-02-28' : isoDay.slice(4);
  return `${year}${rest}`;
}

/**
 * Does a stated net amount fit its total? Net and total carry the same sign
 * (a credit note is negative in both) and the net is not larger in amount than
 * the total. A net of zero beside a total is no net amount.
 */
function netFits(net: number | null, gross: number | null): net is number {
  if (net === null || gross === null || !Number.isFinite(net) || !Number.isFinite(gross)) return false;
  if (net === 0 || gross === 0 || Math.sign(net) !== Math.sign(gross)) return false;
  return Math.abs(net) <= Math.abs(gross);
}

/**
 * The receipt's net amount in euro cents, when it states one that fits its
 * total. Negative for a credit note, so that under regular taxation it reduces
 * the expense by its net amount and the input tax by the tax in it.
 */
function netOf(record: MealRecord): number | null {
  if (!netFits(record.net, record.gross)) return null;
  if (record.currency === 'EUR') return toCents(record.net as number);
  if (record.fxRate === null || !(record.fxRate > 0)) return null;
  return roundCents(toCents(record.net as number) * record.fxRate);
}

/** Round to the cent, half away from zero, so a credit note mirrors its invoice exactly. */
function roundCents(value: number): number {
  return Math.sign(value) * Math.round(Math.abs(value));
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
  return { amountCents: roundCents(toCents(record.gross) * record.fxRate), amountBasis: 'reference_rate' };
}

/**
 * The net part of what was paid: the receipt's own proportion of net to total,
 * applied to the paid euro amount. Null when the receipt states no net amount.
 */
function netOfPaid(record: MealRecord, paidCents: number): number | null {
  if (!netFits(record.net, record.gross)) return null;
  // The proportion of net to total is positive for an invoice and a credit note alike.
  return roundCents((paidCents * toCents(record.net as number)) / toCents(record.gross as number));
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
  const stated = amountOf(record);
  const creditNote = stated.amountCents !== null && stated.amountCents < 0;
  // A credit note is paid by money coming back, on the day of the first; money
  // out linked to it is a question for a person (see `creditNotePaymentOut`).
  const creditNoteBack = creditNote && (facts.moneyOutCents ?? 0) === 0 && facts.moneyBack ? facts.moneyBack : null;
  const paid = creditNote ? (creditNoteBack ? { day: creditNoteBack.day, cents: -creditNoteBack.cents } : null) : (facts.paid ?? null);
  // A refund reduces a purchase; a credit note is already the money coming back.
  const refunded = paid || stated.amountCents === null || creditNote ? 0 : Math.max(0, facts.refundedCents ?? 0);
  const document = refunded > 0 && stated.amountCents !== null ? { ...stated, amountCents: Math.max(0, stated.amountCents - refunded) } : stated;
  const key = vendorKey(record.vendor);
  const rule = ruleInForce(vendorRules, key, record.date);
  // The meal register holds what was spent on a meal; a credit note is no meal of its own.
  const meal = creditNote ? null : mealFact(record, settings);
  const cashDay = paid ? paid.day : record.date;
  // The ten-day rule moves the year a recurring payment counts in, nothing
  // else. A meal is never moved: the meal register lists it by its own day.
  const countsOn = meal === null && cashDay !== null ? (facts.countsOnDay ?? null) : null;
  const base = {
    id: record.rowId,
    label: record.name || record.vendor || 'Beleg ohne Namen',
    vendor: record.vendor,
    // Cash basis: with a linked payment the receipt counts on the payment's day
    // and with the euro amount the bank charged (which settles a foreign-currency
    // receipt for good); until then on its own day and amount.
    date: countsOn ?? cashDay,
    dateBasis: countsOn ? ('year_boundary' as const) : paid ? ('payment' as const) : ('document' as const),
    ...(countsOn ? { vatDate: cashDay } : {}),
    ...(paid ? { amountCents: paid.cents, amountBasis: 'payment' as const } : document),
    netCents: paid ? netOfPaid(record, paid.cents) : refunded > 0 && document.amountCents !== null ? netOfPaid(record, document.amountCents) : netOf(record),
    // A net amount the receipt states but that cannot be its net (larger than the total, or the other sign).
    ...(record.net !== null && record.net !== 0 && !netFits(record.net, record.gross) && record.gross !== null && record.gross !== 0 ? { netDoesNotFit: true } : {}),
    ...(creditNote && (facts.moneyOutCents ?? 0) > 0 ? { creditNotePaymentOut: true } : {}),
    ...(creditNote && cashDay !== null && smallBusinessOn(settings, yearBefore(cashDay)) !== smallBusinessOn(settings, cashDay) ? { creditNoteStatusChanged: true } : {}),
    // The status on the receipt's own date: a later change leaves earlier receipts alone.
    smallBusiness: smallBusinessOn(settings, cashDay),
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
      rowId: record.rowId,
      lineId: null,
      lineDescription: null,
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
    rowId: record.rowId,
    lineId: null,
    lineDescription: null,
  };
}

/**
 * A receipt as one item, or as one item per line when it was split.
 *
 * Each line takes its share of the receipt's euro amount (and of its net
 * amount) in the proportion of the line amounts, so the lines add up to the
 * receipt to the cent whatever the currency or the amount actually paid. A
 * line is treated like its receipt unless it has a decision of its own. A
 * split whose lines no longer add up to the receipt's total yields the receipt
 * as one blocked item instead: nothing is computed from stale lines.
 */
export function resolveItems(facts: ReceiptFacts, vendorRules: readonly VendorRule[], settings: MealTaxSettings): ResolvedItem[] {
  const whole = resolveItem(facts, vendorRules, settings);
  const lines = [...(facts.lines ?? [])].sort((a, b) => a.position - b.position);
  // The meal register judges a meal as a whole; a meal is never split.
  if (lines.length === 0 || whole.isMeal) return [whole];
  const receiptGross = facts.record.gross !== null ? toCents(facts.record.gross) : null;
  if (!linesMatchTotal(lines, receiptGross)) return [{ ...whole, item: { ...whole.item, linesMismatch: true } }];

  const amounts = whole.item.amountCents !== null ? spreadOverLines(whole.item.amountCents, lines) : null;
  return lines.map((line, index): ResolvedItem => {
    const amountCents = amounts ? amounts[index] : null;
    // The line's own net amount in the receipt's currency, carried to euro by the line's own factor.
    const netCents = amountCents !== null && line.netCents !== null && line.grossCents > 0 ? Math.round((amountCents * line.netCents) / line.grossCents) : null;
    const own = line.treatment;
    return {
      ...whole,
      rowId: facts.record.rowId,
      lineId: line.id,
      lineDescription: line.description,
      allocationOrigin: own ? 'line' : whole.allocationOrigin,
      formLineOrigin: own ? (own.formLineKey ? 'line' : null) : whole.formLineOrigin,
      item: {
        ...whole.item,
        id: itemIdOf(facts.record.rowId, line.id),
        label: `${whole.item.label}: ${line.description}`,
        amountCents,
        netCents,
        ...(own
          ? { allocations: own.allocations, formLineKey: own.formLineKey, employmentLineKey: own.employmentLineKey }
          : {}),
        // Each line is judged against the low-value limit on its own, which is
        // what the "several small items" statement stood in for.
        severalLowValueItems: false,
      },
    };
  });
}
