import 'server-only';
import { Prisma, type PrismaClient } from '@prisma/client';
import { PAY_LATER_TERM_DAYS } from './payments/pay-later';
import { rowToMealRecord } from '@/lib/meals/record';
import { smallBusinessOn } from '@/lib/meals/rules';
import { allReceiptRows, getTaxSettings, guestsByRow, tableContext } from '@/lib/meals/service';
import type { MealGuestEntry } from '@/lib/meals/types';
import { ANNEX_ASSET_LINES, AssetInputError, validateAssetInput, validateDisposalInput, type AssetInput } from './asset-input';
import { assetSchedule, type AssetCheck, type AssetFact, type AssetKind, type AssetMethod, type AssetYearRow, type DisposalKind } from './assets';
import { computeYear } from './compute';
import {
  TreatmentError,
  isIsoDay,
  parseAllocations,
  ruleInForce,
  sameTreatment,
  validateTreatment,
  vendorKey,
  type TreatmentInput,
  type VendorRule,
} from './decisions';
import { resolveItem, resolveItems, type ReceiptFacts, type ResolvedItem, type TreatmentOrigin } from './facts';
import {
  berlinDay,
  boundaryDay,
  decideBoundary,
  otherYearOf,
  recursMonthly,
  touchesYear,
  BOUNDARY_REASONS,
  BOUNDARY_SUBJECT_KINDS,
  type BoundaryDecision,
  type BoundarySource,
  type BoundarySubjectKind,
} from './year-boundary';
import { LinesInputError, itemIdOf, splitItemId, storedLineTreatment, validateLines, type ReceiptLine } from './lines';
import { forecastYear, type Forecast } from './forecast';
import { overdueInvoices, type OverdueInvoice } from './overdue';
import { loadIncomeTax, type IncomeTaxView } from './income-tax/service';
import { proposeEstimateMatches, proposeMatches, vendorNamed, type MatchStrength } from './payments/match';
import { heldService, type ServiceKind } from './payments/funding';
import { countOrderNumbers, proposeRefunds, type RefundStrength, type RefundTarget } from './payments/refunds';
import {
  PaymentServiceError,
  countedReceiptLinks,
  deletePaymentLinksForRows,
  counterpartyKey,
  foreignAmount,
  linkProposals,
  loadPayments,
  type CounterpartyTreatment,
  type ForeignAmount,
  type LoadedPayments,
  type PaymentContext,
  type PaymentRow,
  type ReceiptForLink,
} from './payments/service';
import type { PaymentKind } from './payments/types';
import {
  RevenueInputError,
  validateExpectation,
  validateInvoiceInput,
  validateSettlement,
  validateStatusChange,
  validateVatSettings,
  parseTaxGroups,
} from './revenue-input';
import {
  ReverseChargeInputError,
  reverseChargeFor,
  validateEffectiveFrom,
  validateReverseChargeRate,
  earlierDay,
  withReverseCharge,
  type ReverseChargeEntry,
  type ReverseChargeOrigin,
  type ReverseChargeRateBp,
} from './reverse-charge';
import { RULE_YEARS, isFormLineKey, rulesForYear, type FormLine, type ProvisionalRules } from './rules';
import type { FormLineKey } from './rules/types';
import { INVOICE_TREATMENTS, type InvoiceCheckKind, type InvoiceFact, type InvoiceTreatment, type ItemPart, type LineResult, type OpenCheck, type TaxGroup, type VatSettlementFact } from './types';
import { vatYear, type VatFrequency, type VatMethod, type VatYear } from './vat';

/**
 * Server-side reads and writes for the finance area.
 *
 * Like the meal service, every function takes the workspace explicitly,
 * resolved by the caller from the verified session and never from the
 * browser, and a row is only ever addressed through the workspace's own
 * Receipts table. Only decisions are written; every figure is computed on
 * read.
 */

export interface TaxContext {
  workspaceId: string;
  /** Stamped on created rows; null only for the development bypass. */
  tenantId: string | null;
}

export type TaxServiceErrorCode =
  | 'not_initialized'
  | 'row_not_found'
  | 'meal_row'
  | 'no_vendor'
  | 'invalid_date'
  | 'rule_not_found'
  | 'asset_not_found'
  | 'asset_row'
  | 'row_in_other_asset'
  | 'invoice_not_found'
  | 'invoice_number_taken'
  | 'invalid_write_off'
  | 'status_not_found'
  | 'status_unanswered'
  | 'settlement_not_found'
  | 'line_not_found'
  | 'boundary_subject_not_found'
  | 'not_in_year_boundary'
  | 'year_boundary_changed'
  | 'year_boundary_filed'
  | 'assignment_columns_missing';

export class TaxServiceError extends Error {
  readonly code: TaxServiceErrorCode;
  constructor(code: TaxServiceErrorCode) {
    super(code);
    this.name = 'TaxServiceError';
    this.code = code;
  }
}

const BUSINESS_SHARE_COLUMN = 'Business Share %';

function storedTreatment(row: {
  allocations: Prisma.JsonValue;
  formLineKey: string | null;
  employmentLineKey: string | null;
  severalLowValueItems?: boolean;
}): TreatmentInput | null {
  const allocations = parseAllocations(row.allocations);
  // A stored value that no longer parses (a purpose or line that was removed)
  // is treated as no decision: the item goes back to the queue instead of
  // being computed from something the code does not understand.
  if (allocations === null) return null;
  if (row.formLineKey !== null && !isFormLineKey(row.formLineKey)) return null;
  if (row.employmentLineKey !== null && !isFormLineKey(row.employmentLineKey)) return null;
  return {
    allocations,
    formLineKey: row.formLineKey as TreatmentInput['formLineKey'],
    employmentLineKey: row.employmentLineKey as TreatmentInput['employmentLineKey'],
    severalLowValueItems: row.severalLowValueItems === true,
  };
}

export async function listVendorRules(db: PrismaClient, workspaceId: string): Promise<VendorRule[]> {
  const rows = await db.taxVendorRule.findMany({
    where: { authWorkspaceId: workspaceId },
    orderBy: [{ vendorLabel: 'asc' }, { effectiveFrom: 'asc' }],
  });
  const out: VendorRule[] = [];
  for (const row of rows) {
    const treatment = storedTreatment(row);
    if (treatment) out.push({ id: row.id, vendorKey: row.vendorKey, vendorLabel: row.vendorLabel, effectiveFrom: row.effectiveFrom, ...treatment });
  }
  return out;
}

/**
 * The receipts whose treatment does not rest on the assignment column: a
 * decision on the receipt itself, a decision on every one of its lines, or a
 * rule for its vendor in force on its day. For all others the column is what
 * the statement reads (see legacyAllocations), and an empty one is open.
 */
export async function rowsWithOwnTreatment(
  db: PrismaClient,
  workspaceId: string,
  rows: ReadonlyArray<{ rowId: string; vendor: string; date: string | null }>,
): Promise<Set<string>> {
  const out = new Set<string>();
  if (rows.length === 0) return out;
  const rowIds = rows.map((r) => r.rowId);
  const [decisions, lines, vendorRules] = await Promise.all([
    db.taxItemDecision.findMany({ where: { authWorkspaceId: workspaceId, rowId: { in: rowIds } } }),
    db.taxReceiptLine.findMany({ where: { authWorkspaceId: workspaceId, rowId: { in: rowIds } } }),
    listVendorRules(db, workspaceId),
  ]);
  for (const decision of decisions) if (storedTreatment(decision)) out.add(decision.rowId);
  const decided = new Map<string, boolean>();
  for (const line of lines) decided.set(line.rowId, (decided.get(line.rowId) ?? true) && storedLineTreatment(line) !== null);
  for (const [rowId, all] of decided) if (all) out.add(rowId);
  for (const row of rows) if (ruleInForce(vendorRules, vendorKey(row.vendor), row.date)) out.add(row.rowId);
  return out;
}

export interface LoadedReceipts {
  facts: ReceiptFacts[];
}

/**
 * What linked payments say each receipt cost: money out counts, a refund
 * linked to the same receipt is taken off, and the day is that of the first
 * payment out.
 */
export function paidByRow(payments: readonly PaymentRow[]): Map<string, { day: string; cents: number; estimated?: true }> {
  const out = new Map<string, { day: string; cents: number; estimated?: true }>();
  for (const [rowId, money] of linkedByRow(payments)) if (money.paid) out.set(rowId, money.paid);
  return out;
}

/** What linked payments say about one receipt. */
export interface LinkedMoney {
  /**
   * Day of the first payment out and what was paid, refunds taken off; null
   * while no payment out is linked. `estimated` when a payment out counted in
   * it is another currency at the reference rate: then the sum is no amount
   * charged (see `resolveItem`).
   */
  paid: { day: string; cents: number; estimated?: true } | null;
  /** Refunds linked while no payment out is: taken off the document's own amount. */
  refundedCents: number;
  /**
   * Money back linked to the receipt: the day of the first and the sum. For a
   * credit note this is its payment (see `resolveItem`); for a purchase it is a
   * refund, already in `paid` or `refundedCents`.
   */
  back: { day: string; cents: number } | null;
  /** Money out linked to the receipt, whatever came back. */
  outCents: number;
}

/**
 * Money out and money back per receipt. A refund never stands for the
 * purchase: with only a refund linked (the purchase was paid in cash, or its
 * payment is not imported) the receipt keeps its own amount and day, less the refund.
 */
export function linkedByRow(payments: readonly PaymentRow[]): Map<string, LinkedMoney> {
  // Note for the ten-day rule (year-boundary days): it looks at money out only,
  // so a credit note refunded between 22 December and 10 January is not listed
  // there. Credit notes are not regularly recurring payments, so none is missed.
  const sums = new Map<string, { day: string | null; backDay: string | null; outCents: number; backCents: number; estimated: boolean }>();
  // A payment and the debit that funds it are the same money and count once (`countedReceiptLinks`).
  for (const { payment, link } of countedReceiptLinks(payments)) {
    const current = sums.get(link.rowId) ?? { day: null, backDay: null, outCents: 0, backCents: 0, estimated: false };
    if (payment.amountCents < 0) {
      current.outCents += link.cents;
      if (payment.estimated) current.estimated = true;
      if (current.day === null || payment.bookingDay < current.day) current.day = payment.bookingDay;
    } else {
      current.backCents += link.cents;
      if (current.backDay === null || payment.bookingDay < current.backDay) current.backDay = payment.bookingDay;
    }
    sums.set(link.rowId, current);
  }
  const out = new Map<string, LinkedMoney>();
  for (const [rowId, s] of sums) {
    const back = s.backDay !== null ? { day: s.backDay, cents: s.backCents } : null;
    out.set(
      rowId,
      s.day !== null
        ? { paid: { day: s.day, cents: Math.max(0, s.outCents - s.backCents), ...(s.estimated ? { estimated: true as const } : {}) }, refundedCents: 0, back, outCents: s.outCents }
        : { paid: null, refundedCents: s.backCents, back, outCents: 0 },
    );
  }
  return out;
}

export async function loadReceipts(
  db: PrismaClient,
  workspaceId: string,
  onlyRowId?: string,
  linked?: Map<string, LinkedMoney>,
): Promise<LoadedReceipts | null> {
  const ctx = await tableContext(db, workspaceId);
  if (!ctx) return null;
  // One row is looked up in THIS workspace's Receipts table too, never by the
  // adapter's single-row read: that one is not told the table and asks every
  // table of the database in turn, which took seconds per call. Reading the
  // workspace's own table is one query, and a row of another workspace, an
  // archived row or a group (never a receipt) is simply not in it.
  const receipts = (await allReceiptRows(ctx.adapter, ctx.tableId, ctx.columns)).filter((r) => !r.archived);
  const rows = onlyRowId ? receipts.filter((r) => r.id === onlyRowId) : receipts;
  const rowIds = rows.map((r) => r.id);
  const [guests, decisions, storedLines] = await Promise.all([
    guestsByRow(db, workspaceId, rowIds),
    rowIds.length === 0
      ? Promise.resolve([])
      : db.taxItemDecision.findMany({ where: { authWorkspaceId: workspaceId, rowId: { in: rowIds } } }),
    rowIds.length === 0
      ? Promise.resolve([])
      : db.taxReceiptLine.findMany({ where: { authWorkspaceId: workspaceId, rowId: { in: rowIds } }, orderBy: [{ position: 'asc' }, { createdAt: 'asc' }] }),
  ]);
  const linesByRow = new Map<string, ReceiptLine[]>();
  for (const line of storedLines) {
    const list = linesByRow.get(line.rowId) ?? [];
    list.push({ id: line.id, position: line.position, description: line.description, grossCents: line.grossCents, netCents: line.netCents, treatment: storedLineTreatment(line) });
    linesByRow.set(line.rowId, list);
  }
  const decisionByRow = new Map(decisions.map((d) => [d.rowId, storedTreatment(d)]));
  const noteByRow = new Map(decisions.map((d) => [d.rowId, d.note]));
  const shareColumn = ctx.columns.find((c) => c.name === BUSINESS_SHARE_COLUMN);
  const noGuests: MealGuestEntry[] = [];
  const facts = rows.map((row): ReceiptFacts => {
    const share = shareColumn ? row.cells[shareColumn.id] : null;
    const shareNumber = share === null || share === undefined || share === '' ? null : Number(share);
    return {
      record: rowToMealRecord(row, ctx.columns, ctx.selectOptions, guests.get(row.id) ?? noGuests),
      businessSharePercent: shareNumber !== null && Number.isFinite(shareNumber) ? shareNumber : null,
      decision: decisionByRow.get(row.id) ?? null,
      decisionNote: noteByRow.get(row.id) ?? null,
      paid: linked?.get(row.id)?.paid ?? null,
      refundedCents: linked?.get(row.id)?.refundedCents ?? 0,
      moneyBack: linked?.get(row.id)?.back ?? null,
      moneyOutCents: linked?.get(row.id)?.outCents ?? 0,
      lines: linesByRow.get(row.id) ?? [],
    };
  });
  return { facts };
}

/**
 * A payment between 22 December and 10 January, which the ten-day rule may
 * place in the other year (see `year-boundary.ts`).
 */
export interface YearBoundaryEntry {
  kind: BoundarySubjectKind;
  /** The receipt's row id, or the settlement's id. */
  subjectId: string;
  label: string;
  /** The day it was paid; for a receipt without a linked payment, the receipt's own day. */
  cashDay: string;
  dayBasis: 'payment' | 'document';
  cents: number | null;
  /** The year it would count in instead of the year of `cashDay`. */
  otherYear: number;
  /**
   * The answer that applies: true counts in `otherYear`, false stays. Null:
   * open, neither a person nor a rule answered (only these are asked). For an
   * inactive entry, the person's answer that is not applied.
   */
  answer: boolean | null;
  /** Where `answer` comes from: a person, a filed year, or a rule worked out on read (see `year-boundary.ts`). */
  source: BoundarySource | null;
  /** Why, in German, as the list shows it. */
  reason: string;
  /** The person's stored answer for this payment day, applied or not; null when nobody answered. */
  storedAnswer: boolean | null;
  /** The filed year that fixes this payment; null while both years are open. Nothing on it can be answered then. */
  filedYear: number | null;
  /** Set when the person's answer would move the payment across this filed year: it is shown, not applied. */
  departsFromFiled: number | null;
  /**
   * Set when an answer exists but has no effect right now: the receipt has
   * since become a business meal or part of an asset. It is listed so the
   * answer can be taken back instead of waking up again unseen.
   */
  inactive: 'meal' | 'asset' | null;
}

