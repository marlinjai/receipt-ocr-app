import 'server-only';
import { Prisma, type PrismaClient } from '@prisma/client';
import { rowToMealRecord } from '@/lib/meals/record';
import { smallBusinessOn } from '@/lib/meals/rules';
import { allRows, getTaxSettings, guestsByRow, tableContext } from '@/lib/meals/service';
import type { MealGuestEntry } from '@/lib/meals/types';
import { AssetInputError, validateAssetInput, validateDisposalInput, type AssetInput } from './asset-input';
import { assetSchedule, type AssetCheck, type AssetFact, type AssetKind, type AssetMethod, type AssetYearRow, type DisposalKind } from './assets';
import { computeYear } from './compute';
import {
  TreatmentError,
  isIsoDay,
  parseAllocations,
  sameTreatment,
  validateTreatment,
  vendorKey,
  type TreatmentInput,
  type VendorRule,
} from './decisions';
import { resolveItem, resolveItems, type ReceiptFacts, type ResolvedItem, type TreatmentOrigin } from './facts';
import { answerFor, boundaryDay, otherYearOf, touchesYear, BOUNDARY_SUBJECT_KINDS, type BoundarySubjectKind } from './year-boundary';
import { LinesInputError, itemIdOf, splitItemId, storedLineTreatment, validateLines, type ReceiptLine } from './lines';
import { forecastYear, type Forecast } from './forecast';
import { proposeMatches, type MatchStrength } from './payments/match';
import { deletePaymentLinksForRows, loadPayments, type CounterpartyTreatment, type LoadedPayments, type PaymentRow } from './payments/service';
import type { PaymentKind } from './payments/types';
import {
  RevenueInputError,
  validateExpectation,
  validateInvoiceInput,
  validateSettlement,
  validateStatusChange,
  validateVatSettings,
} from './revenue-input';
import { RULE_YEARS, isFormLineKey, rulesForYear, type FormLine } from './rules';
import type { FormLineKey } from './rules/types';
import type { InvoiceCheckKind, InvoiceFact, InvoiceTreatment, ItemPart, LineResult, OpenCheck, VatSettlementFact } from './types';
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
  | 'status_not_found'
  | 'status_unanswered'
  | 'settlement_not_found'
  | 'line_not_found'
  | 'boundary_subject_not_found'
  | 'not_in_year_boundary'
  | 'year_boundary_changed';

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

interface LoadedReceipts {
  facts: ReceiptFacts[];
}

/**
 * What linked payments say each receipt cost: money out counts, a refund
 * linked to the same receipt is taken off, and the day is that of the first
 * payment out.
 */
export function paidByRow(payments: readonly PaymentRow[]): Map<string, { day: string; cents: number }> {
  const out = new Map<string, { day: string; cents: number }>();
  for (const [rowId, money] of linkedByRow(payments)) if (money.paid) out.set(rowId, money.paid);
  return out;
}

/** What linked payments say about one receipt. */
export interface LinkedMoney {
  /** Day of the first payment out and what was paid, refunds taken off; null while no payment out is linked. */
  paid: { day: string; cents: number } | null;
  /** Refunds linked while no payment out is: taken off the document's own amount. */
  refundedCents: number;
}

/**
 * Money out and money back per receipt. A refund never stands for the
 * purchase: with only a refund linked (the purchase was paid in cash, or its
 * payment is not imported) the receipt keeps its own amount and day, less the refund.
 */
export function linkedByRow(payments: readonly PaymentRow[]): Map<string, LinkedMoney> {
  const sums = new Map<string, { day: string | null; outCents: number; backCents: number }>();
  for (const payment of payments) {
    for (const link of payment.links) {
      if (!link.rowId) continue;
      const current = sums.get(link.rowId) ?? { day: null, outCents: 0, backCents: 0 };
      if (payment.amountCents < 0) {
        current.outCents += link.cents;
        if (current.day === null || payment.bookingDay < current.day) current.day = payment.bookingDay;
      } else {
        current.backCents += link.cents;
      }
      sums.set(link.rowId, current);
    }
  }
  const out = new Map<string, LinkedMoney>();
  for (const [rowId, s] of sums) {
    out.set(rowId, s.day !== null ? { paid: { day: s.day, cents: Math.max(0, s.outCents - s.backCents) }, refundedCents: 0 } : { paid: null, refundedCents: s.backCents });
  }
  return out;
}

