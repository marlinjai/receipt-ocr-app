import type { AssetCheck, AssetFact, AssetYearRow } from './assets';
import type { FormId, FormLineKey, LineNumbering } from './rules/types';

/**
 * The facts of a year, as the tax rules see them. Everything that reads table
 * rows, payments or settings maps into these types once (`facts.ts`); the
 * rules never look at a table cell. A scenario is these facts plus changes,
 * run through the same `computeYear`.
 */

/** Who bears a part of an item's cost. */
export type Purpose =
  /** The business: lands on the item's line of the income-surplus statement. */
  | 'business'
  /** Study or training beside a job: lands on the employment annex. */
  | 'study'
  /** The salaried job itself: lands on the employment annex. */
  | 'employment'
  /** Private: deducted nowhere. */
  | 'private';

export const PURPOSES: readonly Purpose[] = ['business', 'study', 'employment', 'private'];

export interface Allocation {
  purpose: Purpose;
  /** Basis points of the item's cost; the allocations of one item never exceed 10000. */
  shareBp: number;
}

/** A business meal as the meal register judges it. The register's rules are reused, not repeated. */
export type MealFact =
  | {
      status: 'complete';
      deductibleCents: number;
      nonDeductibleCents: number;
      /** Under regular taxation: the input tax of the meal, deductible in full beside the 70 percent. */
      inputVatCents?: number;
    }
  /** Guests, occasion or another required fact is missing. */
  | { status: 'incomplete' }
  /** Not a register entry (private, staff meal, travel meal). */
  | { status: 'excluded' }
  /** No usable total. */
  | { status: 'no_amount' }
  /** The section 19 question is unanswered, so the register shows no amount yet. */
  | { status: 'setting_missing' };

export interface LedgerItem {
  id: string;
  /** What a person recognizes the item by. */
  label: string;
  vendor: string | null;
  /**
   * The ISO day the item counts on: the payment day once a payment is linked,
   * until then the document day (cash basis, section 11 of the income tax act).
   */
  date: string | null;
  dateBasis: 'payment' | 'document';
  /**
   * The cost in euro cents. Under section 19 of the value-added tax act this
   * is the gross amount, because no input tax is deducted.
   */
  amountCents: number | null;
  /**
   * Where the euro amount comes from: the linked payment, the document itself,
   * or a foreign-currency document converted at a reference rate (an estimate
   * until the bank amount is known).
   */
  amountBasis: 'payment' | 'document' | 'reference_rate';
  /** Why `amountCents` is null. */
  missingAmount?: 'no_amount' | 'no_exchange_rate';
  /** The same amount without value-added tax, when the receipt states it. The asset limits are net amounts. */
  netCents?: number | null;
  /**
   * Set when the receipt is part of the cost of an asset. It is then not an
   * expense of its own: the asset register decides what is deducted and when.
   */
  assetId?: string | null;
  /** The owner stated that the receipt holds several assets, each within the low-value limit on its own. */
  severalLowValueItems?: boolean;
  /** The line of the income-surplus statement the business share goes to. */
  formLineKey: FormLineKey | null;
  /** The line of the employment annex the study and employment shares go to. */
  employmentLineKey: FormLineKey | null;
  /** Null: nobody has decided yet who bears this item. */
  allocations: Allocation[] | null;
  /**
   * The section 19 status on the item's date: true = small business, false =
   * regular value-added taxation, null = the question is unanswered.
   */
  smallBusiness: boolean | null;
  /** Set for items on the business-meal line. */
  meal: MealFact | null;
}

/** How an issued invoice is taxed, as printed on it. */
export type InvoiceTreatment =
  /** No value-added tax shown (small business, section 19). */
  | 'small_business'
  /** Tax at the standard rate. */
  | 'standard'
  /** Tax at the reduced rate. */
  | 'reduced'
  /** No tax and outside the small-business rule: exempt, not taxable here, or the client owes the tax. */
  | 'not_taxable';

export const INVOICE_TREATMENTS: readonly InvoiceTreatment[] = ['small_business', 'standard', 'reduced', 'not_taxable'];

/** An invoice the business issued, with the money received for it. */
export interface InvoiceFact {
  id: string;
  number: string;
  issueDate: string | null;
  /** The invoice total. */
  grossCents: number;
  /** The value-added tax in the total; 0 where none is shown. */
  vatCents: number;
  treatment: InvoiceTreatment;
  /** Money received for it, each with its day. Revenue counts on these days (cash basis). */
  payments: Array<{ date: string; cents: number }>;
  /**
   * Set when an earlier return already declared this invoice in another year
   * (under a different method). Its payments are then no revenue again.
   */
  declaredInYear: number | null;
  /** The section 19 status on the issue date; see `LedgerItem.smallBusiness`. */
  smallBusinessOnIssue: boolean | null;
}

/** A payment of value-added tax to the tax office, or a refund from it. */
export interface VatSettlementFact {
  id: string;
  date: string;
  cents: number;
  direction: 'paid' | 'refunded';
}

export interface YearFacts {
  year: number;
  items: LedgerItem[];
  assets?: AssetFact[];
  /** Undefined: invoices are not recorded at all, so no revenue and no profit can be stated. */
  invoices?: InvoiceFact[];
  vatSettlements?: VatSettlementFact[];
  /** The section 19 status on 31 December of the year, to notice an asset bought under the other status. */
  smallBusinessAtYearEnd?: boolean | null;
}