/** One item as the finance screens show it: the facts, where its treatment comes from, and what it contributes. */
export interface StatementItem {
  /** Unique per item: the receipt's row id, or row and line for one line of a split receipt. */
  itemId: string;
  rowId: string;
  /** Set when the item is one line of a split receipt, with the line's own text and amounts in the receipt's currency. */
  lineId: string | null;
  lineDescription: string | null;
  lineGrossCents: number | null;
  lineNetCents: number | null;
  /** The receipt's total in its own currency, cents: what the lines of a split have to add up to. */
  receiptGrossCents: number | null;
  /** The receipt's stored lines, also when they no longer add up (then the item is the whole receipt). */
  receiptLines: Array<{ id: string; description: string; grossCents: number; netCents: number | null }>;
  label: string;
  vendor: string | null;
  vendorKey: string | null;
  date: string | null;
  /** Set when the ten-day rule moved the item: the day it was really paid, while `date` is the day it counts on. */
  paidOn: string | null;
  category: string | null;
  /** Document amount and currency, for display beside the euro amount. */
  gross: number | null;
  currency: string;
  amountCents: number | null;
  amountBasis: 'payment' | 'document' | 'reference_rate';
  allocations: TreatmentInput['allocations'] | null;
  allocationOrigin: TreatmentOrigin | null;
  formLineKey: TreatmentInput['formLineKey'];
  formLineOrigin: TreatmentOrigin | null;
  employmentLineKey: TreatmentInput['employmentLineKey'];
  severalLowValueItems: boolean;
  /** True when the item has its own decision (which can be removed again). */
  hasDecision: boolean;
  /** The note stored with the receipt's own decision. */
  decisionNote: string | null;
  vendorRuleId: string | null;
  isMeal: boolean;
  /** The asset this receipt is part of, if any. */
  assetId: string | null;
  counted: boolean;
  parts: ItemPart[];
  privateCents: number;
  checks: OpenCheck[];
  /** Set when the buyer owes the tax on this purchase (section 13b): the rate, and whether the receipt or its vendor says so. */
  reverseCharge: { rateBp: number; origin: ReverseChargeOrigin } | null;
  /** The receipt's own statement, when it has one (rateBp null: "not under section 13b", against its vendor). */
  reverseChargeOwn: { rateBp: number | null } | null;
}

export interface StatementView {
  year: number;
  /** Years that have at least one dated item, plus every year with a rule set, newest first. */
  years: number[];
  /** Null: the section 19 question is unanswered (asked on the meal register page). */
  smallBusiness: boolean | null;
  rulesYear: number;
  rulesExact: boolean;
  rulesReviewedOn: string;
  /** Set when the rule set carries an earlier year's legal values because its own are not published yet. */
  rulesProvisional: ProvisionalRules | null;
  /** Per form: where its lines come from, or null when that form of this year is not compared with an official source. */
  formSources: Record<'euer' | 'employment', { citation: string; url: string; checkedOn: string } | null>;
  /** The lines a person can choose, in form order. */
  formLines: FormLine[];
  lines: LineResult[];
  businessExpenseCents: number;
  employmentCostCents: number;
  privateCents: number;
  countedItems: number;
  blockedItems: number;
  /** Items of the year plus undated items, which belong to every year's queue. */
  items: StatementItem[];
  /** Every asset of the workspace that exists in this year or needs attention. */
  assets: AssetView[];
  /** The limits a person needs to see when choosing a method, for purchases of this year. */
  assetLimits: {
    lowValueNetLimitCents: number;
    poolMinExclusiveNetCents: number;
    poolMaxNetCents: number;
    poolYears: number;
    decliningFrom: string;
    decliningTo: string;
    decliningMaxRateBp: number;
    decliningMaxMultiple: number;
  };
  businessRevenueCents: number;
  /** Revenue minus expenses; null until at least one invoice is recorded for the workspace. */
  profitCents: number | null;
  revenue: {
    /** False while the workspace has no issued invoice at all: revenue is then unknown, not zero. */
    recorded: boolean;
    receivedCents: number;
    turnoverCents: number;
    outstandingCents: number;
    /** Every invoice that touches the year: issued in it, paid in it, or still unpaid at its end. */
    invoices: InvoiceView[];
    /** Invoices issued up to this year and still unpaid 14 days after their due date, as of today: the reminder of the open checks. */
    overdue: OverdueInvoice[];
  };
  /** Where the year is heading against the small-business limits, as of today. */
  forecast: Forecast;
  limits: {
    previousYearLimitCents: number;
    currentYearLimitCents: number;
    /** How the running-year limit binds; see `YearRules['smallBusinessLimits']`. */
    currentYearLimit: 'at_once' | 'forecast_at_start';
    /** The limit this year's turnover is measured against for next year (next year's previous-year limit). */
    nextYearLimitCents: number;
    source: { citation: string; url: string; checkedOn: string };
  };
  expectedMonthlyRevenueCents: number | null;
  /** The status on the last day of the year, and every recorded change. */
  smallBusinessAtYearEnd: boolean | null;
  statusChanges: Array<{ id: string; effectiveFrom: string; smallBusiness: boolean }>;
  vat: {
    frequency: VatFrequency | null;
    method: VatMethod | null;
    /** True when any day of the year is under regular taxation. */
    applies: boolean;
    /** The advance return periods; null until frequency and method are set. */
    year: VatYear | null;
    /** Tax on purchases of the year that could not be deducted under the small-business rule. */
    undeductedInputVatCents: number;
    /**
     * Section 13b in a year fully under the small-business rule: the periods
     * in which tax is owed as the buyer (an advance return is due for exactly
     * those, section 18 (4a)). Null when the year has regular taxation (the
     * figures are then in `year`) or no such tax arose.
     */
    reverseChargeYear: VatYear | null;
    /** Receipts under section 13b whose tax is not in the figures yet (kept out by an open check, or part of an asset). */
    reverseChargePendingItems: number;
    /** The part of the section 13b tax on shares outside the business: owed, not deductible, and no business expense when paid. */
    reverseChargeNonBusinessCents: number;
    /**
     * Receipts under section 13b of the year in another currency: their base is
     * the booked euro amount, while the act asks for the ministry's monthly
     * average rate unless the tax office allowed the daily rate (section 16 (6)).
     */
    reverseChargeForeignCurrencyItems: number;
    /** `date` is the day of the payment; `countsOn` is set when the ten-day rule moved it into this year. */
    settlements: Array<{ id: string; date: string; cents: number; direction: 'paid' | 'refunded'; countsOn?: string }>;
  };
  /** Payments at the turn of the year a person is asked about (the ten-day rule), for this year. */
  yearBoundary: YearBoundaryEntry[];
  payments: PaymentsView;
  vendorRules: VendorRule[];
  /** The vendors whose purchases are under section 13b, each from its day on. */
  reverseChargeVendors: Array<{ id: string; label: string; vendorKey: string; effectiveFrom: string; rateBp: number | null }>;
  /** False until the Receipts table exists (first dashboard visit). */
  initialized: boolean;
  /** Wages, other return items and the income tax estimate of the year (finance plan, slice 6). */
  incomeTax: IncomeTaxView;
}

function toStatementItem(
  resolved: ResolvedItem,
  facts: ReceiptFacts,
  result: { counted: boolean; parts: ItemPart[]; privateCents: number; checks: OpenCheck[] },
  reverseCharge: { origin: ReverseChargeOrigin | null; own: { rateBp: number | null } | null },
): StatementItem {
  const { item } = resolved;
  const line = resolved.lineId ? (facts.lines ?? []).find((l) => l.id === resolved.lineId) : undefined;
  return {
    itemId: item.id,
    rowId: resolved.rowId,
    lineId: resolved.lineId,
    lineDescription: resolved.lineDescription,
    lineGrossCents: line?.grossCents ?? null,
    lineNetCents: line?.netCents ?? null,
    receiptGrossCents: facts.record.gross !== null && Number.isFinite(facts.record.gross) ? Math.round(facts.record.gross * 100) : null,
    receiptLines: (facts.lines ?? []).map((l) => ({ id: l.id, description: l.description, grossCents: l.grossCents, netCents: l.netCents })),
    label: item.label,
    vendor: item.vendor,
    vendorKey: resolved.vendorKey,
    date: item.date,
    paidOn: item.dateBasis === 'year_boundary' ? (item.vatDate ?? null) : null,
    category: facts.record.category,
    gross: facts.record.gross,
    currency: facts.record.currency,
    amountCents: item.amountCents,
    amountBasis: item.amountBasis,
    allocations: item.allocations,
    allocationOrigin: resolved.allocationOrigin,
    formLineKey: item.formLineKey,
    formLineOrigin: resolved.formLineOrigin,
    employmentLineKey: item.employmentLineKey,
    severalLowValueItems: item.severalLowValueItems === true,
    hasDecision: facts.decision !== null,
    decisionNote: facts.decision !== null ? (facts.decisionNote ?? null) : null,
    vendorRuleId: resolved.vendorRuleId,
    isMeal: resolved.isMeal,
    assetId: item.assetId ?? null,
    counted: result.counted,
    parts: result.parts,
    privateCents: result.privateCents,
    checks: result.checks,
    reverseCharge: item.reverseCharge && reverseCharge.origin ? { rateBp: item.reverseCharge.rateBp, origin: reverseCharge.origin } : null,
    reverseChargeOwn: reverseCharge.own,
  };
}