async function loadReceipts(
  db: PrismaClient,
  workspaceId: string,
  onlyRowId?: string,
  linked?: Map<string, LinkedMoney>,
): Promise<LoadedReceipts | null> {
  const ctx = await tableContext(db, workspaceId);
  if (!ctx) return null;
  let rows;
  if (onlyRowId) {
    const row = await ctx.adapter.getRow(onlyRowId);
    // The row must live in THIS workspace's Receipts table.
    rows = row && row.tableId === ctx.tableId && !row.archived ? [row] : [];
  } else {
    rows = (await allRows(ctx.adapter, ctx.tableId)).filter((r) => !r.archived);
  }
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
  const shareColumn = ctx.columns.find((c) => c.name === BUSINESS_SHARE_COLUMN);
  const noGuests: MealGuestEntry[] = [];
  const facts = rows.map((row): ReceiptFacts => {
    const share = shareColumn ? row.cells[shareColumn.id] : null;
    const shareNumber = share === null || share === undefined || share === '' ? null : Number(share);
    return {
      record: rowToMealRecord(row, ctx.columns, ctx.selectOptions, guests.get(row.id) ?? noGuests),
      businessSharePercent: shareNumber !== null && Number.isFinite(shareNumber) ? shareNumber : null,
      decision: decisionByRow.get(row.id) ?? null,
      paid: linked?.get(row.id)?.paid ?? null,
      refundedCents: linked?.get(row.id)?.refundedCents ?? 0,
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
  /** True: counts in `otherYear`. False: stays. Null: not answered for this payment day. */
  answer: boolean | null;
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
  vendorRuleId: string | null;
  isMeal: boolean;
  /** The asset this receipt is part of, if any. */
  assetId: string | null;
  counted: boolean;
  parts: ItemPart[];
  privateCents: number;
  checks: OpenCheck[];
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
  };
  /** Where the year is heading against the small-business limits, as of today. */
  forecast: Forecast;
  limits: { previousYearLimitCents: number; currentYearLimitCents: number; source: { citation: string; url: string; checkedOn: string } };
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
    /** `date` is the day of the payment; `countsOn` is set when the ten-day rule moved it into this year. */
    settlements: Array<{ id: string; date: string; cents: number; direction: 'paid' | 'refunded'; countsOn?: string }>;
  };
  /** Payments at the turn of the year a person is asked about (the ten-day rule), for this year. */
  yearBoundary: YearBoundaryEntry[];
  payments: PaymentsView;
  vendorRules: VendorRule[];
  /** False until the Receipts table exists (first dashboard visit). */
  initialized: boolean;
}

function toStatementItem(resolved: ResolvedItem, facts: ReceiptFacts, result: { counted: boolean; parts: ItemPart[]; privateCents: number; checks: OpenCheck[] }): StatementItem {
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
    vendorRuleId: resolved.vendorRuleId,
    isMeal: resolved.isMeal,
    assetId: item.assetId ?? null,
    counted: result.counted,
    parts: result.parts,
    privateCents: result.privateCents,
    checks: result.checks,
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
  const [storedInvoices, storedSettlements, storedChanges, settingsRow, storedBoundaryAnswers] = await Promise.all([
    db.taxIssuedInvoice.findMany({ where: { authWorkspaceId: workspaceId }, include: { payments: true }, orderBy: [{ issueDate: 'asc' }, { number: 'asc' }] }),
    db.taxVatSettlement.findMany({ where: { authWorkspaceId: workspaceId }, orderBy: { settledOn: 'asc' } }),
    db.taxStatusChange.findMany({ where: { authWorkspaceId: workspaceId }, orderBy: { effectiveFrom: 'asc' } }),
    db.workspaceTaxSettings.findUnique({ where: { authWorkspaceId: workspaceId } }),
    db.taxYearBoundaryAnswer.findMany({ where: { authWorkspaceId: workspaceId } }),
  ]);
  const boundaryAnswers = new Map(storedBoundaryAnswers.map((a) => [`${a.subjectKind}:${a.subjectId}`, a]));
  const invoiceFacts: InvoiceFact[] = storedInvoices.map((i) => ({
    id: i.id,
    number: i.number,
    issueDate: i.issueDate,
    grossCents: i.grossCents,
    vatCents: i.vatCents,
    treatment: (['small_business', 'standard', 'reduced', 'not_taxable'] as const).includes(i.treatment as InvoiceTreatment)
      ? (i.treatment as InvoiceTreatment)
      : 'not_taxable',
    // Money received: what was typed in, plus every bank payment linked to the invoice.
    payments: [
      ...i.payments.map((p) => ({ date: p.paidOn, cents: p.cents })),
      ...loadedPayments.payments.flatMap((p) => p.links.filter((l) => l.invoiceId === i.id).map((l) => ({ date: p.bookingDay, cents: l.cents }))),
    ],
    declaredInYear: i.declaredInYear,
    smallBusinessOnIssue: smallBusinessOn(settings, i.issueDate),
  }));
  const settlementFacts: VatSettlementFact[] = storedSettlements.map((s) => ({
    id: s.id,
    // A confirmed advance payment at the turn of the year counts in the year it belongs to.
    date: answerFor(boundaryAnswers.get(`vat_settlement:${s.id}`), s.settledOn) === true ? (boundaryDay(s.settledOn) ?? s.settledOn) : s.settledOn,
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
  // The ten-day rule: a receipt a person confirmed counts on the boundary day
  // of the year it belongs to. An asset is depreciated from its acquisition,
  // so a receipt that is (partly) an asset is never moved.
  const cashDayOf = (f: ReceiptFacts) => f.paid?.day ?? f.record.date;
  const facts = (loaded?.facts ?? []).map((f): ReceiptFacts => {
    const cashDay = cashDayOf(f);
    if (rowsInAssets.has(f.record.rowId) || answerFor(boundaryAnswers.get(`receipt:${f.record.rowId}`), cashDay) !== true) return f;
    return { ...f, countsOnDay: boundaryDay(cashDay) };
  });
  const factsOfItem: ReceiptFacts[] = [];
  const resolved = facts.flatMap((f) =>
    resolveItems(f, vendorRules, settings).map((r) => {
      factsOfItem.push(f);
      // A whole-receipt part covers every line of that receipt.
      const assetId = assetByItem.get(r.item.id) ?? assetByItem.get(r.rowId);
      return assetId ? { ...r, item: { ...r.item, assetId } } : r;
    }),
  );
  const itemsByRow = new Map<string, ResolvedItem[]>();
  for (const r of resolved) itemsByRow.set(r.rowId, [...(itemsByRow.get(r.rowId) ?? []), r]);
  const itemById = new Map(resolved.map((r) => [r.item.id, r.item]));
  const assetFacts = storedAssets.map((a) => toAssetFact(a, itemById, itemsByRow, smallBusinessOn(settings, a.acquisitionDate)));
  // Whole receipts, for matching payments: a payment pays a receipt, not a line of it.
  // On their real day: a payment is matched to a receipt by when it was paid, whatever year it counts in.
  const wholeReceipts = facts.map((f) => resolveItem({ ...f, countsOnDay: null }, vendorRules, settings));
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
    limits.value,
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
  const paymentsView = buildPaymentsView(loadedPayments, year, wholeReceipts, invoiceFacts, result.revenue.invoices);
  const resultById = new Map(result.items.map((i) => [i.itemId, i]));

  const items: StatementItem[] = [];
  const years = new Set<number>(RULE_YEARS);
  years.add(year);
  resolved.forEach((r, index) => {
    if (r.item.date) years.add(Number(r.item.date.slice(0, 4)));
    const itemResult = resultById.get(r.item.id);
    // computeYear only returns items of the year and undated ones.
    if (itemResult) items.push(toStatementItem(r, factsOfItem[index], itemResult));
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
  return {
    year,
    years: [...years].sort((a, b) => b - a),
    smallBusiness: settings.smallBusiness,
    rulesYear: result.rulesYear,
    rulesExact: result.rulesExact,
    rulesReviewedOn: rules.reviewedOn,
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
            declaredInYear: fact.declaredInYear,
            payments: [...fact.payments].sort((a, b) => (a.date < b.date ? -1 : 1)),
            receivedCents: r.receivedCents,
            excludedCents: r.excludedCents,
            outstandingCents: r.outstandingCents,
            checks: r.checks,
          },
        ];
      }),
    },
    forecast,
    limits: { ...limits.value, source: limits.source },
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
            })
          : null,
      undeductedInputVatCents,
      settlements: settlementFacts
        .map((s, index) => ({ ...s, date: storedSettlements[index].settledOn, ...(s.date !== storedSettlements[index].settledOn ? { countsOn: s.date } : {}) }))
        .filter((s) => (s.countsOn ?? s.date).startsWith(`${year}-`)),
    },
    yearBoundary: [
      ...wholeReceipts.flatMap((r, index): YearBoundaryEntry[] => {
        const f = facts[index];
        const cashDay = cashDayOf(f);
        const otherYear = otherYearOf(cashDay);
        if (cashDay === null || otherYear === null || !touchesYear(cashDay, year)) return [];
        const answer = answerFor(boundaryAnswers.get(`receipt:${f.record.rowId}`), cashDay);
        // Meals are listed by the meal register on their own day; assets are
        // depreciated from their acquisition. Neither is asked about, but an
        // answer given before stays visible so it can be taken back.
        const inactive = r.isMeal ? 'meal' : rowsInAssets.has(f.record.rowId) ? 'asset' : null;
        if (inactive !== null && answer === null) return [];
        return [
          {
            kind: 'receipt',
            subjectId: f.record.rowId,
            label: r.item.vendor || r.item.label,
            cashDay,
            dayBasis: f.paid ? 'payment' : 'document',
            cents: r.item.amountCents,
            otherYear,
            answer,
            inactive,
          },
        ];
      }),
      ...storedSettlements.flatMap((s): YearBoundaryEntry[] => {
        const otherYear = otherYearOf(s.settledOn);
        if (otherYear === null || !touchesYear(s.settledOn, year)) return [];
        return [
          {
            kind: 'vat_settlement',
            subjectId: s.id,
            label: s.direction === 'refunded' ? 'Umsatzsteuer: Erstattung vom Finanzamt' : 'Umsatzsteuer: Zahlung an das Finanzamt',
            cashDay: s.settledOn,
            dayBasis: 'payment',
            cents: s.cents,
            otherYear,
            answer: answerFor(boundaryAnswers.get(`vat_settlement:${s.id}`), s.settledOn),
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
    initialized: loaded !== null,
  };
}

export interface PaymentProposal {
  target: 'receipt' | 'invoice';
  targetId: string;
  label: string;
  strength: MatchStrength;
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
}

export interface PaymentsView {
  accounts: LoadedPayments['accounts'];
  /** Payments booked in the year, and how many of them are linked to a document. */
  yearCount: number;
  linkedCount: number;
  /** Counterparties of the year nobody has said anything about yet, largest first. */
  unclassified: Array<{ key: string; label: string; count: number; outCents: number; inCents: number }>;
  treatments: Array<{ key: string; label: string; treatment: CounterpartyTreatment }>;
  /** Business payments without a document and money received without an invoice. */
  open: OpenPayment[];
  /** Payments of the year a person re-labelled (private, refund), so each can be put back. */
  overridden: Array<{ id: string; bookingDay: string; amountCents: number; counterparty: string; kind: PaymentKind }>;
  /**
   * What a payment can be linked to by hand: receipts of the year and of the
   * year before that no payment is linked to yet (a December receipt is often
   * paid in January), and invoices with something still open.
   */
  receiptTargets: Array<{ id: string; label: string; day: string | null; amountCents: number | null }>;
  invoiceTargets: Array<{ id: string; label: string; openCents: number }>;
  /** Links of the year, so each can be taken back. */
  links: Array<{ linkId: string; paymentId: string; bookingDay: string; cents: number; counterparty: string; target: 'receipt' | 'invoice'; targetLabel: string; method: string }>;
}

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

  // Counterparties without an answer, by what moved (own transfers and fees ask nothing).
  const unclassified = new Map<string, { key: string; label: string; count: number; outCents: number; inCents: number }>();
  for (const p of inYear) {
    if (p.kind === 'own_transfer' || p.kind === 'fee' || p.kind === 'private' || !p.counterpartyKey || loaded.treatments.has(p.counterpartyKey) || free(p) === 0) continue;
    const entry = unclassified.get(p.counterpartyKey) ?? { key: p.counterpartyKey, label: p.counterparty, count: 0, outCents: 0, inCents: 0 };
    entry.count += 1;
    if (p.amountCents < 0) entry.outCents += -p.amountCents;
    else entry.inCents += p.amountCents;
    unclassified.set(p.counterpartyKey, entry);
  }

  // What needs a document: money out to a business counterparty, and money in
  // that is not private and not a refund.
  const needing = inYear.filter((p) => {
    if (free(p) === 0) return false;
    const treatment = loaded.treatments.get(p.counterpartyKey);
    // Money out to a business counterparty, and money out with no name at all
    // (there is nobody to ask about once, so each such payment is asked about).
    if (p.kind === 'spend') return treatment === 'business' || !p.counterpartyKey;
    if (p.kind === 'income') return treatment !== 'private' && treatment !== 'own_account';
    // Money back from a business counterparty belongs on the receipt it refunds.
    if (p.kind === 'refund') return treatment === 'business' || !p.counterpartyKey;
    return false;
  });
  const linkedRows = new Set(loaded.payments.flatMap((p) => p.links.map((l) => l.rowId).filter((id): id is string => id !== null)));
  const receiptDocuments = resolved
    .filter((r) => !r.isMeal && !linkedRows.has(r.item.id) && r.item.amountCents !== null && r.item.date !== null && r.item.date.startsWith(`${year}-`))
    .map((r) => ({ id: r.item.id, number: null, day: r.item.date, openCents: r.item.amountCents as number }));
  // Candidates for linking by hand: also last year's receipts, and receipts that
  // already have a payment (a refund goes on the receipt its purchase is linked to).
  const receiptTargets = resolved
    .filter((r) => !r.isMeal && (r.item.date === null || r.item.date.startsWith(`${year}-`) || r.item.date.startsWith(`${year - 1}-`)))
    .map((r) => ({ id: r.item.id, label: r.item.label, day: r.item.date, amountCents: r.item.amountCents }))
    .sort((a, b) => ((a.day ?? '') < (b.day ?? '') ? 1 : -1));
  const outstanding = new Map(invoiceResults.map((i) => [i.invoiceId, i.outstandingCents]));
  const invoiceDocuments = invoices.map((i) => ({ id: i.id, number: i.number, day: i.issueDate, openCents: outstanding.get(i.id) ?? 0 }));
  const asMatch = (p: PaymentRow) => ({ id: p.id, bookingDay: p.bookingDay, amountCents: p.amountCents, reference: p.reference, counterparty: p.counterparty });
  const spendProposals = proposeMatches(needing.filter((p) => p.kind === 'spend').map(asMatch), receiptDocuments);
  const incomeProposals = proposeMatches(needing.filter((p) => p.kind === 'income').map(asMatch), invoiceDocuments);

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
    proposals:
      p.kind === 'refund'
        ? []
        : p.kind === 'income'
        ? incomeProposals.filter((x) => x.paymentId === p.id).map((x) => ({ target: 'invoice' as const, targetId: x.documentId, label: `Rechnung ${invoiceById.get(x.documentId)?.number ?? ''}`, strength: x.strength }))
        : spendProposals.filter((x) => x.paymentId === p.id).map((x) => ({ target: 'receipt' as const, targetId: x.documentId, label: itemById.get(x.documentId)?.label ?? 'Beleg', strength: x.strength })),
  }));

  return {
    accounts: loaded.accounts,
    yearCount: inYear.length,
    linkedCount: inYear.filter((p) => p.links.length > 0).length,
    unclassified: [...unclassified.values()].sort((a, b) => b.outCents + b.inCents - (a.outCents + a.inCents)),
    treatments: [...loaded.treatments.entries()].map(([key, treatment]) => ({
      key,
      label: loaded.payments.find((p) => p.counterpartyKey === key)?.counterparty ?? key,
      treatment,
    })),
    open,
    overridden: inYear.filter((p) => p.kindOverridden).map((p) => ({ id: p.id, bookingDay: p.bookingDay, amountCents: p.amountCents, counterparty: p.counterparty, kind: p.kind })),
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
        targetLabel: l.rowId ? (itemById.get(l.rowId)?.label ?? 'Beleg (nicht mehr vorhanden)') : `Rechnung ${invoiceById.get(l.invoiceId ?? '')?.number ?? ''}`,
        method: l.method,
      })),
    ),
  };
}

