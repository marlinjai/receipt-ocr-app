import 'server-only';
import type { Prisma, PrismaClient } from '@prisma/client';
import { rowToMealRecord } from '@/lib/meals/record';
import { allRows, getTaxSettings, guestsByRow, tableContext } from '@/lib/meals/service';
import type { MealGuestEntry } from '@/lib/meals/types';
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
import { resolveItem, type ReceiptFacts, type ResolvedItem, type TreatmentOrigin } from './facts';
import { RULE_YEARS, isFormLineKey, rulesForYear, type FormLine } from './rules';
import type { ItemPart, LineResult, OpenCheck } from './types';

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

export type TaxServiceErrorCode = 'not_initialized' | 'row_not_found' | 'meal_row' | 'no_vendor' | 'invalid_date' | 'rule_not_found';

export class TaxServiceError extends Error {
  readonly code: TaxServiceErrorCode;
  constructor(code: TaxServiceErrorCode) {
    super(code);
    this.name = 'TaxServiceError';
    this.code = code;
  }
}

const BUSINESS_SHARE_COLUMN = 'Business Share %';

function storedTreatment(row: { allocations: Prisma.JsonValue; formLineKey: string | null; employmentLineKey: string | null }): TreatmentInput | null {
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

async function loadReceipts(db: PrismaClient, workspaceId: string, onlyRowId?: string): Promise<LoadedReceipts | null> {
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
  const [guests, decisions] = await Promise.all([
    guestsByRow(db, workspaceId, rowIds),
    rowIds.length === 0
      ? Promise.resolve([])
      : db.taxItemDecision.findMany({ where: { authWorkspaceId: workspaceId, rowId: { in: rowIds } } }),
  ]);
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
    };
  });
  return { facts };
}

/** One item as the finance screens show it: the facts, where its treatment comes from, and what it contributes. */
export interface StatementItem {
  rowId: string;
  label: string;
  vendor: string | null;
  vendorKey: string | null;
  date: string | null;
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
  /** True when the item has its own decision (which can be removed again). */
  hasDecision: boolean;
  vendorRuleId: string | null;
  isMeal: boolean;
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
  formLinesVerified: boolean;
  formLinesSource: { citation: string; url: string; checkedOn: string };
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
  vendorRules: VendorRule[];
  /** False until the Receipts table exists (first dashboard visit). */
  initialized: boolean;
}

function toStatementItem(resolved: ResolvedItem, facts: ReceiptFacts, result: { counted: boolean; parts: ItemPart[]; privateCents: number; checks: OpenCheck[] }): StatementItem {
  const { item } = resolved;
  return {
    rowId: item.id,
    label: item.label,
    vendor: item.vendor,
    vendorKey: resolved.vendorKey,
    date: item.date,
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
    hasDecision: facts.decision !== null,
    vendorRuleId: resolved.vendorRuleId,
    isMeal: resolved.isMeal,
    counted: result.counted,
    parts: result.parts,
    privateCents: result.privateCents,
    checks: result.checks,
  };
}

export async function loadStatement(db: PrismaClient, workspaceId: string, year: number): Promise<StatementView> {
  const [loaded, vendorRules, settings] = await Promise.all([
    loadReceipts(db, workspaceId),
    listVendorRules(db, workspaceId),
    getTaxSettings(db, workspaceId),
  ]);
  const resolvedRules = rulesForYear(year);
  const facts = loaded?.facts ?? [];
  const resolved = facts.map((f) => resolveItem(f, vendorRules, settings));
  const result = computeYear({ year, items: resolved.map((r) => r.item) }, resolvedRules);
  const resultById = new Map(result.items.map((i) => [i.itemId, i]));

  const items: StatementItem[] = [];
  const years = new Set<number>(RULE_YEARS);
  years.add(year);
  resolved.forEach((r, index) => {
    if (r.item.date) years.add(Number(r.item.date.slice(0, 4)));
    const itemResult = resultById.get(r.item.id);
    // computeYear only returns items of the year and undated ones.
    if (itemResult) items.push(toStatementItem(r, facts[index], itemResult));
  });
  items.sort((a, b) => (a.date ?? '') < (b.date ?? '') ? -1 : (a.date ?? '') > (b.date ?? '') ? 1 : a.label.localeCompare(b.label, 'de'));

  const { rules } = resolvedRules;
  return {
    year,
    years: [...years].sort((a, b) => b - a),
    smallBusiness: settings.smallBusiness,
    rulesYear: result.rulesYear,
    rulesExact: result.rulesExact,
    rulesReviewedOn: rules.reviewedOn,
    formLinesVerified: result.formLinesVerified,
    formLinesSource: rules.formLinesSource,
    formLines: rules.formLines.map((l) => ({ ...l, line: rules.formLinesVerified ? l.line : null })),
    lines: result.lines,
    businessExpenseCents: result.businessExpenseCents,
    employmentCostCents: result.employmentCostCents,
    privateCents: result.privateCents,
    countedItems: result.countedItems,
    blockedItems: result.blockedItems,
    items,
    vendorRules,
    initialized: loaded !== null,
  };
}

async function requireOrdinaryRow(db: PrismaClient, ctx: TaxContext, rowId: string): Promise<ReceiptFacts> {
  const loaded = await loadReceipts(db, ctx.workspaceId, rowId);
  if (!loaded) throw new TaxServiceError('not_initialized');
  const facts = loaded.facts[0];
  if (!facts) throw new TaxServiceError('row_not_found');
  const settings = await getTaxSettings(db, ctx.workspaceId);
  // What a meal is worth is decided by the meal register alone.
  if (resolveItem(facts, [], settings).isMeal) throw new TaxServiceError('meal_row');
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
  return { id: row.id, vendorKey: key, vendorLabel: row.vendorLabel, effectiveFrom, ...treatment };
}

export async function deleteVendorRule(db: PrismaClient, ctx: TaxContext, ruleId: string): Promise<void> {
  const { count } = await db.taxVendorRule.deleteMany({ where: { id: ruleId, authWorkspaceId: ctx.workspaceId } });
  if (count === 0) throw new TaxServiceError('rule_not_found');
}

/** Called by the row delete paths: a deleted receipt takes its decision with it. */
export async function deleteDecisionsForRows(db: PrismaClient, rowIds: string[]): Promise<void> {
  if (rowIds.length === 0) return;
  await db.taxItemDecision.deleteMany({ where: { rowId: { in: rowIds } } });
}

export { TreatmentError };