export async function loadStatement(db: PrismaClient, workspaceId: string, year: number): Promise<StatementView> {
  const loadedPayments = await loadPayments(db, workspaceId);
  const [loaded, vendorRules, settings, storedAssets] = await Promise.all([
    loadReceipts(db, workspaceId, undefined, linkedByRow(loadedPayments.payments)),
    listVendorRules(db, workspaceId),
    getTaxSettings(db, workspaceId),
    db.taxAsset.findMany({ where: { authWorkspaceId: workspaceId }, include: { parts: true }, orderBy: [{ acquisitionDate: 'asc' }, { createdAt: 'asc' }] }),
  ]);
  const [storedInvoices, storedSettlements, storedChanges, settingsRow, storedBoundaryAnswers, storedReverseCharges, filedYears] = await Promise.all([
    db.taxIssuedInvoice.findMany({ where: { authWorkspaceId: workspaceId }, include: { payments: true }, orderBy: [{ issueDate: 'asc' }, { number: 'asc' }] }),
    db.taxVatSettlement.findMany({ where: { authWorkspaceId: workspaceId }, orderBy: { settledOn: 'asc' } }),
    db.taxStatusChange.findMany({ where: { authWorkspaceId: workspaceId }, orderBy: { effectiveFrom: 'asc' } }),
    db.workspaceTaxSettings.findUnique({ where: { authWorkspaceId: workspaceId } }),
    db.taxYearBoundaryAnswer.findMany({ where: { authWorkspaceId: workspaceId } }),
    db.taxReverseCharge.findMany({ where: { authWorkspaceId: workspaceId }, orderBy: [{ subject: 'asc' }, { effectiveFrom: 'asc' }] }),
    db.taxYearSettings.findMany({ where: { authWorkspaceId: workspaceId, filedOn: { not: null } }, select: { year: true, filedOn: true } }),
  ]);
  const reverseChargeEntries = storedReverseCharges.map(toReverseChargeEntry);
  // A person's answers, with the day each was last saved: an answer saved after
  // a year's filing day may not change that filed year (see `year-boundary.ts`).
  const boundaryAnswers = new Map(
    storedBoundaryAnswers.map((a) => [`${a.subjectKind}:${a.subjectId}`, { cashDay: a.cashDay, belongsToOtherYear: a.belongsToOtherYear, savedOn: berlinDay(a.updatedAt) }]),
  );
  const filedOn = new Map(filedYears.map((y) => [y.year, y.filedOn as string]));
  // The ten-day rule for the settlements with the tax office: worked out once, used by the totals and the list alike.
  const settlementBoundary = new Map(
    storedSettlements.flatMap((s): Array<[string, BoundaryDecision]> =>
      otherYearOf(s.settledOn) === null
        ? []
        : [[s.id, decideBoundary({ kind: 'vat_settlement', cashDay: s.settledOn, stored: boundaryAnswers.get(`vat_settlement:${s.id}`), filedOn, recurring: null })]],
    ),
  );
  const invoiceFacts: InvoiceFact[] = storedInvoices.map((i) => ({
    id: i.id,
    number: i.number,
    issueDate: i.issueDate,
    grossCents: i.grossCents,
    vatCents: i.vatCents,
    treatment: INVOICE_TREATMENTS.includes(i.treatment as InvoiceTreatment) ? (i.treatment as InvoiceTreatment) : 'not_taxable',
    taxGroups: storedTaxGroups(i.taxGroups),
    // Money received: what was typed in, plus every bank payment linked to the invoice.
    payments: [
      ...i.payments.map((p) => ({ date: p.paidOn, cents: p.cents })),
      ...loadedPayments.payments.flatMap((p) => p.links.filter((l) => l.invoiceId === i.id).map((l) => ({ date: p.bookingDay, cents: l.cents }))),
    ],
    declaredInYear: i.declaredInYear,
    writtenOffCents: i.writtenOffCents,
    writtenOffOn: i.writtenOffOn,
    smallBusinessOnIssue: smallBusinessOn(settings, i.issueDate),
  }));
  const settlementFacts: VatSettlementFact[] = storedSettlements.map((s) => ({
    id: s.id,
    // An advance payment at the turn of the year counts in the year it belongs to (by a person's answer or the rule).
    date: settlementBoundary.get(s.id)?.answer === true ? (boundaryDay(s.settledOn) ?? s.settledOn) : s.settledOn,
    cents: s.cents,
    direction: s.direction === 'refunded' ? 'refunded' : 'paid',
  }));
  const smallBusinessAtYearEnd = smallBusinessOn(settings, `${year}-12-31`);
  const resolvedRules = rulesForYear(year);
  // An asset part is a whole receipt (line id '') or one line of it.
  const assetByItem = new Map<string, string>();
  const rowsInAssets = new Set<string>();
  for (const asset of storedAssets) {
    for (const part of asset.parts) {
      assetByItem.set(itemIdOf(part.rowId, part.lineId || null), asset.id);
      rowsInAssets.add(part.rowId);
    }
  }
  const cashDayOf = (f: ReceiptFacts) => f.paid?.day ?? f.record.date;
  const loadedFacts = loaded?.facts ?? [];
  // Whole receipts, for matching payments: a payment pays a receipt, not a line of it.
  // On their real day: a payment is matched to a receipt by when it was paid, whatever year it counts in.
  const wholeReceipts = loadedFacts.map((f) => resolveItem({ ...f, countsOnDay: null }, vendorRules, settings));
  // Evidence that a vendor recurs: the days of its receipts (paid, else dated)
  // and of the payments out whose counterparty or text names it.
  const daysByVendor = new Map<string, string[]>();
  wholeReceipts.forEach((r, index) => {
    const day = cashDayOf(loadedFacts[index]);
    if (r.vendorKey && day) daysByVendor.set(r.vendorKey, [...(daysByVendor.get(r.vendorKey) ?? []), day]);
  });
  const paymentsOut = loadedPayments.payments
    .filter((p) => p.amountCents < 0)
    .map((p) => ({ day: p.bookingDay, counterpartyKey: p.counterpartyKey, referenceKey: counterpartyKey(p.reference) }));
  const recurringAt = (vendor: string | null, cashDay: string): boolean | null =>
    vendor === null
      ? null
      : recursMonthly(cashDay, [
          ...(daysByVendor.get(vendor) ?? []),
          ...paymentsOut.filter((p) => vendorNamed(vendor, p.counterpartyKey, p.referenceKey)).map((p) => p.day),
        ]);
  // The ten-day rule per receipt in the window, worked out once. Meals are
  // listed by the meal register on their own day and assets are depreciated
  // from their acquisition: neither is decided by a filed year or a rule, only
  // a person's earlier answer is kept (and shown, so it can be taken back).
  const receiptBoundary = new Map<string, { decision: BoundaryDecision; inactive: 'meal' | 'asset' | null }>();
  loadedFacts.forEach((f, index) => {
    const cashDay = cashDayOf(f);
    if (cashDay === null || otherYearOf(cashDay) === null) return;
    const r = wholeReceipts[index];
    const stored = boundaryAnswers.get(`receipt:${f.record.rowId}`);
    const inactive = r.isMeal ? 'meal' : rowsInAssets.has(f.record.rowId) ? 'asset' : null;
    if (inactive === null) {
      receiptBoundary.set(f.record.rowId, { inactive, decision: decideBoundary({ kind: 'receipt', cashDay, stored, filedOn, recurring: recurringAt(r.vendorKey, cashDay) }) });
      return;
    }
    const storedAnswer = stored && stored.cashDay === cashDay ? stored.belongsToOtherYear : null;
    receiptBoundary.set(f.record.rowId, {
      inactive,
      decision: { answer: storedAnswer, source: storedAnswer === null ? null : 'person', reason: BOUNDARY_REASONS.person, storedAnswer, filedYear: null, departsFromFiled: null },
    });
  });
  // A receipt the ten-day rule places in the other year counts on that year's
  // boundary day. A receipt that is (partly) an asset is never moved.
  const facts = loadedFacts.map((f): ReceiptFacts => {
    const boundary = receiptBoundary.get(f.record.rowId);
    if (!boundary || boundary.inactive === 'asset' || boundary.decision.answer !== true) return f;
    return { ...f, countsOnDay: boundaryDay(cashDayOf(f)) };
  });
  const factsOfItem: ReceiptFacts[] = [];
  const foreignCurrencyReverseCharge = new Set<string>();
  // One pass over the entries: a receipt's own entry by row, the vendor entries by vendor.
  const ownReverseCharge = new Map(reverseChargeEntries.filter((e) => e.scope === 'row').map((e) => [e.subject, e]));
  const vendorReverseCharge = new Map<string, typeof reverseChargeEntries>();
  for (const e of reverseChargeEntries) if (e.scope === 'vendor') vendorReverseCharge.set(e.subject, [...(vendorReverseCharge.get(e.subject) ?? []), e]);
  const reverseChargeLookup = (rowId: string, vendor: string | null) => {
    const own = ownReverseCharge.get(rowId);
    return [...(own ? [own] : []), ...((vendor ? vendorReverseCharge.get(vendor) : undefined) ?? [])];
  };
  const reverseChargeOf = new Map<string, { origin: ReverseChargeOrigin | null; own: { rateBp: number | null } | null }>();
  const resolved = facts.flatMap((f) =>
    resolveItems(f, vendorRules, settings).map((r) => {
      factsOfItem.push(f);
      // Section 13b: the receipt's own statement, else its vendor's on the
      // document day. A meal is judged by the register and never carries one.
      const own = ownReverseCharge.get(r.rowId);
      // Also a receipt on the meal line through its treatment: the register judges it, never 13b.
      const mealLine = r.isMeal || r.item.formLineKey === 'euer.meals';
      const rc = mealLine ? null : reverseChargeFor(reverseChargeLookup(r.rowId, r.vendorKey), r.rowId, r.vendorKey, f.record.date);
      reverseChargeOf.set(r.item.id, { origin: rc?.origin ?? null, own: own ? { rateBp: own.rateBp } : null });
      // The tax arises with the invoice or the service, or earlier with a
      // payment made before it (section 13b (4) sentence 2): the earlier of the
      // document day and the payment day, with the status of that day.
      const taxDay = earlierDay(f.record.date, f.paid?.day);
      const item = rc ? withReverseCharge(r.item, rc.rateBp, taxDay, smallBusinessOn(settings, taxDay)) : r.item;
      if (rc && f.record.currency && f.record.currency !== 'EUR' && taxDay?.startsWith(`${year}-`)) foreignCurrencyReverseCharge.add(r.rowId);
      // A whole-receipt part covers every line of that receipt.
      const assetId = assetByItem.get(r.item.id) ?? assetByItem.get(r.rowId);
      return { ...r, item: assetId ? { ...item, assetId } : item };
    }),
  );
  const itemsByRow = new Map<string, ResolvedItem[]>();
  for (const r of resolved) itemsByRow.set(r.rowId, [...(itemsByRow.get(r.rowId) ?? []), r]);
  const itemById = new Map(resolved.map((r) => [r.item.id, r.item]));
  const assetFacts = storedAssets.map((a) => toAssetFact(a, itemById, itemsByRow, smallBusinessOn(settings, a.acquisitionDate)));
  const ledgerItems = resolved.map((r) => r.item);
  // No invoice in the workspace at all means revenue was never recorded, which
  // is different from a year without revenue.
  const revenueRecorded = invoiceFacts.length > 0;
  const result = computeYear(
    {
      year,
      items: ledgerItems,
      assets: assetFacts,
      invoices: revenueRecorded ? invoiceFacts : undefined,
      vatSettlements: settlementFacts,
      smallBusinessAtYearEnd,
    },
    resolvedRules,
  );
  // The previous year's turnover decides whether this year's status stands.
  const previous = revenueRecorded ? computeYear({ year: year - 1, items: [], invoices: invoiceFacts }, rulesForYear(year - 1)) : null;
  const limits = resolvedRules.rules.smallBusinessLimits;
  const nextYearLimitCents = rulesForYear(year + 1).rules.smallBusinessLimits.value.previousYearLimitCents;
  const expectedMonthlyRevenueCents = settingsRow?.expectedMonthlyRevenueCents ?? null;
  const forecast = forecastYear(
    {
      year,
      today: today(),
      receivedByMonthCents: result.revenue.turnoverByMonthCents,
      previousYearReceivedCents: previous ? previous.revenue.turnoverCents : null,
      outstandingCents: result.revenue.outstandingTurnoverCents,
      expectedMonthlyCents: expectedMonthlyRevenueCents,
    },
    { ...limits.value, nextYearLimitCents },
  );
  const vatFrequency: VatFrequency | null = settingsRow?.vatFrequency === 'monthly' || settingsRow?.vatFrequency === 'quarterly' ? settingsRow.vatFrequency : null;
  const vatMethod: VatMethod | null = settingsRow?.vatMethod === 'issued' || settingsRow?.vatMethod === 'received' ? settingsRow.vatMethod : null;
  const regularInYear =
    smallBusinessOn(settings, `${year}-01-01`) === false ||
    smallBusinessAtYearEnd === false ||
    storedChanges.some((c) => !c.smallBusiness && c.effectiveFrom.startsWith(`${year}-`));
  // What the small-business rule cost in input tax this year: the tax in the
  // business share of every counted receipt that stated a net amount.
  let undeductedInputVatCents = 0;
  const countedIds = new Set(result.items.filter((i) => i.counted).map((i) => i.itemId));
  for (const item of ledgerItems) {
    if (!countedIds.has(item.id) || item.meal) continue;
    if (item.smallBusiness !== true || item.date === null || !item.date.startsWith(`${year}-`)) continue;
    if (item.amountCents === null || item.netCents === null || item.netCents === undefined || item.assetId) continue;
    const businessBp = (item.allocations ?? []).filter((a) => a.purpose === 'business').reduce((s, a) => s + a.shareBp, 0);
    if (businessBp > 0) undeductedInputVatCents += Math.round(((item.amountCents - item.netCents) * businessBp) / 10_000);
  }
  const invoiceResults = new Map(result.revenue.invoices.map((i) => [i.invoiceId, i]));
  // Overdue as of today (decision D6 of the invoicing plan): a reminder is about now. Only invoices issued up to the
  // viewed year, because those are the ones its "Einnahmen" tab lists (unpaid, so outstanding at its end).
  const overdue = overdueInvoices(
    invoiceFacts.filter((i) => i.issueDate !== null && Number(i.issueDate.slice(0, 4)) <= year),
    today(),
  );
  const overdueIds = new Set(overdue.map((o) => o.invoiceId));
  const paymentsView = buildPaymentsView(loadedPayments, year, wholeReceipts, invoiceFacts, result.revenue.invoices);
  const resultById = new Map(result.items.map((i) => [i.itemId, i]));

  const items: StatementItem[] = [];
  const years = new Set<number>(RULE_YEARS);
  years.add(year);
  resolved.forEach((r, index) => {
    if (r.item.date) years.add(Number(r.item.date.slice(0, 4)));
    const itemResult = resultById.get(r.item.id);
    // computeYear only returns items of the year and undated ones.
    if (itemResult) items.push(toStatementItem(r, factsOfItem[index], itemResult, reverseChargeOf.get(r.item.id) ?? { origin: null, own: null }));
  });
  // By day, then by receipt; the lines of one receipt stay together, in their
  // stored order. Every pair is compared by the same keys, so the order is
  // the same whatever order the rows were loaded in.
  const receiptLabel = (i: StatementItem) => (i.lineDescription ? i.label.slice(0, i.label.length - i.lineDescription.length - 2) : i.label);
  const position = (i: StatementItem) => (i.lineId ? i.receiptLines.findIndex((l) => l.id === i.lineId) : 0);
  items.sort((a, b) =>
    (a.date ?? '') < (b.date ?? '')
      ? -1
      : (a.date ?? '') > (b.date ?? '')
        ? 1
        : receiptLabel(a).localeCompare(receiptLabel(b), 'de') || a.rowId.localeCompare(b.rowId) || position(a) - position(b),
  );

  const { rules } = resolvedRules;
  const assetResults = new Map(result.assets.map((a) => [a.assetId, a]));
  const assets: AssetView[] = [];
  storedAssets.forEach((stored, index) => {
    const fact = assetFacts[index];
    const yearResult = assetResults.get(stored.id);
    // Not yet bought in this year and nothing wrong with it: not this year's business.
    if (!yearResult) return;
    const firstYear = fact.opening ? fact.opening.year : fact.acquisitionDate ? Number(fact.acquisitionDate.slice(0, 4)) : year;
    assets.push({
      id: stored.id,
      label: fact.label,
      kind: fact.kind,
      acquisitionDate: fact.acquisitionDate,
      method: fact.method,
      usefulLifeMonths: fact.usefulLifeMonths,
      decliningRateBp: fact.decliningRateBp,
      businessShareBp: fact.businessShareBp,
      annexShareBp: fact.annexShareBp ?? 0,
      annexLineKey: fact.annexLineKey ?? null,
      reminderCents: fact.reminderCents,
      opening: fact.opening,
      disposal: fact.disposal,
      costCents: fact.costCents,
      netCostCents: fact.netCostCents,
      itemIds: stored.parts.map((p) => itemIdOf(p.rowId, p.lineId || null)),
      counted: yearResult.counted,
      checks: yearResult.checks,
      row: yearResult.row,
      parts: yearResult.parts,
      // The whole schedule up to this year, for the register.
      schedule: yearResult.counted ? assetSchedule(fact, rulesForYear(firstYear).rules.assets, year) : [],
    });
  });
  for (const asset of storedAssets) {
    const y = asset.openingYear ?? (asset.acquisitionDate ? Number(asset.acquisitionDate.slice(0, 4)) : null);
    if (y !== null) years.add(y);
  }
  // Every year anything is dated in must be selectable, or what was recorded
  // there could never be seen, changed or deleted again.
  const yearOfDay = (day: string | null) => (day ? years.add(Number(day.slice(0, 4))) : undefined);
  for (const invoice of invoiceFacts) {
    yearOfDay(invoice.issueDate);
    for (const payment of invoice.payments) yearOfDay(payment.date);
  }
  for (const settlement of settlementFacts) yearOfDay(settlement.date);
  for (const change of storedChanges) yearOfDay(change.effectiveFrom);
  for (const payment of loadedPayments.payments) yearOfDay(payment.bookingDay);
  const incomeTax = await loadIncomeTax(db, workspaceId, year, { profitCents: result.profitCents, lines: result.lines });
  return {
    year,
    years: [...years].sort((a, b) => b - a),
    smallBusiness: settings.smallBusiness,
    rulesYear: result.rulesYear,
    rulesExact: result.rulesExact,
    rulesReviewedOn: rules.reviewedOn,
    rulesProvisional: rules.provisional ?? null,
    formSources: rules.formSources,
    formLines: rules.formLines.map((l) => ({ ...l, line: l.numbering === 'verified' ? l.line : null })),
    lines: result.lines,
    businessExpenseCents: result.businessExpenseCents,
    employmentCostCents: result.employmentCostCents,
    privateCents: result.privateCents,
    countedItems: result.countedItems,
    blockedItems: result.blockedItems,
    items,
    profitCents: result.profitCents,
    revenue: {
      recorded: result.revenue.recorded,
      receivedCents: result.revenue.receivedCents,
      turnoverCents: result.revenue.turnoverCents,
      outstandingCents: result.revenue.outstandingCents,
      invoices: storedInvoices.flatMap((stored, index): InvoiceView[] => {
        const r = invoiceResults.get(stored.id);
        if (!r) return [];
        const fact = invoiceFacts[index];
        return [
          {
            id: stored.id,
            number: fact.number,
            issueDate: fact.issueDate,
            grossCents: fact.grossCents,
            vatCents: fact.vatCents,
            treatment: fact.treatment,
            taxGroups: fact.taxGroups ?? null,
            declaredInYear: fact.declaredInYear,
            payments: [...fact.payments].sort((a, b) => (a.date < b.date ? -1 : 1)),
            enteredPayments: stored.payments.map((p) => ({ date: p.paidOn, cents: p.cents })).sort((a, b) => (a.date < b.date ? -1 : 1)),
            writtenOffCents: stored.writtenOffCents,
            writtenOffOn: stored.writtenOffOn,
            receivedCents: r.receivedCents,
            excludedCents: r.excludedCents,
            declaredCents: r.declaredCents,
            outstandingCents: r.outstandingCents,
            checks: overdueIds.has(stored.id) ? [...r.checks, 'invoice_overdue'] : r.checks,
          },
        ];
      }),
      overdue,
    },
    forecast,
    limits: {
      previousYearLimitCents: limits.value.previousYearLimitCents,
      currentYearLimitCents: limits.value.currentYearLimitCents,
      currentYearLimit: limits.value.currentYearLimit ?? 'at_once',
      nextYearLimitCents,
      source: limits.source,
    },
    expectedMonthlyRevenueCents,
    smallBusinessAtYearEnd,
    statusChanges: storedChanges.map((c) => ({ id: c.id, effectiveFrom: c.effectiveFrom, smallBusiness: c.smallBusiness })),
    vat: {
      frequency: vatFrequency,
      method: vatMethod,
      applies: regularInYear,
      year:
        vatFrequency && vatMethod
          ? vatYear(year, vatFrequency, vatMethod, {
              inputVat: result.inputVatEvents,
              outputVatByIssue: result.outputVatByIssue,
              outputVatByPayment: result.outputVatByPayment,
              reverseCharge: result.reverseChargeEvents,
              reverseChargeInput: result.reverseChargeInputEvents,
            })
          : null,
      undeductedInputVatCents,
      // Under the small-business rule the tax owed as a buyer is still owed,
      // and declared for exactly the periods it arose in, by calendar quarter
      // (section 18 (2) through (4a)); a frequency stored for an earlier year
      // of regular taxation does not carry over, and the voluntary month of
      // section 18 (2a) is not open to these returns.
      reverseChargeYear:
        !regularInYear && result.reverseChargeEvents.length > 0
          ? vatYear(year, 'quarterly', vatMethod ?? 'issued', {
              inputVat: [],
              outputVatByIssue: [],
              outputVatByPayment: [],
              reverseCharge: result.reverseChargeEvents,
              reverseChargeInput: result.reverseChargeInputEvents,
            })
          : null,
      reverseChargePendingItems: result.reverseChargePendingItems,
      reverseChargeNonBusinessCents: result.reverseChargeNonBusinessCents,
      reverseChargeForeignCurrencyItems: foreignCurrencyReverseCharge.size,
      settlements: settlementFacts
        .map((s, index) => ({ ...s, date: storedSettlements[index].settledOn, ...(s.date !== storedSettlements[index].settledOn ? { countsOn: s.date } : {}) }))
        .filter((s) => (s.countsOn ?? s.date).startsWith(`${year}-`)),
    },
    yearBoundary: [
      ...wholeReceipts.flatMap((r, index): YearBoundaryEntry[] => {
        const f = facts[index];
        const cashDay = cashDayOf(f);
        const boundary = receiptBoundary.get(f.record.rowId);
        const otherYear = otherYearOf(cashDay);
        if (!boundary || cashDay === null || otherYear === null || !touchesYear(cashDay, year)) return [];
        // A meal or an asset without an earlier answer is not asked about.
        if (boundary.inactive !== null && boundary.decision.storedAnswer === null) return [];
        return [
          {
            kind: 'receipt',
            subjectId: f.record.rowId,
            label: r.item.vendor || r.item.label,
            cashDay,
            dayBasis: f.paid ? 'payment' : 'document',
            cents: r.item.amountCents,
            otherYear,
            ...boundary.decision,
            inactive: boundary.inactive,
          },
        ];
      }),
      ...storedSettlements.flatMap((s): YearBoundaryEntry[] => {
        const otherYear = otherYearOf(s.settledOn);
        const decision = settlementBoundary.get(s.id);
        if (otherYear === null || !decision || !touchesYear(s.settledOn, year)) return [];
        return [
          {
            kind: 'vat_settlement',
            subjectId: s.id,
            label: s.direction === 'refunded' ? 'Umsatzsteuer: Erstattung vom Finanzamt' : 'Umsatzsteuer: Zahlung an das Finanzamt',
            cashDay: s.settledOn,
            dayBasis: 'payment',
            cents: s.cents,
            otherYear,
            ...decision,
            inactive: null,
          },
        ];
      }),
    ].sort((a, b) => (a.cashDay < b.cashDay ? -1 : a.cashDay > b.cashDay ? 1 : a.label.localeCompare(b.label, 'de'))),
    payments: paymentsView,
    assets,
    assetLimits: {
      lowValueNetLimitCents: rules.assets.lowValueNetLimitCents.value,
      poolMinExclusiveNetCents: rules.assets.pool.value.minExclusiveNetCents,
      poolMaxNetCents: rules.assets.pool.value.maxNetCents,
      poolYears: rules.assets.pool.value.years,
      decliningFrom: rules.assets.declining.value.acquiredFrom,
      decliningTo: rules.assets.declining.value.acquiredTo,
      decliningMaxRateBp: rules.assets.declining.value.maxRateBp,
      decliningMaxMultiple: rules.assets.declining.value.maxMultipleOfLinear,
    },
    businessRevenueCents: result.businessRevenueCents,
    vendorRules,
    reverseChargeVendors: reverseChargeEntries
      .filter((e) => e.scope === 'vendor')
      .map((e) => ({ id: e.id, label: e.label, vendorKey: e.subject, effectiveFrom: e.effectiveFrom, rateBp: e.rateBp })),
    initialized: loaded !== null,
    incomeTax,
  };
}