/** True when the row is a receipt of this workspace: how the payment service checks a link target. */
export async function isWorkspaceReceipt(db: PrismaClient, workspaceId: string, rowId: string): Promise<boolean> {
  const loaded = await loadReceipts(db, workspaceId, rowId);
  return (loaded?.facts.length ?? 0) > 0;
}

/** The ISO day "today" in the business's time zone; one place, so tests can see what the forecast used. */
function today(): string {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Berlin' }).format(new Date());
}

/** An issued invoice as the finance screens show it for one year. */
export interface InvoiceView {
  id: string;
  number: string;
  issueDate: string | null;
  grossCents: number;
  vatCents: number;
  treatment: InvoiceTreatment;
  declaredInYear: number | null;
  /** Every payment of the invoice, whatever year. */
  payments: Array<{ date: string; cents: number }>;
  /** Received in the viewed year, and what of that another year's return already declared. */
  receivedCents: number;
  excludedCents: number;
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
    declaredInYear: input.declaredInYear,
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
  // save replaces them as one set, together with the invoice or not at all.
  await db.$transaction([
    db.taxInvoicePayment.deleteMany({ where: { invoiceId } }),
    db.taxIssuedInvoice.update({ where: { id: invoiceId }, data }),
    db.taxInvoicePayment.createMany({ data: payments.map((p) => ({ ...p, invoiceId })) }),
  ]);
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
 * current one is refused, so nobody answers for a day they did not see.
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
  await db.taxYearBoundaryAnswer.upsert({
    where: { authWorkspaceId_subjectKind_subjectId: key },
    create: { ...key, authTenantId: ctx.tenantId, cashDay, belongsToOtherYear: input.belongsToOtherYear },
    update: { cashDay, belongsToOtherYear: input.belongsToOtherYear },
  });
}