/** Why an item needs a person. One list of these is the queue the dashboard is worked from. */
export type OpenCheckKind =
  | 'no_date'
  | 'no_amount'
  | 'no_exchange_rate'
  | 'amount_estimated'
  | 'no_allocation'
  | 'allocation_exceeds_whole'
  | 'no_form_line'
  | 'no_employment_line'
  | 'small_business_unanswered'
  /** Under regular taxation the cost is the net amount, and the receipt does not state one. */
  | 'net_amount_missing'
  | 'meal_incomplete'
  | 'meal_without_register_facts'
  /** On the low-value asset line but above what a low-value asset may cost: it has to become an asset. */
  | 'needs_asset'
  /** On the low-value asset line and possibly above the limit; the net amount would tell. */
  | 'net_amount_needed';

export interface OpenCheck {
  itemId: string;
  kind: OpenCheckKind;
  /** True when the item is left out of every total until the check is resolved. */
  blocking: boolean;
}

/** One amount an item contributes to one form line. */
export interface ItemPart {
  lineKey: FormLineKey;
  purpose: Purpose;
  cents: number;
  /** The part the form asks for in its "not deductible" column. */
  nonDeductibleCents: number;
}

export interface ItemResult {
  itemId: string;
  /** False when a blocking check keeps the item out of every total. */
  counted: boolean;
  parts: ItemPart[];
  /** The part of the cost nobody deducts. */
  privateCents: number;
  checks: OpenCheck[];
}

export interface LineResult {
  key: FormLineKey;
  form: FormId;
  /** The printed line number; null unless `numbering` is `verified`. */
  line: number | null;
  numbering: LineNumbering;
  label: string;
  kind: 'revenue' | 'expense';
  cents: number;
  nonDeductibleCents: number;
  itemIds: string[];
  /** Assets that contribute to the line. */
  assetIds: string[];
}

/** One asset in one year: its place in the register and what it puts on the statement. */
export interface AssetYearResult {
  assetId: string;
  /** False when a check keeps the asset out of every total. */
  counted: boolean;
  /** The year's row of the schedule, before the business share. Null when not counted or not yet bought. */
  row: AssetYearRow | null;
  parts: Array<{ lineKey: FormLineKey; cents: number }>;
  checks: AssetCheck[];
}

export type InvoiceCheckKind =
  /** The invoice shows no tax although regular taxation applied on its date, or tax although the small-business rule applied. */
  | 'invoice_treatment_mismatch'
  | 'invoice_no_date'
  /** More was received than the invoice total. */
  | 'invoice_overpaid';

export interface InvoiceResult {
  invoiceId: string;
  /** Money received for the invoice in this year. */
  receivedCents: number;
  /** Of that, left out of the statement because another year's return declared the invoice. */
  excludedCents: number;
  /** Still unpaid at the end of this year. */
  outstandingCents: number;
  parts: Array<{ lineKey: FormLineKey; cents: number }>;
  checks: InvoiceCheckKind[];
}

/** Value-added tax that arises on a day: charged to a client (output) or paid to a supplier (input). */
export interface VatEvent {
  date: string;
  cents: number;
  source: 'invoice' | 'item' | 'asset';
  id: string;
}

export interface RevenueResult {
  /** False when invoices are not recorded: every figure below is then meaningless and must not be shown as zero. */
  recorded: boolean;
  /** Money received for invoices in the year, tax included. */
  receivedCents: number;
  /**
   * Turnover of the year as the small-business limits measure it: money
   * received without the value-added tax in it, per month (index 0 = January).
   */
  turnoverByMonthCents: number[];
  turnoverCents: number;
  /** Invoiced and unpaid at the end of the year. */
  outstandingCents: number;
  /** The same without the value-added tax in it: what the unpaid invoices would add to turnover. */
  outstandingTurnoverCents: number;
  invoices: InvoiceResult[];
}

export interface YearResult {
  year: number;
  /** The year of the rule set used, and whether it is that year's own. */
  rulesYear: number;
  rulesExact: boolean;
  /** Lines with at least one item, in form order. */
  lines: LineResult[];
  /** Sum of the expense lines of the income-surplus statement. */
  businessExpenseCents: number;
  /** Sum of its revenue lines. Complete only when `revenue.recorded`. */
  businessRevenueCents: number;
  revenue: RevenueResult;
  /** Revenue minus expenses of the statement; null while invoices are not recorded. */
  profitCents: number | null;
  /** Input tax by the day it arose (receipt or purchase date), for the advance return periods. */
  inputVatEvents: VatEvent[];
  /** Output tax by issue date and by payment date, so either taxation method can be computed. */
  outputVatByIssue: VatEvent[];
  outputVatByPayment: VatEvent[];
  /** Sum of the lines of the employment annex. */
  employmentCostCents: number;
  privateCents: number;
  items: ItemResult[];
  checks: OpenCheck[];
  assets: AssetYearResult[];
  assetChecks: AssetCheck[];
  /** Items of the year that are in the totals, and those kept out by a blocking check. */
  countedItems: number;
  blockedItems: number;
}