export interface PaymentProposal {
  target: 'receipt' | 'invoice';
  targetId: string;
  label: string;
  /** How a payment matches a document, or, for money back, how it matches the purchase it refunds. */
  strength: MatchStrength | RefundStrength;
}

export interface OpenPayment {
  id: string;
  bookingDay: string;
  /** Signed cents, and what of it is not linked to anything yet (positive). */
  amountCents: number;
  freeCents: number;
  counterparty: string;
  reference: string;
  kind: PaymentKind;
  accountLabel: string;
  /** Why it needs a person. */
  check: 'payment_without_document' | 'income_without_invoice' | 'refund_without_receipt';
  proposals: PaymentProposal[];
  /**
   * The counterparty names a payment service one of the accounts holds, but
   * the funding rule did not make it a transfer (outside the days the list
   * covers, no matching purchase, or a person said so): a person can say it is one.
   */
  namesService: boolean;
  /** For a payment in another currency: its own amount, and whether the euro amount is an estimate. */
  foreign?: ForeignAmount | null;
}

/** A payment the funding rule made a transfer between own accounts. Listed so a person can say it is a purchase after all. */
export interface RuleTransfer {
  id: string;
  bookingDay: string;
  amountCents: number;
  counterparty: string;
  reference: string;
  accountLabel: string;
  /** True when the service's list holds the purchase this payment pays. */
  hasTwin: boolean;
  /** A collection after the end of the service's list, waiting for the next list (see `funding.ts`). */
  awaitingList: boolean;
  /** The receipts this payment is linked to: a link on a transfer keeps counting for its receipt unless the purchase it funds is linked there too. */
  linkedTo: string[];
  foreign?: ForeignAmount | null;
}

/**
 * What the funding rule hides against what the service's own list holds, for
 * one service and one year: the debits the other accounts show for the service
 * and the purchases its list states, month by month.
 */
export interface Reconciliation {
  service: string;
  serviceKind: ServiceKind;
  /** The accounts that hold the service's list. */
  accountLabels: string[];
  months: Array<{ month: string; collectedCents: number; listedCents: number; differenceCents: number; runningCents: number }>;
  collectedCents: number;
  listedCents: number;
  /**
   * Of a pay-later service, what earlier years listed and the bank had not collected by their end
   * (instalments, a purchase of late December): collected in this year, so it is no gap here. Counted
   * from the first month a collection shows, because before it the bank's own lines are not imported.
   */
  carriedCents: number;
  /**
   * Of a pay-later service, what its list holds from the last `PAY_LATER_TERM_DAYS` days before it ends
   * in this year, or before this year ends when the list goes on: purchases not due yet in the year, so
   * collected less by up to this much is no gap.
   */
  notDueCents: number;
  /** Of a pay-later service, the collections of the year after the end of its list, waiting for the next list: left out of `collectedCents`. */
  awaitingCents: number;
  /** Collected less listed over the year, less what earlier years carried over. */
  differenceCents: number;
  /** The difference of the year stays within the tolerance (for a wallet: no more collected than listed plus the tolerance). */
  reconciles: boolean;
  toleranceCents: number;
}

/** The difference a reconciliation may show before it is called out: one euro or one percent of what the list states. */
export function reconciliationTolerance(listedCents: number): number {
  return Math.max(100, Math.round(listedCents / 100));
}

/** A payment proposed for a receipt whose euro amount is an estimate (see `proposeEstimateMatches`). */
export interface EstimateProposalView {
  paymentId: string;
  rowId: string;
  receiptLabel: string;
  receiptDay: string;
  /** What the receipt counts with today, converted at the reference rate. */
  estimateCents: number;
  bookingDay: string;
  /** What was actually paid, as a positive number. */
  paidCents: number;
  counterparty: string;
  accountLabel: string;
  /** False when the receipt has several such payments or the payment fits several receipts: offered, never taken in bulk. */
  unambiguous: boolean;
  /** The payment looks like one sum for this receipt and another of the vendor: shown, not accepted in one click; a person splits it by hand. */
  severalReceipts: boolean;
}

export interface PaymentsView {
  accounts: LoadedPayments['accounts'];
  /** Payments booked in the year, and how many of them are linked to a document. */
  yearCount: number;
  linkedCount: number;
  /** Payments of the year that only move money between the owner's own accounts: nothing is asked about them. */
  transferCount: number;
  /** Counterparties of the year nobody has said anything about yet, largest first. */
  unclassified: Array<{ key: string; label: string; count: number; outCents: number; inCents: number }>;
  treatments: Array<{ key: string; label: string; treatment: CounterpartyTreatment }>;
  /** Business payments without a document and money received without an invoice. */
  open: OpenPayment[];
  /** Receipts of the year on an estimated euro amount, with the payment that looks like theirs. */
  estimateProposals: EstimateProposalView[];
  /** Payments of the year a person re-labelled (private, refund, a transfer or no transfer), so each can be put back. */
  overridden: Array<{ id: string; bookingDay: string; amountCents: number; counterparty: string; kind: PaymentKind }>;
  /** Payments of the year the funding rule made a transfer, newest first, and what they add up to (money out less money in). */
  ruleTransfers: RuleTransfer[];
  ruleTransferCents: number;
  /** Per service with such transfers in the year: what was collected against what its list states. */
  reconciliations: Reconciliation[];
  /** Purchases of the year a later import listed as cancelled or refunded in full, with the receipts their links were released from. */
  cancelled: Array<{ id: string; bookingDay: string; amountCents: number; counterparty: string; accountLabel: string; releasedFrom: string[] }>;
  /**
   * What a payment can be linked to by hand: receipts of the year and of the
   * year before that no payment is linked to yet (a December receipt is often
   * paid in January), and invoices with something still open.
   */
  receiptTargets: Array<{ id: string; label: string; day: string | null; amountCents: number | null; linkedCents: number }>;
  invoiceTargets: Array<{ id: string; label: string; openCents: number }>;
  /** Links of the year, so each can be taken back. */
  links: Array<{
    linkId: string;
    paymentId: string;
    bookingDay: string;
    cents: number;
    counterparty: string;
    target: 'receipt' | 'invoice';
    /** The receipt the payment is linked to; null for an issued invoice. */
    rowId: string | null;
    targetLabel: string;
    method: string;
    /** False when the purchase this debit funds is linked to the same receipt: the same money, counted there. */
    counts: boolean;
  }>;
}

/** Payment providers that stand for many shops: money back from them names its shop only by a number. */
const PAYMENT_INTERMEDIARIES = new Set(['paypal', 'klarna', 'stripe', 'adyen', 'sumup', 'mollie']);