/**
 * "None of these recurs": the payments the person saw without an answer stay
 * in the year they were paid. Only entries that are still open, on the day the
 * person saw, are answered; all of them together or none.
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
  const open = view.yearBoundary.filter((e) => e.answer === null && e.inactive === null && seen.has(`${e.kind}:${e.subjectId}:${e.cashDay}`));
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

/** The day of the first payment out linked to a receipt, when there is one. */
async function paymentDayOfRow(db: PrismaClient, ctx: TaxContext, rowId: string): Promise<string | null> {
  const links = await db.taxPaymentLink.findMany({ where: { authWorkspaceId: ctx.workspaceId, rowId }, include: { payment: true } });
  const days = links.filter((l) => l.payment.amountCents < 0).map((l) => l.payment.bookingDay);
  return days.length > 0 ? days.sort()[0] : null;
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

/** Decide how ONE receipt is treated, overriding its vendor rule. */
export async function saveItemDecision(db: PrismaClient, ctx: TaxContext, rowId: string, raw: unknown): Promise<SaveDecisionResult> {
  const facts = await requireOrdinaryRow(db, ctx, rowId);
  const treatment = validateTreatment(raw, rulesFor(facts.record.date));
  if (facts.decision && sameTreatment(facts.decision, treatment)) return { changed: false };
  const data = {
    allocations: treatment.allocations as unknown as Prisma.InputJsonValue,
    formLineKey: treatment.formLineKey,
    employmentLineKey: treatment.employmentLineKey,
    severalLowValueItems: treatment.severalLowValueItems === true,
  };
  await db.taxItemDecision.upsert({
    where: { rowId },
    create: { authWorkspaceId: ctx.workspaceId, authTenantId: ctx.tenantId, rowId, ...data },
    update: data,
  });
  return { changed: true };
}

/** Remove the decision on one receipt: it follows its vendor rule or the defaults again. */
export async function clearItemDecision(db: PrismaClient, ctx: TaxContext, rowId: string): Promise<SaveDecisionResult> {
  const { count } = await db.taxItemDecision.deleteMany({ where: { authWorkspaceId: ctx.workspaceId, rowId } });
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
  return {
    // The statement about several small items belongs to one receipt, never to a rule.
    rule: { id: row.id, vendorKey: key, vendorLabel: row.vendorLabel, effectiveFrom, ...forRule, severalLowValueItems: false },
    receiptFollowsRule,
  };
}

export async function deleteVendorRule(db: PrismaClient, ctx: TaxContext, ruleId: string): Promise<void> {
  const { count } = await db.taxVendorRule.deleteMany({ where: { id: ruleId, authWorkspaceId: ctx.workspaceId } });
  if (count === 0) throw new TaxServiceError('rule_not_found');
}

/** Called by the row delete paths: a deleted receipt takes its decision with it. */
export async function deleteDecisionsForRows(db: PrismaClient, rowIds: string[]): Promise<void> {
  if (rowIds.length === 0) return;
  await db.taxItemDecision.deleteMany({ where: { rowId: { in: rowIds } } });
  await db.taxReceiptLine.deleteMany({ where: { rowId: { in: rowIds } } });
  // An asset keeps existing without the receipt; with no receipt left it shows
  // up as "no cost" and asks for one, instead of vanishing with its history.
  await db.taxAssetPart.deleteMany({ where: { rowId: { in: rowIds } } });
  await db.taxYearBoundaryAnswer.deleteMany({ where: { subjectKind: 'receipt', subjectId: { in: rowIds } } });
  // The payments stay; they then show up again as payments without a document.
  await deletePaymentLinksForRows(db, rowIds);
}

export { AssetInputError, LinesInputError, RevenueInputError, TreatmentError };