function buildPaymentsView(
  loaded: LoadedPayments,
  year: number,
  resolved: ResolvedItem[],
  invoices: InvoiceFact[],
  invoiceResults: Array<{ invoiceId: string; outstandingCents: number }>,
): PaymentsView {
  const inYear = loaded.payments.filter((p) => p.bookingDay.startsWith(`${year}-`));
  const accountLabel = new Map(loaded.accounts.map((a) => [a.id, a.label]));
  const itemById = new Map(resolved.map((r) => [r.item.id, r.item]));
  const invoiceById = new Map(invoices.map((i) => [i.id, i]));
  const free = (p: PaymentRow) => Math.abs(p.amountCents) - p.links.reduce((s, l) => s + l.cents, 0);

  // Money in from a counterparty nobody answered yet is asked about once, in the
  // counterparty question, unless it already looks like the payment of an issued
  // invoice: then it is offered for that invoice right away.
  const outstanding = new Map(invoiceResults.map((i) => [i.invoiceId, i.outstandingCents]));
  const invoiceDocuments = invoices.map((i) => ({ id: i.id, number: i.number, day: i.issueDate, openCents: outstanding.get(i.id) ?? 0 }));
  const asMatch = (p: PaymentRow) => ({ id: p.id, bookingDay: p.bookingDay, amountCents: p.amountCents, reference: p.reference, counterparty: p.counterparty });
  // A counterparty answered mixed is asked nothing in general, but a payment of its that pays an invoice still is.
  const incomeCandidates = inYear.filter((p) => {
    const treatment = loaded.treatments.get(p.counterpartyKey);
    return p.kind === 'income' && free(p) > 0 && treatment !== 'private' && treatment !== 'own_account';
  });
  const incomeProposals = proposeMatches(incomeCandidates.map(asMatch), invoiceDocuments);
  const looksLikeInvoicePayment = new Set(incomeProposals.map((x) => x.paymentId));
  // Money back proposed for the receipt of the purchase it refunds (see `refunds.ts`): money in of the
  // year, refund or income, from a counterparty a receipt carries a purchase from or names as vendor.
  const purchasesByRow = new Map<string, RefundTarget['purchases']>();
  for (const { payment, link } of countedReceiptLinks(loaded.payments)) {
    if (payment.amountCents >= 0) continue;
    const list = purchasesByRow.get(link.rowId) ?? [];
    list.push({ bookingDay: payment.bookingDay, cents: link.cents, counterpartyKey: payment.counterpartyKey, reference: payment.reference });
    purchasesByRow.set(link.rowId, list);
  }
  // A payment service or a payment provider stands for many shops: from it only a shared number proposes a receipt.
  const heldNames = new Set(loaded.accounts.flatMap((a) => heldService({ id: a.id, kind: a.kind, formats: a.batches.map((b) => b.format), services: a.batches.map((b) => b.service) })?.name ?? []));
  const namesService = (p: PaymentRow) => p.counterpartyKey.split(' ').some((word) => heldNames.has(word));
  const intermediary = (p: PaymentRow) => namesService(p) || p.counterpartyKey.split(' ').some((word) => PAYMENT_INTERMEDIARIES.has(word));
  const refundTargets: RefundTarget[] = resolved
    .filter((r) => !r.isMeal && r.item.amountCents !== null && r.item.amountCents > 0)
    .map((r) => ({ rowId: r.item.id, day: r.item.date, vendorKey: r.vendorKey, remainingCents: r.item.amountCents as number, purchases: purchasesByRow.get(r.item.id) ?? [] }));
  const refundProposals = proposeRefunds(
    inYear
      .filter((p) => p.amountCents > 0 && (p.kind === 'refund' || p.kind === 'income') && Math.abs(p.amountCents) === free(p))
      .map((p) => ({ id: p.id, bookingDay: p.bookingDay, amountCents: p.amountCents, counterpartyKey: p.counterpartyKey, reference: p.reference, kind: p.kind as 'refund' | 'income', intermediary: intermediary(p) })),
    refundTargets,
    // A number is an order's only when no other purchase of the counterparty carries it, linked or not.
    countOrderNumbers(
      loaded.payments
        .filter((p) => p.amountCents < 0 && p.counterpartyKey)
        .map((p) => ({ counterpartyKey: p.counterpartyKey, reference: p.reference, group: p.links.find((l) => l.rowId)?.rowId ?? `payment:${p.id}` })),
    ),
  );
  const refundProposalIds = new Set(refundProposals.map((x) => x.paymentId));

  // What needs a document: money out to a business counterparty, and money in
  // from a business counterparty or for an invoice. Payments on an account said
  // to be private as a whole are kind `private` and never asked about.
  const needing = inYear.filter((p) => {
    if (free(p) === 0) return false;
    const treatment = loaded.treatments.get(p.counterpartyKey);
    // Money out to a business counterparty, and money out with no name at all
    // (there is nobody to ask about once, so each such payment is asked about).
    if (p.kind === 'spend') return treatment === 'business' || !p.counterpartyKey;
    if (p.kind === 'income') return treatment === 'business' || ((treatment === undefined || treatment === 'mixed') && (!p.counterpartyKey || looksLikeInvoicePayment.has(p.id) || refundProposalIds.has(p.id)));
    // Money back from a business counterparty belongs on the receipt it refunds.
    // So does money a pay-later service pays back: its list holds no refunds, the bank line is the only record.
    // And money back from anyone a receipt carries a purchase from: it is proposed for that receipt.
    if (p.kind === 'refund') return treatment === 'business' || !p.counterpartyKey || p.byRule || (treatment !== 'private' && treatment !== 'own_account' && refundProposalIds.has(p.id));
    return false;
  });

  // Counterparties without an answer, by what moved (own transfers and fees ask nothing).
  const unclassified = new Map<string, { key: string; label: string; count: number; outCents: number; inCents: number }>();
  // A payment already asked about on its own (an invoice's payment, money back with a proposal) is not counted here too.
  const askedAlone = new Set(needing.map((p) => p.id));
  for (const p of inYear) {
    if (askedAlone.has(p.id)) continue;
    // Money back from a pay-later service is asked about payment by payment, not once for the service.
    if (p.kind === 'own_transfer' || p.kind === 'fee' || p.kind === 'private' || p.byRule || !p.counterpartyKey || loaded.treatments.has(p.counterpartyKey) || free(p) === 0) continue;
    const entry = unclassified.get(p.counterpartyKey) ?? { key: p.counterpartyKey, label: p.counterparty, count: 0, outCents: 0, inCents: 0 };
    entry.count += 1;
    if (p.amountCents < 0) entry.outCents += -p.amountCents;
    else entry.inCents += p.amountCents;
    unclassified.set(p.counterpartyKey, entry);
  }
  const counted = countedReceiptLinks(loaded.payments);
  const countedLinkIds = new Set(counted.map((c) => c.link.id));
  // What each receipt already carries, so the picker for linking by hand can say so.
  const linkedCentsByRow = new Map<string, number>();
  for (const { payment, link } of counted) linkedCentsByRow.set(link.rowId, (linkedCentsByRow.get(link.rowId) ?? 0) + (payment.amountCents < 0 ? link.cents : -link.cents));
  // A receipt also paid on a payment another company shares with this one (plan 2026-10-22): linked, never proposed again.
  for (const [rowId, cents] of loaded.linkedElsewhere) linkedCentsByRow.set(rowId, (linkedCentsByRow.get(rowId) ?? 0) + cents);
  const linkedRows = new Set([...loaded.payments.flatMap((p) => p.links.map((l) => l.rowId).filter((id): id is string => id !== null)), ...loaded.linkedElsewhere.keys()]);
  const receiptDocuments = resolved
    .filter((r) => !r.isMeal && !linkedRows.has(r.item.id) && r.item.amountCents !== null && r.item.date !== null && r.item.date.startsWith(`${year}-`))
    .map((r) => ({ id: r.item.id, number: null, day: r.item.date, openCents: r.item.amountCents as number, vendorKey: r.vendorKey }));
  // Candidates for linking by hand: also last year's receipts, and receipts that
  // already have a payment (a refund goes on the receipt its purchase is linked to).
  const receiptTargets = resolved
    .filter((r) => !r.isMeal && (r.item.date === null || r.item.date.startsWith(`${year}-`) || r.item.date.startsWith(`${year - 1}-`)))
    .map((r) => ({ id: r.item.id, label: r.item.label, day: r.item.date, amountCents: r.item.amountCents, linkedCents: linkedCentsByRow.get(r.item.id) ?? 0 }))
    .sort((a, b) => ((a.day ?? '') < (b.day ?? '') ? 1 : -1));
  const spendProposals = proposeMatches(
    needing.filter((p) => p.kind === 'spend').map((p) => ({ ...asMatch(p), counterpartyKey: p.counterpartyKey, referenceKey: vendorKey(p.reference) ?? '' })),
    receiptDocuments,
  );

  // Receipts on an estimated amount. Every receipt without a link takes part
  // (a payment that also fits a euro receipt is not unambiguous), and every
  // unlinked payment out of any year that was not answered as private: the
  // vendor on a receipt is the evidence, so this does not wait for the
  // question about the counterparty.
  // Which vendors a counterparty stands for, learned from the links that exist: the pay-later list names the
  // product where the invoice names the company, and one link by hand pairs the two for every later proposal.
  // Derived from the links, so nothing is stored and taking the link back takes the pairing back.
  const vendorByRow = new Map(resolved.map((r) => [r.item.id, r.vendorKey]));
  const vendorsOfCounterparty = new Map<string, Set<string>>();
  for (const p of loaded.payments) {
    if (!p.counterpartyKey || p.amountCents >= 0) continue;
    for (const link of p.links) {
      const vendor = link.rowId ? vendorByRow.get(link.rowId) : null;
      if (vendor) vendorsOfCounterparty.set(p.counterpartyKey, (vendorsOfCounterparty.get(p.counterpartyKey) ?? new Set()).add(vendor));
    }
  }
  const estimateDocuments = resolved
    .filter((r) => !r.isMeal && !linkedRows.has(r.item.id) && r.item.amountCents !== null && r.item.date !== null)
    .map((r) => ({ id: r.item.id, vendorKey: r.vendorKey, day: r.item.date, amountCents: r.item.amountCents as number, estimated: r.item.amountBasis === 'reference_rate' }));
  const estimatePayments = loaded.payments
    .filter((p) => p.amountCents < 0 && p.kind === 'spend' && p.links.length === 0 && loaded.treatments.get(p.counterpartyKey) !== 'private')
    .map((p) => ({ id: p.id, bookingDay: p.bookingDay, amountCents: p.amountCents, counterpartyKey: p.counterpartyKey, referenceKey: vendorKey(p.reference) ?? '', vendorAliases: [...(vendorsOfCounterparty.get(p.counterpartyKey) ?? [])] }));
  const paymentById = new Map(loaded.payments.map((p) => [p.id, p]));
  const estimateProposals: EstimateProposalView[] = proposeEstimateMatches(estimatePayments, estimateDocuments)
    .flatMap((proposal) => {
      const item = itemById.get(proposal.documentId);
      const payment = paymentById.get(proposal.paymentId);
      if (!item || !payment || item.date === null || !item.date.startsWith(`${year}-`) || item.amountCents === null) return [];
      return [{
        paymentId: payment.id,
        rowId: item.id,
        receiptLabel: item.label,
        receiptDay: item.date,
        estimateCents: item.amountCents,
        bookingDay: payment.bookingDay,
        paidCents: -payment.amountCents,
        counterparty: payment.counterparty,
        accountLabel: accountLabel.get(payment.accountId) ?? '',
        unambiguous: proposal.unambiguous,
        severalReceipts: proposal.severalReceipts,
      }];
    })
    .sort((a, b) => (a.receiptDay === b.receiptDay ? (a.bookingDay < b.bookingDay ? -1 : 1) : a.receiptDay < b.receiptDay ? -1 : 1));

  const refundsFor = (p: PaymentRow): PaymentProposal[] =>
    refundProposals.filter((x) => x.paymentId === p.id).map((x) => ({ target: 'receipt' as const, targetId: x.rowId, label: itemById.get(x.rowId)?.label ?? 'Beleg', strength: x.strength }));
  const open: OpenPayment[] = needing.map((p) => ({
    id: p.id,
    bookingDay: p.bookingDay,
    amountCents: p.amountCents,
    freeCents: free(p),
    counterparty: p.counterparty,
    reference: p.reference,
    kind: p.kind,
    accountLabel: accountLabel.get(p.accountId) ?? '',
    check: p.kind === 'income' ? 'income_without_invoice' : p.kind === 'refund' ? 'refund_without_receipt' : 'payment_without_document',
    namesService: p.kind !== 'refund' && namesService(p),
    foreign: foreignAmount(p),
    proposals:
      p.kind === 'refund'
        ? refundsFor(p)
        : p.kind === 'income'
        ? [
            ...incomeProposals.filter((x) => x.paymentId === p.id).map((x) => ({ target: 'invoice' as const, targetId: x.documentId, label: `Rechnung ${invoiceById.get(x.documentId)?.number ?? ''}`, strength: x.strength })),
            // Money in that the file calls income can still be money back for a purchase (a card refund, a returned order).
            ...refundsFor(p),
          ]
        : spendProposals.filter((x) => x.paymentId === p.id).map((x) => ({ target: 'receipt' as const, targetId: x.documentId, label: itemById.get(x.documentId)?.label ?? 'Beleg', strength: x.strength })),
  }));

  // What the funding rule hides, so it can be seen and taken back.
  const ruled = inYear.filter((p) => p.byRule && p.kind === 'own_transfer');
  const ruleTransfers: RuleTransfer[] = ruled
    .map((p) => ({ id: p.id, bookingDay: p.bookingDay, amountCents: p.amountCents, counterparty: p.counterparty, reference: p.reference, accountLabel: accountLabel.get(p.accountId) ?? '', hasTwin: p.funding?.twinId != null, awaitingList: p.funding?.awaitingList === true, foreign: foreignAmount(p), linkedTo: p.links.flatMap((l) => (l.rowId ? [itemById.get(l.rowId)?.label ?? 'Beleg (nicht mehr vorhanden)'] : [])) }))
    .sort((a, b) => (a.bookingDay < b.bookingDay ? 1 : -1));
  const holderOf = new Map<string, { name: string; kind: ServiceKind }>();
  for (const a of loaded.accounts) {
    const service = heldService({ id: a.id, kind: a.kind, formats: a.batches.map((b) => b.format), services: a.batches.map((b) => b.service) });
    if (service) holderOf.set(a.id, service);
  }
  const reconciliations: Reconciliation[] = [];
  // All years: what an earlier year listed may be collected in this one (see `Reconciliation.carriedCents`).
  const ruledAll = loaded.payments.filter((p) => p.byRule && p.kind === 'own_transfer');
  const yearStart = `${year}-01`;
  const add = (map: Map<string, number>, month: string, cents: number) => map.set(month, (map.get(month) ?? 0) + cents);
  for (const service of new Map([...holderOf.values()].map((v) => [v.name, v])).values()) {
    const collected = new Map<string, number>();
    const listed = new Map<string, number>();
    const awaiting = new Map<string, number>();
    // What the OTHER accounts show leaving for the service; the wallet's own payout rows are not collections. A
    // collection waiting for its list pays purchases no list holds yet: counted apart, never against the list.
    for (const p of ruledAll) if (p.funding?.service === service.name && p.amountCents < 0 && holderOf.get(p.accountId)?.name !== service.name) add(p.funding.awaitingList ? awaiting : collected, p.bookingDay.slice(0, 7), -p.amountCents);
    // The wallet's own payout rows are no purchases, paired by the rule or not: a row without a name is a payout
    // (plan 2026-10-23-paypal-live, point 7). A row the rule pairs with ANOTHER service (a PayPal purchase on the
    // pay-later card) is still a purchase this service collects from the bank.
    const isPurchase = (p: (typeof loaded.payments)[number]) =>
      holderOf.get(p.accountId)?.name === service.name && p.amountCents < 0 && p.sourceKind === 'spend' && p.counterparty.trim() !== '' && !(p.byRule && p.funding?.service === service.name);
    for (const p of loaded.payments) if (isPurchase(p)) add(listed, p.bookingDay.slice(0, 7), -p.amountCents);
    const ofYear = (m: string) => m.startsWith(`${year}-`);
    if (![...collected.keys(), ...awaiting.keys()].some(ofYear)) continue;
    // A pay-later service collects every listed purchase, some only in a later year (instalments, a
    // purchase of late December): what earlier years listed beyond what they collected is collected now,
    // at most the purchases of their last `PAY_LATER_TERM_DAYS` days (older ones are due long since; a
    // purchase never collected stays a question in its own year, it is not carried on for ever). A
    // wallet also pays from its balance or a card, so nothing it listed is owed to the bank.
    const firstCollected = [...collected.keys(), ...awaiting.keys()].sort()[0];
    let carriedCents = 0;
    let notDueCents = 0;
    if (service.kind === 'pay_later') {
      const purchases = loaded.payments.filter(isPurchase);
      const termBefore = (day: string) => new Date(Date.parse(`${day}T00:00:00Z`) - PAY_LATER_TERM_DAYS * 86_400_000).toISOString().slice(0, 10);
      const listedBetween = (after: string, upTo: string) => purchases.filter((p) => p.bookingDay > after && p.bookingDay <= upTo).reduce((sum, p) => sum - p.amountCents, 0);
      for (const month of new Set([...collected.keys(), ...listed.keys()])) {
        if (month >= firstCollected && month < yearStart) carriedCents += (listed.get(month) ?? 0) - (collected.get(month) ?? 0);
      }
      // Collected beyond the lists of earlier years is no credit for this one: that stays a question there.
      const yearBefore = `${year - 1}-12-31`;
      carriedCents = Math.min(Math.max(0, carriedCents), listedBetween(termBefore(yearBefore), yearBefore));
      // The newest purchases are not due yet: those of the last days of the list, or of this year when the
      // list goes on past it (they are collected in the next year).
      const listEnd = purchases.reduce((max, p) => (p.bookingDay > max ? p.bookingDay : max), '');
      const until = listEnd > `${year}-12-31` ? `${year}-12-31` : listEnd;
      if (until.startsWith(`${year}-`)) notDueCents = listedBetween(termBefore(until), until);
    }
    const awaitingCents = [...awaiting].filter(([m]) => ofYear(m)).reduce((sum, [, c]) => sum + c, 0);
    let running = -carriedCents;
    const months = [...new Set([...collected.keys(), ...listed.keys()])].filter(ofYear).sort().map((month) => {
      const collectedCents = collected.get(month) ?? 0;
      const listedCents = listed.get(month) ?? 0;
      running += collectedCents - listedCents;
      return { month, collectedCents, listedCents, differenceCents: collectedCents - listedCents, runningCents: running };
    });
    const collectedCents = months.reduce((sum, m) => sum + m.collectedCents, 0);
    const listedCents = months.reduce((sum, m) => sum + m.listedCents, 0);
    const differenceCents = collectedCents - listedCents - carriedCents;
    const toleranceCents = reconciliationTolerance(listedCents + carriedCents);
    reconciliations.push({
      service: service.name,
      serviceKind: service.kind,
      accountLabels: loaded.accounts.filter((a) => holderOf.get(a.id)?.name === service.name).map((a) => a.label),
      months,
      collectedCents,
      listedCents,
      carriedCents,
      notDueCents,
      awaitingCents,
      differenceCents,
      // A wallet also pays from its balance or a card, so less collected than listed is its normal case;
      // what must not pass unseen is more collected than the list explains. A pay-later service collects
      // every listed purchase from the bank, so there both directions are called out, less what is not due yet.
      reconciles: service.kind === 'wallet' ? differenceCents <= toleranceCents : differenceCents <= toleranceCents && differenceCents >= -(toleranceCents + notDueCents),
      toleranceCents,
    });
  }

  // The name a counterparty was first seen under, looked up once for all rules.
  const labelByCounterparty = new Map<string, string>();
  for (const p of loaded.payments) if (!labelByCounterparty.has(p.counterpartyKey)) labelByCounterparty.set(p.counterpartyKey, p.counterparty);

  return {
    accounts: loaded.accounts,
    yearCount: inYear.length,
    linkedCount: inYear.filter((p) => p.links.length > 0).length,
    transferCount: inYear.filter((p) => p.kind === 'own_transfer').length,
    unclassified: [...unclassified.values()].sort((a, b) => b.outCents + b.inCents - (a.outCents + a.inCents)),
    treatments: [...loaded.treatments.entries()].map(([key, treatment]) => ({
      key,
      label: labelByCounterparty.get(key) ?? key,
      treatment,
    })),
    open,
    estimateProposals,
    overridden: inYear.filter((p) => p.kindOverridden).map((p) => ({ id: p.id, bookingDay: p.bookingDay, amountCents: p.amountCents, counterparty: p.counterparty, kind: p.kind })),
    ruleTransfers,
    ruleTransferCents: ruled.reduce((sum, p) => sum - p.amountCents, 0),
    reconciliations,
    cancelled: loaded.cancelled
      .filter((p) => p.bookingDay.startsWith(`${year}-`))
      .map((p) => ({ id: p.id, bookingDay: p.bookingDay, amountCents: p.amountCents, counterparty: p.counterparty, accountLabel: accountLabel.get(p.accountId) ?? '', releasedFrom: p.rowIds.map((rowId) => itemById.get(rowId)?.label ?? 'Beleg (nicht mehr vorhanden)') })),
    receiptTargets,
    invoiceTargets: invoiceDocuments.filter((d) => d.openCents > 0).map((d) => ({ id: d.id, label: `Rechnung ${d.number}`, openCents: d.openCents })),
    links: inYear.flatMap((p) =>
      p.links.map((l) => ({
        linkId: l.id,
        paymentId: p.id,
        bookingDay: p.bookingDay,
        cents: l.cents,
        counterparty: p.counterparty,
        target: l.rowId ? ('receipt' as const) : ('invoice' as const),
        rowId: l.rowId ?? null,
        targetLabel: l.rowId ? (itemById.get(l.rowId)?.label ?? 'Beleg (nicht mehr vorhanden)') : `Rechnung ${invoiceById.get(l.invoiceId ?? '')?.number ?? ''}`,
        method: l.method,
        counts: !l.rowId || countedLinkIds.has(l.id),
      })),
    ),
  };
}

export interface AcceptedProposals {
  /** The pairs that were linked, exactly. */
  linked: Array<{ paymentId: string; rowId: string }>;
  /** Pairs that were asked for and are no proposal any more (linked elsewhere, or no longer unambiguous). */
  skipped: number;
}

/**
 * Accept proposals for receipts on an estimated amount: one ("Übernehmen") or
 * all unambiguous ones. `pairs` is what the person saw and confirmed. Linked
 * is only what is in that list AND still a proposal when worked out again from
 * what is stored (with `onlyUnambiguous`, still an unambiguous one), so
 * nothing the person did not see is linked and nothing stale either. All
 * links are written in one transaction that checks each pair once more
 * (`linkProposals`), which makes a second tab or a second press harmless.
 * The answer says exactly what was linked.
 */
export async function acceptEstimateProposals(db: PrismaClient, ctx: PaymentContext, year: number, pairs: unknown, onlyUnambiguous: boolean): Promise<AcceptedProposals> {
  const wanted = (Array.isArray(pairs) ? pairs : []).flatMap((pair) => {
    const p = (pair ?? {}) as { paymentId?: unknown; rowId?: unknown };
    return typeof p.paymentId === 'string' && typeof p.rowId === 'string' ? [`${p.paymentId}|${p.rowId}`] : [];
  });
  if (wanted.length === 0 || wanted.length > 2000) throw new PaymentServiceError('invalid_link');
  const view = await loadStatement(db, ctx.workspaceId, year);
  // A payment that looks like one sum for several receipts is never accepted in one click.
  const current = view.payments.estimateProposals.filter((p) => wanted.includes(`${p.paymentId}|${p.rowId}`) && !p.severalReceipts && (!onlyUnambiguous || p.unambiguous));
  // One transaction for all of them; the rows come from this workspace's own statement.
  const linked = await linkProposals(db, ctx, current.map((p) => ({ paymentId: p.paymentId, rowId: p.rowId })));
  return { linked, skipped: new Set(wanted).size - linked.length };
}

/** True when the row is a receipt of this workspace. */
export async function isWorkspaceReceipt(db: PrismaClient, workspaceId: string, rowId: string): Promise<boolean> {
  const loaded = await loadReceipts(db, workspaceId, rowId);
  return (loaded?.facts.length ?? 0) > 0;
}

/**
 * How the payment service checks a link target: null when the row is no
 * receipt of this workspace, otherwise the receipt's own euro amount (the
 * document's, or the reference-rate estimate), which is what its payments are
 * measured against.
 */
export function receiptForLink(db: PrismaClient, workspaceId: string): ReceiptForLink {
  return async (rowId) => {
    const loaded = await loadReceipts(db, workspaceId, rowId);
    const facts = loaded?.facts[0];
    if (!facts) return null;
    return { amountCents: resolveItem({ ...facts, countsOnDay: null }, [], await getTaxSettings(db, workspaceId)).item.amountCents };
  };
}

/** The ISO day "today" in the business's time zone; one place, so tests can see what the forecast used. */
function today(): string {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Berlin' }).format(new Date());
}

/**
 * The stored groups of a mixed invoice. Stored groups were checked on save; a
 * value that no longer parses is read as no groups: the invoice then keeps its
 * stated tax under no rate and carries the check `invoice_tax_groups_unreadable`.
 */
function storedTaxGroups(raw: unknown): TaxGroup[] | null {
  if (raw === null || raw === undefined) return null;
  return parseTaxGroups(raw);
}

/** An issued invoice as the finance screens show it for one year. */
export interface InvoiceView {
  id: string;
  number: string;
  issueDate: string | null;
  grossCents: number;
  vatCents: number;
  treatment: InvoiceTreatment;
  /** For an invoice with more than one rate: its groups, highest rate first. */
  taxGroups: TaxGroup[] | null;
  declaredInYear: number | null;
  /** Every payment of the invoice, whatever year: typed in and linked from the bank. */
  payments: Array<{ date: string; cents: number }>;
  /** Only the payments typed in on the invoice; the bank payments linked to it are changed on the payments tab. */
  enteredPayments: Array<{ date: string; cents: number }>;
  /** Booked out as never to be paid, and its day. */
  writtenOffCents: number;
  writtenOffOn: string | null;
  /** Received in the viewed year, and what of that a return declared by invoice already counted. */
  receivedCents: number;
  excludedCents: number;
  /** Counted in the viewed year at the invoice amount, because its return declared the invoice by invoice. */
  declaredCents: number;
  outstandingCents: number;
  checks: InvoiceCheckKind[];
}

/** Record an issued invoice (`invoiceId` null) or change one, payments included. Returns its id. */
export async function saveInvoice(db: PrismaClient, ctx: TaxContext, invoiceId: string | null, raw: unknown): Promise<string> {
  const input = validateInvoiceInput(raw);
  const sameNumber = await db.taxIssuedInvoice.findFirst({ where: { authWorkspaceId: ctx.workspaceId, number: input.number } });
  if (sameNumber && sameNumber.id !== invoiceId) throw new TaxServiceError('invoice_number_taken');
  const data = {
    number: input.number,
    issueDate: input.issueDate,
    grossCents: input.grossCents,
    vatCents: input.vatCents,
    treatment: input.treatment,
    // Prisma needs DbNull, not null, to clear a JSON column.
    taxGroups: input.taxGroups === null ? Prisma.DbNull : (input.taxGroups as unknown as Prisma.InputJsonValue),
    declaredInYear: input.declaredInYear,
    writtenOffCents: input.writtenOffCents,
    writtenOffOn: input.writtenOffOn,
  };
  const payments = input.payments.map((p) => ({ paidOn: p.date, cents: p.cents, authWorkspaceId: ctx.workspaceId, authTenantId: ctx.tenantId }));
  if (invoiceId === null) {
    const created = await db.taxIssuedInvoice.create({
      data: { authWorkspaceId: ctx.workspaceId, authTenantId: ctx.tenantId, ...data, payments: { create: payments } },
    });
    return created.id;
  }
  const existing = await db.taxIssuedInvoice.findFirst({ where: { id: invoiceId, authWorkspaceId: ctx.workspaceId } });
  if (!existing) throw new TaxServiceError('invoice_not_found');
  // The payments of an invoice are few and have no identity of their own, so a
  // save replaces them as one set, together with the invoice or not at all. The
  // invoice row is locked as linking a bank payment locks it, so a link made at
  // the same moment cannot push what is booked out past what is open.
  await db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM tax_issued_invoices WHERE id = ${invoiceId} AND auth_workspace_id = ${ctx.workspaceId} FOR UPDATE`;
    if (input.writtenOffCents > 0) {
      // What is booked out cannot exceed what the typed-in and the linked bank payments leave open.
      const linked = await tx.taxPaymentLink.aggregate({ where: { invoiceId, authWorkspaceId: ctx.workspaceId, payment: { cancelledByBatchId: null } }, _sum: { cents: true } });
      const typed = input.payments.reduce((sum, p) => sum + p.cents, 0);
      if (input.writtenOffCents > input.grossCents - typed - (linked._sum.cents ?? 0)) throw new TaxServiceError('invalid_write_off');
    }
    await tx.taxInvoicePayment.deleteMany({ where: { invoiceId } });
    await tx.taxIssuedInvoice.update({ where: { id: invoiceId }, data });
    await tx.taxInvoicePayment.createMany({ data: payments.map((p) => ({ ...p, invoiceId })) });
  });
  return invoiceId;
}

export async function deleteInvoice(db: PrismaClient, ctx: TaxContext, invoiceId: string): Promise<void> {
  const { count } = await db.taxIssuedInvoice.deleteMany({ where: { id: invoiceId, authWorkspaceId: ctx.workspaceId } });
  if (count === 0) throw new TaxServiceError('invoice_not_found');
}

/**
 * Record that the section 19 status changes from a day on. The first answer
 * must exist (it is the status "from the beginning"); a change on a day that
 * already has one corrects that entry.
 */
export async function saveStatusChange(db: PrismaClient, ctx: TaxContext, raw: unknown): Promise<void> {
  const input = validateStatusChange(raw);
  const settings = await db.workspaceTaxSettings.findUnique({ where: { authWorkspaceId: ctx.workspaceId } });
  if (!settings || settings.smallBusiness === null) throw new TaxServiceError('status_unanswered');
  await db.taxStatusChange.upsert({
    where: { authWorkspaceId_effectiveFrom: { authWorkspaceId: ctx.workspaceId, effectiveFrom: input.effectiveFrom } },
    create: { authWorkspaceId: ctx.workspaceId, authTenantId: ctx.tenantId, ...input },
    update: { smallBusiness: input.smallBusiness },
  });
}

export async function deleteStatusChange(db: PrismaClient, ctx: TaxContext, changeId: string): Promise<void> {
  const { count } = await db.taxStatusChange.deleteMany({ where: { id: changeId, authWorkspaceId: ctx.workspaceId } });
  if (count === 0) throw new TaxServiceError('status_not_found');
}

/** How often a value-added tax return is filed and when the tax on an invoice is owed. */
export async function saveVatSettings(db: PrismaClient, ctx: TaxContext, raw: unknown): Promise<void> {
  const input = validateVatSettings(raw);
  await db.workspaceTaxSettings.upsert({
    where: { authWorkspaceId: ctx.workspaceId },
    create: { authWorkspaceId: ctx.workspaceId, authTenantId: ctx.tenantId, vatFrequency: input.frequency, vatMethod: input.method },
    update: { vatFrequency: input.frequency, vatMethod: input.method },
  });
}

/** What the owner expects to receive per month from now on (null: use the run rate). */
export async function saveRevenueExpectation(db: PrismaClient, ctx: TaxContext, raw: unknown): Promise<void> {
  const cents = validateExpectation(raw);
  await db.workspaceTaxSettings.upsert({
    where: { authWorkspaceId: ctx.workspaceId },
    create: { authWorkspaceId: ctx.workspaceId, authTenantId: ctx.tenantId, expectedMonthlyRevenueCents: cents },
    update: { expectedMonthlyRevenueCents: cents },
  });
}

export async function saveVatSettlement(db: PrismaClient, ctx: TaxContext, raw: unknown): Promise<string> {
  const input = validateSettlement(raw);
  const row = await db.taxVatSettlement.create({
    data: { authWorkspaceId: ctx.workspaceId, authTenantId: ctx.tenantId, settledOn: input.date, cents: input.cents, direction: input.direction },
  });
  return row.id;
}

export async function deleteVatSettlement(db: PrismaClient, ctx: TaxContext, settlementId: string): Promise<void> {
  const { count } = await db.taxVatSettlement.deleteMany({ where: { id: settlementId, authWorkspaceId: ctx.workspaceId } });
  if (count === 0) throw new TaxServiceError('settlement_not_found');
  await db.taxYearBoundaryAnswer.deleteMany({ where: { authWorkspaceId: ctx.workspaceId, subjectKind: 'vat_settlement', subjectId: settlementId } });
}

/** The day a subject of the ten-day rule was paid, or why it cannot be asked about. */
async function boundaryCashDay(db: PrismaClient, ctx: TaxContext, kind: BoundarySubjectKind, subjectId: string): Promise<string> {
  let cashDay: string | null;
  if (kind === 'vat_settlement') {
    const settlement = await db.taxVatSettlement.findFirst({ where: { id: subjectId, authWorkspaceId: ctx.workspaceId } });
    if (!settlement) throw new TaxServiceError('boundary_subject_not_found');
    cashDay = settlement.settledOn;
  } else {
    const loaded = await loadReceipts(db, ctx.workspaceId, subjectId);
    if (!loaded) throw new TaxServiceError('not_initialized');
    const facts = loaded.facts[0];
    if (!facts) throw new TaxServiceError('boundary_subject_not_found');
    if (resolveItem(facts, [], await getTaxSettings(db, ctx.workspaceId)).isMeal) throw new TaxServiceError('meal_row');
    if ((await db.taxAssetPart.count({ where: { authWorkspaceId: ctx.workspaceId, rowId: subjectId } })) > 0) throw new TaxServiceError('asset_row');
    cashDay = (await paymentDayOfRow(db, ctx, subjectId)) ?? facts.record.date;
  }
  if (otherYearOf(cashDay) === null) throw new TaxServiceError('not_in_year_boundary');
  return cashDay as string;
}

export interface YearBoundaryInput {
  kind: BoundarySubjectKind;
  subjectId: string;
  /** The payment day the person saw when answering; the answer is refused when it has changed since. */
  cashDay: string;
  /** True: counts in the other year. False: stays in the year it was paid. Null: take the answer back. */
  belongsToOtherYear: boolean | null;
}

function validateBoundaryInput(raw: unknown): YearBoundaryInput {
  const input = (raw ?? {}) as { kind?: unknown; subjectId?: unknown; cashDay?: unknown; belongsToOtherYear?: unknown };
  if (typeof input.kind !== 'string' || !(BOUNDARY_SUBJECT_KINDS as readonly string[]).includes(input.kind)) throw new TaxServiceError('boundary_subject_not_found');
  if (typeof input.subjectId !== 'string' || !input.subjectId) throw new TaxServiceError('boundary_subject_not_found');
  if (input.belongsToOtherYear !== null && typeof input.belongsToOtherYear !== 'boolean') throw new TaxServiceError('boundary_subject_not_found');
  // Taking an answer back needs no day; giving one does.
  if (input.belongsToOtherYear !== null && (typeof input.cashDay !== 'string' || otherYearOf(input.cashDay) === null)) throw new TaxServiceError('not_in_year_boundary');
  return { kind: input.kind as BoundarySubjectKind, subjectId: input.subjectId, cashDay: typeof input.cashDay === 'string' ? input.cashDay : '', belongsToOtherYear: input.belongsToOtherYear };
}

/**
 * Answer the ten-day rule for one payment at the turn of the year. The answer
 * is stored with the payment day it was given for: when the receipt is linked
 * to another payment, or the settlement's day changes, the question comes
 * back. An answer given on a screen that showed another payment day than the
 * current one is refused, so nobody answers for a day they did not see. An
 * answer that would move a payment across a year whose return is filed is
 * refused as well: the filed year fixes its turn (`year-boundary.ts`).
 */
export async function saveYearBoundaryAnswer(db: PrismaClient, ctx: TaxContext, raw: unknown): Promise<void> {
  const input = validateBoundaryInput(raw);
  const key = { authWorkspaceId: ctx.workspaceId, subjectKind: input.kind, subjectId: input.subjectId };
  if (input.belongsToOtherYear === null) {
    // Taking an answer back needs no check: it also clears an answer that has no effect any more.
    await db.taxYearBoundaryAnswer.deleteMany({ where: key });
    return;
  }
  const cashDay = await boundaryCashDay(db, ctx, input.kind, input.subjectId);
  if (cashDay !== input.cashDay) throw new TaxServiceError('year_boundary_changed');
  if (input.belongsToOtherYear) {
    const years = [Number(cashDay.slice(0, 4)), otherYearOf(cashDay) as number];
    const filed = await db.taxYearSettings.count({ where: { authWorkspaceId: ctx.workspaceId, year: { in: years }, filedOn: { not: null } } });
    if (filed > 0) throw new TaxServiceError('year_boundary_filed');
  }
  await db.taxYearBoundaryAnswer.upsert({
    where: { authWorkspaceId_subjectKind_subjectId: key },
    create: { ...key, authTenantId: ctx.tenantId, cashDay, belongsToOtherYear: input.belongsToOtherYear },
    update: { cashDay, belongsToOtherYear: input.belongsToOtherYear },
  });
}

/**
 * "None of these recurs": the payments the person saw without an answer stay
 * in the year they were paid. Only entries that are still open (neither a
 * person nor a filed year nor a rule answered), on the day the person saw, are
 * answered; all of them together or none.
 */
export async function declineOpenYearBoundary(db: PrismaClient, ctx: TaxContext, year: number, raw: unknown): Promise<number> {
  if (!Array.isArray(raw) || raw.length > 500) throw new TaxServiceError('boundary_subject_not_found');
  const seen = new Set(
    raw.map((r) => {
      const e = (r ?? {}) as { kind?: unknown; subjectId?: unknown; cashDay?: unknown };
      return `${String(e.kind)}:${String(e.subjectId)}:${String(e.cashDay)}`;
    }),
  );
  const view = await loadStatement(db, ctx.workspaceId, year);
  const open = view.yearBoundary.filter((e) => e.source === null && e.inactive === null && seen.has(`${e.kind}:${e.subjectId}:${e.cashDay}`));
  // What was on the screen and is not open on that day any more was changed elsewhere: say so instead of answering half.
  if (open.length !== seen.size) throw new TaxServiceError('year_boundary_changed');
  await db.$transaction(
    open.map((e) => {
      const key = { authWorkspaceId: ctx.workspaceId, subjectKind: e.kind, subjectId: e.subjectId };
      return db.taxYearBoundaryAnswer.upsert({
        where: { authWorkspaceId_subjectKind_subjectId: key },
        create: { ...key, authTenantId: ctx.tenantId, cashDay: e.cashDay, belongsToOtherYear: false },
        update: { cashDay: e.cashDay, belongsToOtherYear: false },
      });
    }),
  );
  return open.length;
}

/** An asset as the finance screens show it for one year. */
export interface AssetView {
  id: string;
  label: string;
  kind: AssetKind;
  acquisitionDate: string | null;
  method: AssetMethod;
  usefulLifeMonths: number | null;
  decliningRateBp: number | null;
  businessShareBp: number;
  /** The study or employment share and its employment annex line. */
  annexShareBp: number;
  annexLineKey: FormLineKey | null;
  reminderCents: number;
  opening: AssetFact['opening'];
  disposal: AssetFact['disposal'];
  /** The sum of the linked receipts; null when one of them has no usable amount, or there are none. */
  costCents: number | null;
  netCostCents: number | null;
  /** The receipts and receipt lines that make up the cost, as item ids. */
  itemIds: string[];
  counted: boolean;
  checks: AssetCheck[];
  /** This year's row of the schedule, before the business share. */
  row: AssetYearRow | null;
  parts: Array<{ lineKey: FormLineKey; cents: number }>;
  schedule: AssetYearRow[];
}

interface StoredAsset {
  id: string;
  label: string;
  kind: string;
  acquisitionDate: string | null;
  method: string;
  usefulLifeMonths: number | null;
  decliningRateBp: number | null;
  businessShareBp: number;
  annexShareBp: number;
  annexLineKey: string | null;
  reminderCents: number;
  openingYear: number | null;
  openingBookValueCents: number | null;
  openingRemainingMonths: number | null;
  disposalDate: string | null;
  disposalKind: string | null;
  disposalProceedsCents: number | null;
  parts: Array<{ rowId: string; lineId: string }>;
}

function toAssetFact(
  stored: StoredAsset,
  itemById: Map<string, { amountCents: number | null; netCents?: number | null }>,
  itemsByRow: Map<string, ResolvedItem[]>,
  smallBusiness: boolean | null,
): AssetFact {
  const opening =
    stored.openingYear !== null && stored.openingBookValueCents !== null && stored.openingRemainingMonths !== null
      ? { year: stored.openingYear, bookValueCents: stored.openingBookValueCents, remainingMonths: stored.openingRemainingMonths }
      : null;
  // The cost is the sum of the linked receipts. One receipt without a usable
  // amount, or a link to a receipt that is gone, makes the cost unknown rather
  // than too low.
  let cost: number | null = stored.parts.length > 0 ? 0 : null;
  let net: number | null = stored.parts.length > 0 ? 0 : null;
  // A part is one line, or a whole receipt (then every item of that receipt:
  // the receipt itself, or all of its lines once it was split).
  const partItems = stored.parts.flatMap((part): Array<{ amountCents: number | null; netCents?: number | null } | undefined> =>
    part.lineId ? [itemById.get(itemIdOf(part.rowId, part.lineId))] : (itemsByRow.get(part.rowId)?.map((r) => r.item) ?? [undefined]),
  );
  for (const item of partItems) {
    if (!item || item.amountCents === null) {
      cost = null;
      net = null;
      break;
    }
    cost = (cost as number) + item.amountCents;
    net = net === null || item.netCents === null || item.netCents === undefined ? null : net + item.netCents;
  }
  const disposal =
    stored.disposalDate !== null && (stored.disposalKind === 'sold' || stored.disposalKind === 'scrapped' || stored.disposalKind === 'private')
      ? { date: stored.disposalDate, kind: stored.disposalKind as DisposalKind, proceedsCents: stored.disposalProceedsCents ?? 0 }
      : null;
  return {
    id: stored.id,
    label: stored.label,
    kind: stored.kind === 'intangible' ? 'intangible' : 'movable',
    acquisitionDate: stored.acquisitionDate,
    costCents: cost,
    netCostCents: net,
    // A stored method the code no longer knows falls back to equal amounts,
    // which then asks for a useful life instead of computing something odd.
    method: (['low_value', 'pool', 'linear', 'computer_one_year', 'declining'] as const).includes(stored.method as AssetMethod)
      ? (stored.method as AssetMethod)
      : 'linear',
    usefulLifeMonths: stored.usefulLifeMonths,
    decliningRateBp: stored.decliningRateBp,
    businessShareBp: stored.businessShareBp,
    // A stored line the code no longer knows keeps the share and loses the line:
    // the asset is then blocked with a check instead of counting the share nowhere.
    annexShareBp: stored.annexShareBp,
    annexLineKey: stored.annexLineKey !== null && (ANNEX_ASSET_LINES as readonly string[]).includes(stored.annexLineKey) ? (stored.annexLineKey as FormLineKey) : null,
    reminderCents: stored.reminderCents,
    opening,
    disposal,
    smallBusiness,
  };
}

/**
 * The receipts that may make up an asset: rows of THIS workspace, not judged
 * by the meal register, and not already part of another asset.
 */
async function requireAssetRows(db: PrismaClient, ctx: TaxContext, itemIds: string[], ownAssetId: string | null): Promise<Array<{ rowId: string; lineId: string }>> {
  const seen = new Set<string>();
  const parts = itemIds
    .map((id) => {
      const { rowId, lineId } = splitItemId(id);
      return { rowId, lineId: lineId ?? '' };
    })
    // "row" and "row#" name the same whole receipt; the same part twice is one part.
    .filter((part) => {
      const key = itemIdOf(part.rowId, part.lineId || null);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  if (parts.length === 0) return parts;
  const settings = await getTaxSettings(db, ctx.workspaceId);
  for (const part of parts) {
    const loaded = await loadReceipts(db, ctx.workspaceId, part.rowId);
    if (!loaded) throw new TaxServiceError('not_initialized');
    const facts = loaded.facts[0];
    if (!facts) throw new TaxServiceError('row_not_found');
    if (resolveItem(facts, [], settings).isMeal) throw new TaxServiceError('meal_row');
    if (part.lineId && !(facts.lines ?? []).some((l) => l.id === part.lineId)) throw new TaxServiceError('line_not_found');
  }
  // A receipt is in an asset as a whole or by lines, never both, and each
  // receipt or line in one asset only.
  const taken = await db.taxAssetPart.findMany({ where: { authWorkspaceId: ctx.workspaceId, rowId: { in: parts.map((p) => p.rowId) } } });
  for (const part of parts) {
    const conflict = taken.some(
      (p) => p.rowId === part.rowId && (p.assetId !== ownAssetId ? p.lineId === part.lineId || p.lineId === '' || part.lineId === '' : false),
    );
    if (conflict) throw new TaxServiceError('row_in_other_asset');
    if (part.lineId === '' ? parts.some((o) => o.rowId === part.rowId && o.lineId !== '') : false) throw new TaxServiceError('row_in_other_asset');
  }
  return parts;
}

function assetData(input: AssetInput) {
  return {
    label: input.label,
    kind: input.kind,
    acquisitionDate: input.acquisitionDate,
    method: input.method,
    usefulLifeMonths: input.usefulLifeMonths,
    decliningRateBp: input.decliningRateBp,
    businessShareBp: input.businessShareBp,
    annexShareBp: input.annexShareBp,
    annexLineKey: input.annexLineKey,
    reminderCents: input.reminderCents,
    openingYear: input.opening?.year ?? null,
    openingBookValueCents: input.opening?.bookValueCents ?? null,
    openingRemainingMonths: input.opening?.remainingMonths ?? null,
  };
}

/** Create an asset from receipts (or carry one in from before the app). Returns its id. */
export async function createAsset(db: PrismaClient, ctx: TaxContext, raw: unknown): Promise<string> {
  const input = validateAssetInput(raw);
  const parts = await requireAssetRows(db, ctx, input.itemIds, null);
  const asset = await db.taxAsset.create({
    data: {
      authWorkspaceId: ctx.workspaceId,
      authTenantId: ctx.tenantId,
      ...assetData(input),
      parts: { create: parts.map((part) => ({ ...part, authWorkspaceId: ctx.workspaceId, authTenantId: ctx.tenantId })) },
    },
  });
  return asset.id;
}

/** Change what was stated about an asset, including which receipts make up its cost. */
export async function updateAsset(db: PrismaClient, ctx: TaxContext, assetId: string, raw: unknown): Promise<void> {
  const input = validateAssetInput(raw);
  const existing = await db.taxAsset.findFirst({ where: { id: assetId, authWorkspaceId: ctx.workspaceId } });
  if (!existing) throw new TaxServiceError('asset_not_found');
  const parts = await requireAssetRows(db, ctx, input.itemIds, assetId);
  // The parts are replaced as one set, together with the asset or not at all.
  await db.$transaction([
    db.taxAssetPart.deleteMany({ where: { assetId } }),
    db.taxAsset.update({ where: { id: assetId }, data: assetData(input) }),
    db.taxAssetPart.createMany({ data: parts.map((part) => ({ ...part, assetId, authWorkspaceId: ctx.workspaceId, authTenantId: ctx.tenantId })) }),
  ]);
}

/** Remove an asset. Its receipts are ordinary receipts again, with whatever was decided about them before. */
export async function deleteAsset(db: PrismaClient, ctx: TaxContext, assetId: string): Promise<void> {
  const { count } = await db.taxAsset.deleteMany({ where: { id: assetId, authWorkspaceId: ctx.workspaceId } });
  if (count === 0) throw new TaxServiceError('asset_not_found');
}

/** Record that an asset left the register, or (with null) take that back. */
export async function setAssetDisposal(db: PrismaClient, ctx: TaxContext, assetId: string, raw: unknown | null): Promise<void> {
  const disposal = raw === null ? null : validateDisposalInput(raw);
  const { count } = await db.taxAsset.updateMany({
    where: { id: assetId, authWorkspaceId: ctx.workspaceId },
    data: {
      disposalDate: disposal?.date ?? null,
      disposalKind: disposal?.kind ?? null,
      disposalProceedsCents: disposal ? disposal.proceedsCents : null,
    },
  });
  if (count === 0) throw new TaxServiceError('asset_not_found');
}

/**
 * Split a receipt into lines, or change its split. Lines that keep their id
 * keep their decision and their place in an asset; a line that is dropped
 * takes both with it. The lines must add up to the receipt's total.
 */
export async function saveReceiptLines(db: PrismaClient, ctx: TaxContext, rowId: string, raw: unknown): Promise<void> {
  // A receipt that is in an asset as a whole cannot be split; single lines in an asset do not stand in the way.
  const facts = await requireOrdinaryRow(db, ctx, rowId, { allowLinesInAsset: true });
  const gross = facts.record.gross !== null && Number.isFinite(facts.record.gross) ? Math.round(facts.record.gross * 100) : null;
  const lines = validateLines(raw, gross);
  const existing = new Set((facts.lines ?? []).map((l) => l.id));
  // An id that is not one of this receipt's lines is not accepted as "existing".
  if (lines.some((l) => l.id !== undefined && !existing.has(l.id))) throw new TaxServiceError('line_not_found');
  const kept = lines.flatMap((l) => (l.id ? [l.id] : []));
  const dropped = [...existing].filter((id) => !kept.includes(id));
  await db.$transaction([
    db.taxAssetPart.deleteMany({ where: { authWorkspaceId: ctx.workspaceId, rowId, lineId: { in: dropped } } }),
    db.taxReceiptLine.deleteMany({ where: { authWorkspaceId: ctx.workspaceId, rowId, id: { in: dropped } } }),
    ...lines.map((line, position) =>
      line.id
        ? db.taxReceiptLine.update({ where: { id: line.id }, data: { position, description: line.description, grossCents: line.grossCents, netCents: line.netCents } })
        : db.taxReceiptLine.create({
            data: { authWorkspaceId: ctx.workspaceId, authTenantId: ctx.tenantId, rowId, position, description: line.description, grossCents: line.grossCents, netCents: line.netCents },
          }),
    ),
  ]);
}

/** Undo a split: the receipt is one item again, with whatever was decided about it as a whole. */
export async function clearReceiptLines(db: PrismaClient, ctx: TaxContext, rowId: string): Promise<void> {
  await requireOrdinaryRow(db, ctx, rowId, { allowLinesInAsset: true });
  await db.$transaction([
    db.taxAssetPart.deleteMany({ where: { authWorkspaceId: ctx.workspaceId, rowId, lineId: { not: '' } } }),
    db.taxReceiptLine.deleteMany({ where: { authWorkspaceId: ctx.workspaceId, rowId } }),
  ]);
}

/** Decide how ONE line of a split receipt is treated; `null` lets it follow its receipt again. */
export async function saveLineDecision(db: PrismaClient, ctx: TaxContext, lineId: string, raw: unknown | null): Promise<void> {
  const line = await db.taxReceiptLine.findFirst({ where: { id: lineId, authWorkspaceId: ctx.workspaceId } });
  if (!line) throw new TaxServiceError('line_not_found');
  if ((await db.taxAssetPart.count({ where: { authWorkspaceId: ctx.workspaceId, rowId: line.rowId, lineId: { in: ['', lineId] } } })) > 0) throw new TaxServiceError('asset_row');
  if (raw === null) {
    await db.taxReceiptLine.update({ where: { id: lineId }, data: { allocations: Prisma.DbNull, formLineKey: null, employmentLineKey: null } });
    return;
  }
  const facts = await requireOrdinaryRow(db, ctx, line.rowId, { allowLinesInAsset: true });
  // A line is one position: "several small items on this receipt" cannot be said about it.
  if ((raw as { severalLowValueItems?: unknown } | undefined)?.severalLowValueItems === true) throw new LinesInputError('line_cannot_hold_several_items');
  // The line counts in the year its receipt was paid, so that year's form lines apply.
  const treatment = validateTreatment(raw, rulesFor((await paymentDayOfRow(db, ctx, line.rowId)) ?? facts.record.date));
  await db.taxReceiptLine.update({
    where: { id: lineId },
    data: { allocations: treatment.allocations as unknown as Prisma.InputJsonValue, formLineKey: treatment.formLineKey, employmentLineKey: treatment.employmentLineKey },
  });
}

/**
 * The day a receipt was paid, exactly as the statement counts it (`linkedByRow`):
 * the same money once, a cancelled purchase not at all. Reading the links
 * directly would let the ten-day check disagree with the statement.
 */
async function paymentDayOfRow(db: PrismaClient, ctx: TaxContext, rowId: string): Promise<string | null> {
  if ((await db.taxPaymentLink.count({ where: { authWorkspaceId: ctx.workspaceId, rowId } })) === 0) return null;
  return linkedByRow((await loadPayments(db, ctx.workspaceId)).payments).get(rowId)?.paid?.day ?? null;
}

async function requireOrdinaryRow(
  db: PrismaClient,
  ctx: TaxContext,
  rowId: string,
  options: { allowLinesInAsset?: boolean } = {},
): Promise<ReceiptFacts> {
  const loaded = await loadReceipts(db, ctx.workspaceId, rowId);
  if (!loaded) throw new TaxServiceError('not_initialized');
  const facts = loaded.facts[0];
  if (!facts) throw new TaxServiceError('row_not_found');
  const settings = await getTaxSettings(db, ctx.workspaceId);
  // What a meal is worth is decided by the meal register alone.
  if (resolveItem(facts, [], settings).isMeal) throw new TaxServiceError('meal_row');
  // A receipt that is part of an asset is treated by the asset register. A
  // split receipt may have single lines in an asset while the others are decided.
  const inAsset = await db.taxAssetPart.count({ where: { authWorkspaceId: ctx.workspaceId, rowId, ...(options.allowLinesInAsset ? { lineId: '' } : {}) } });
  if (inAsset > 0) throw new TaxServiceError('asset_row');
  return facts;
}

/** The rule set a treatment is checked against: the item's own year, or the newest when it has no date. */
function rulesFor(day: string | null) {
  return rulesForYear(day ? Number(day.slice(0, 4)) : Math.max(...RULE_YEARS)).rules;
}

export interface SaveDecisionResult {
  /** False when the input equals what is stored: nothing was written. */
  changed: boolean;
}

export const DECISION_NOTE_MAX = 1000;

/** A decision's note from untrusted input: trimmed, at most 1000 characters, empty as none. */
export function cleanDecisionNote(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const note = raw.trim().slice(0, DECISION_NOTE_MAX);
  return note === '' ? null : note;
}

/**
 * Bring the receipt table's "Zuordnung" and "Business Share %" in step with
 * the treatment just written (see `assignment-sync.ts`). Loaded on demand: that
 * module reads receipts through this one.
 */
async function syncCells(db: PrismaClient, ctx: TaxContext, scope: { rowIds?: string[]; vendor?: string }): Promise<void> {
  // The treatment is stored at this point: a failure here must not report the
  // save as failed. It is logged, and the cells are brought in step by the next
  // write that touches the receipt or by a run of scripts/sync-assignment-cells.ts.
  const { followTreatment } = await import('./assignment-sync');
  await followTreatment(db, ctx, scope);
}

/** Refuse BEFORE a treatment is written when the table could not show it (a column or option renamed or deleted). */
async function precheckCells(db: PrismaClient, ctx: TaxContext): Promise<void> {
  const { AssignmentEditError, assertAssignmentColumns } = await import('./assignment-sync');
  try {
    await assertAssignmentColumns(db, ctx.workspaceId);
  } catch (err) {
    if (err instanceof AssignmentEditError) throw new TaxServiceError('assignment_columns_missing');
    throw err;
  }
}

/**
 * Decide how ONE receipt is treated, overriding its vendor rule. `raw.note`
 * is an optional note of why (stored with the decision, not a figure).
 */
export async function saveItemDecision(db: PrismaClient, ctx: TaxContext, rowId: string, raw: unknown): Promise<SaveDecisionResult> {
  const facts = await requireOrdinaryRow(db, ctx, rowId);
  const treatment = validateTreatment(raw, rulesFor(facts.record.date));
  await precheckCells(db, ctx);
  const stored = facts.decision ? await db.taxItemDecision.findUnique({ where: { rowId }, select: { note: true } }) : null;
  // Only a note that is sent changes it: a save without one keeps what is stored.
  const sentNote = raw !== null && typeof raw === 'object' && 'note' in raw;
  const note = sentNote ? cleanDecisionNote((raw as { note?: unknown }).note) : (stored?.note ?? null);
  if (facts.decision && sameTreatment(facts.decision, treatment) && (stored?.note ?? null) === note) {
    // Nothing to store; the cells are still brought in step, which repairs any left stale.
    await syncCells(db, ctx, { rowIds: [rowId] });
    return { changed: false };
  }
  const data = {
    allocations: treatment.allocations as unknown as Prisma.InputJsonValue,
    formLineKey: treatment.formLineKey,
    employmentLineKey: treatment.employmentLineKey,
    severalLowValueItems: treatment.severalLowValueItems === true,
    note,
  };
  await db.taxItemDecision.upsert({
    where: { rowId },
    create: { authWorkspaceId: ctx.workspaceId, authTenantId: ctx.tenantId, rowId, ...data },
    update: data,
  });
  await syncCells(db, ctx, { rowIds: [rowId] });
  return { changed: true };
}

/** Remove the decision on one receipt: it follows its vendor rule or the defaults again. */
export async function clearItemDecision(db: PrismaClient, ctx: TaxContext, rowId: string): Promise<SaveDecisionResult> {
  await precheckCells(db, ctx);
  const { count } = await db.taxItemDecision.deleteMany({ where: { authWorkspaceId: ctx.workspaceId, rowId } });
  // The cells get back what they held before the decision (or show the vendor
  // rule), so removing a decision restores the earlier figures exactly.
  if (count > 0) await syncCells(db, ctx, { rowIds: [rowId] });
  return { changed: count > 0 };
}

export interface VendorRuleInput {
  /** The vendor name as it is printed on a receipt; the key is derived from it. */
  vendor: string;
  /** ISO day, or '' / undefined for "from the beginning". */
  effectiveFrom?: string;
  treatment: unknown;
}

/**
 * Set how a vendor is treated from a date on. An entry with the same start
 * date is corrected in place; a new start date adds an entry and leaves the
 * earlier ones, so items before that date keep their treatment.
 */
export async function saveVendorRule(db: PrismaClient, ctx: TaxContext, input: VendorRuleInput): Promise<VendorRule> {
  const key = vendorKey(input?.vendor);
  if (!key) throw new TaxServiceError('no_vendor');
  const effectiveFrom = input.effectiveFrom ?? '';
  if (effectiveFrom !== '' && !isIsoDay(effectiveFrom)) throw new TaxServiceError('invalid_date');
  const treatment = validateTreatment(input.treatment, rulesFor(effectiveFrom || null));
  await precheckCells(db, ctx);
  const data = {
    vendorLabel: input.vendor.trim(),
    allocations: treatment.allocations as unknown as Prisma.InputJsonValue,
    formLineKey: treatment.formLineKey,
    employmentLineKey: treatment.employmentLineKey,
  };
  const row = await db.taxVendorRule.upsert({
    where: { authWorkspaceId_vendorKey_effectiveFrom: { authWorkspaceId: ctx.workspaceId, vendorKey: key, effectiveFrom } },
    create: { authWorkspaceId: ctx.workspaceId, authTenantId: ctx.tenantId, vendorKey: key, effectiveFrom, ...data },
    update: data,
  });
  await syncCells(db, ctx, { vendor: input.vendor });
  return { id: row.id, vendorKey: key, vendorLabel: row.vendorLabel, effectiveFrom, ...treatment, severalLowValueItems: false };
}

/**
 * Decide one receipt AND make that its vendor's treatment from a date on.
 *
 * Everything is checked before anything is written, and the writes happen
 * together or not at all. Whether the receipt keeps a decision of its own
 * depends on the rule: when the new rule is in force on the receipt's date, the
 * receipt follows it like every other receipt of the vendor and its own
 * decision is removed. When the rule starts later than the receipt (or the
 * receipt has no date and the rule has a start date), the rule does not cover
 * this receipt, so the receipt keeps the decision; otherwise it would silently
 * fall back to its defaults after the person just decided it. The same holds
 * for a receipt with the "several small items" statement, which no rule carries.
 */
export async function decideForVendor(
  db: PrismaClient,
  ctx: TaxContext,
  rowId: string,
  input: VendorRuleInput,
): Promise<{ rule: VendorRule; receiptFollowsRule: boolean }> {
  const facts = await requireOrdinaryRow(db, ctx, rowId);
  const key = vendorKey(input?.vendor);
  if (!key) throw new TaxServiceError('no_vendor');
  const effectiveFrom = input.effectiveFrom ?? '';
  if (effectiveFrom !== '' && !isIsoDay(effectiveFrom)) throw new TaxServiceError('invalid_date');
  // The same treatment is stored twice in the worst case, so it has to pass
  // the rules of both dates it is judged on.
  const forRule = validateTreatment(input.treatment, rulesFor(effectiveFrom || null));
  const forItem = validateTreatment(input.treatment, rulesFor(facts.record.date));
  await precheckCells(db, ctx);

  // The statement "several small items on this receipt" belongs to the one
  // receipt and a rule cannot carry it, so a receipt that has it keeps its own
  // decision even when the rule covers its date.
  const receiptFollowsRule =
    forItem.severalLowValueItems !== true &&
    (effectiveFrom === '' || (facts.record.date !== null && effectiveFrom <= facts.record.date));
  const ruleData = {
    vendorLabel: input.vendor.trim(),
    allocations: forRule.allocations as unknown as Prisma.InputJsonValue,
    formLineKey: forRule.formLineKey,
    employmentLineKey: forRule.employmentLineKey,
  };
  const itemData = {
    allocations: forItem.allocations as unknown as Prisma.InputJsonValue,
    formLineKey: forItem.formLineKey,
    employmentLineKey: forItem.employmentLineKey,
    severalLowValueItems: forItem.severalLowValueItems === true,
  };
  const [row] = await db.$transaction([
    db.taxVendorRule.upsert({
      where: { authWorkspaceId_vendorKey_effectiveFrom: { authWorkspaceId: ctx.workspaceId, vendorKey: key, effectiveFrom } },
      create: { authWorkspaceId: ctx.workspaceId, authTenantId: ctx.tenantId, vendorKey: key, effectiveFrom, ...ruleData },
      update: ruleData,
    }),
    receiptFollowsRule
      ? db.taxItemDecision.deleteMany({ where: { authWorkspaceId: ctx.workspaceId, rowId } })
      : db.taxItemDecision.upsert({
          where: { rowId },
          create: { authWorkspaceId: ctx.workspaceId, authTenantId: ctx.tenantId, rowId, ...itemData },
          update: itemData,
        }),
  ]);
  await syncCells(db, ctx, { vendor: input.vendor });
  return {
    // The statement about several small items belongs to one receipt, never to a rule.
    rule: { id: row.id, vendorKey: key, vendorLabel: row.vendorLabel, effectiveFrom, ...forRule, severalLowValueItems: false },
    receiptFollowsRule,
  };
}

function toReverseChargeEntry(row: { id: string; scope: string; subject: string; label: string; effectiveFrom: string; rateBp: number | null }): ReverseChargeEntry {
  // A stored rate the app no longer knows is read as "no statement", never as a guess.
  const rateBp = row.rateBp === 1900 || row.rateBp === 700 ? (row.rateBp as ReverseChargeRateBp) : null;
  return { id: row.id, scope: row.scope === 'vendor' ? 'vendor' : 'row', subject: row.subject, label: row.label, effectiveFrom: row.effectiveFrom, rateBp };
}

export interface ReverseChargeRequest {
  /** 1900 or 700 basis points; null states "not under section 13b". */
  rateBp: unknown;
  /** Also make this the vendor's statement from a day on (`effectiveFrom` '' or absent: from the beginning). */
  applyToVendor?: { vendor: string; effectiveFrom?: unknown };
}

/**
 * State whether the buyer owes the tax on ONE receipt (section 13b), or on all
 * of its vendor's receipts from a day on. Like a vendor rule, the receipt then
 * follows the vendor's entry when that entry is in force on its document day,
 * and keeps a statement of its own otherwise. A meal is the register's alone.
 * Everything is checked before anything is written.
 */
export async function saveReverseCharge(db: PrismaClient, ctx: TaxContext, rowId: string, request: ReverseChargeRequest): Promise<void> {
  if (!rowId) throw new TaxServiceError('row_not_found');
  const rateBp = validateReverseChargeRate(request?.rateBp);
  const loaded = await loadReceipts(db, ctx.workspaceId, rowId);
  if (!loaded) throw new TaxServiceError('not_initialized');
  const facts = loaded.facts[0];
  if (!facts) throw new TaxServiceError('row_not_found');
  const [settings, vendorRules, entries] = await Promise.all([
    getTaxSettings(db, ctx.workspaceId),
    listVendorRules(db, ctx.workspaceId),
    db.taxReverseCharge.findMany({ where: { authWorkspaceId: ctx.workspaceId } }),
  ]);
  // A meal is the register's alone, also one that is on the meal line only
  // through its vendor's rule (it is then an open check, never a 13b purchase).
  const resolved = resolveItem(facts, vendorRules, settings);
  if (resolved.isMeal || resolved.item.formLineKey === 'euer.meals') throw new TaxServiceError('meal_row');
  const rowWhere = { authWorkspaceId_scope_subject_effectiveFrom: { authWorkspaceId: ctx.workspaceId, scope: 'row', subject: rowId, effectiveFrom: '' } };
  if (!request.applyToVendor) {
    // What the receipt gets without a statement of its own. Choosing exactly
    // that does not pin the receipt: it keeps following its vendor.
    const vendorEntries = entries.map(toReverseChargeEntry).filter((e) => e.scope === 'vendor');
    const fromVendor = reverseChargeFor(vendorEntries, rowId, resolved.vendorKey, facts.record.date)?.rateBp ?? null;
    if (fromVendor === rateBp) {
      await db.taxReverseCharge.deleteMany({ where: { authWorkspaceId: ctx.workspaceId, scope: 'row', subject: rowId } });
      return;
    }
    await db.taxReverseCharge.upsert({
      where: rowWhere,
      create: { authWorkspaceId: ctx.workspaceId, authTenantId: ctx.tenantId, scope: 'row', subject: rowId, rateBp },
      update: { rateBp },
    });
    return;
  }
  const vendor = String(request.applyToVendor.vendor ?? '');
  const key = vendorKey(vendor);
  if (!key) throw new TaxServiceError('no_vendor');
  const effectiveFrom = validateEffectiveFrom(request.applyToVendor.effectiveFrom);
  const covers = effectiveFrom === '' || (facts.record.date !== null && effectiveFrom <= facts.record.date);
  await db.$transaction([
    db.taxReverseCharge.upsert({
      where: { authWorkspaceId_scope_subject_effectiveFrom: { authWorkspaceId: ctx.workspaceId, scope: 'vendor', subject: key, effectiveFrom } },
      create: { authWorkspaceId: ctx.workspaceId, authTenantId: ctx.tenantId, scope: 'vendor', subject: key, label: vendor.trim(), effectiveFrom, rateBp },
      update: { label: vendor.trim(), rateBp },
    }),
    covers
      ? db.taxReverseCharge.deleteMany({ where: { authWorkspaceId: ctx.workspaceId, scope: 'row', subject: rowId } })
      : db.taxReverseCharge.upsert({
          where: rowWhere,
          create: { authWorkspaceId: ctx.workspaceId, authTenantId: ctx.tenantId, scope: 'row', subject: rowId, rateBp },
          update: { rateBp },
        }),
  ]);
}

/** Remove a receipt's own section 13b statement: it follows its vendor's entry again, if any. */
export async function clearReverseCharge(db: PrismaClient, ctx: TaxContext, rowId: string): Promise<void> {
  if (!rowId) throw new TaxServiceError('row_not_found');
  await db.taxReverseCharge.deleteMany({ where: { authWorkspaceId: ctx.workspaceId, scope: 'row', subject: rowId } });
}

/** Remove one vendor's section 13b entry. */
export async function deleteReverseChargeVendorEntry(db: PrismaClient, ctx: TaxContext, entryId: string): Promise<void> {
  const { count } = await db.taxReverseCharge.deleteMany({ where: { id: entryId, authWorkspaceId: ctx.workspaceId, scope: 'vendor' } });
  if (count === 0) throw new TaxServiceError('rule_not_found');
}

export { ReverseChargeInputError };

export async function deleteVendorRule(db: PrismaClient, ctx: TaxContext, ruleId: string): Promise<void> {
  await precheckCells(db, ctx);
  const rule = await db.taxVendorRule.findFirst({ where: { id: ruleId, authWorkspaceId: ctx.workspaceId }, select: { vendorLabel: true } });
  const { count } = await db.taxVendorRule.deleteMany({ where: { id: ruleId, authWorkspaceId: ctx.workspaceId } });
  if (count === 0 || !rule) throw new TaxServiceError('rule_not_found');
  await syncCells(db, ctx, { vendor: rule.vendorLabel });
}

/** Called by the row delete paths: a deleted receipt takes its decision with it. */
export async function deleteDecisionsForRows(db: PrismaClient, rowIds: string[]): Promise<void> {
  if (rowIds.length === 0) return;
  await db.taxItemDecision.deleteMany({ where: { rowId: { in: rowIds } } });
  await db.taxReverseCharge.deleteMany({ where: { scope: 'row', subject: { in: rowIds } } });
  await db.taxAssignmentOrigin.deleteMany({ where: { rowId: { in: rowIds } } });
  await db.taxReceiptLine.deleteMany({ where: { rowId: { in: rowIds } } });
  // An asset keeps existing without the receipt; with no receipt left it shows
  // up as "no cost" and asks for one, instead of vanishing with its history.
  await db.taxAssetPart.deleteMany({ where: { rowId: { in: rowIds } } });
  await db.taxYearBoundaryAnswer.deleteMany({ where: { subjectKind: 'receipt', subjectId: { in: rowIds } } });
  // The payments stay; they then show up again as payments without a document.
  await deletePaymentLinksForRows(db, rowIds);
}

export { AssetInputError, LinesInputError, RevenueInputError, TreatmentError };
