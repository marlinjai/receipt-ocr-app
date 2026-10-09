import 'server-only';
import type { Prisma, PrismaClient } from '@prisma/client';
import { rowToMealRecord } from '@/lib/meals/record';
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
import { resolveItem, type ReceiptFacts, type ResolvedItem, type TreatmentOrigin } from './facts';
import { RULE_YEARS, isFormLineKey, rulesForYear, type FormLine } from './rules';
import type { FormLineKey } from './rules/types';
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

export type TaxServiceErrorCode =
  | 'not_initialized'
  | 'row_not_found'
  | 'meal_row'
  | 'no_vendor'
  | 'invalid_date'
  | 'rule_not_found'
  | 'asset_not_found'
  | 'asset_row'
  | 'row_in_other_asset';

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
  const [loaded, vendorRules, settings, storedAssets] = await Promise.all([
    loadReceipts(db, workspaceId),
    listVendorRules(db, workspaceId),
    getTaxSettings(db, workspaceId),
    db.taxAsset.findMany({ where: { authWorkspaceId: workspaceId }, include: { parts: true }, orderBy: [{ acquisitionDate: 'asc' }, { createdAt: 'asc' }] }),
  ]);
  const resolvedRules = rulesForYear(year);
  const facts = loaded?.facts ?? [];
  const assetByRow = new Map<string, string>();
  for (const asset of storedAssets) for (const part of asset.parts) assetByRow.set(part.rowId, asset.id);
  const resolved = facts.map((f) => {
    const r = resolveItem(f, vendorRules, settings);
    const assetId = assetByRow.get(r.item.id);
    return assetId ? { ...r, item: { ...r.item, assetId } } : r;
  });
  const itemById = new Map(resolved.map((r) => [r.item.id, r.item]));
  const assetFacts = storedAssets.map((a) => toAssetFact(a, itemById, settings.smallBusiness));
  const result = computeYear({ year, items: resolved.map((r) => r.item), assets: assetFacts }, resolvedRules);
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
      rowIds: stored.parts.map((p) => p.rowId),
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
  rowIds: string[];
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
  parts: Array<{ rowId: string }>;
}

function toAssetFact(
  stored: StoredAsset,
  itemById: Map<string, { amountCents: number | null; netCents?: number | null }>,
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
  for (const part of stored.parts) {
    const item = itemById.get(part.rowId);
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
async function requireAssetRows(db: PrismaClient, ctx: TaxContext, rowIds: string[], ownAssetId: string | null): Promise<void> {
  if (rowIds.length === 0) return;
  const settings = await getTaxSettings(db, ctx.workspaceId);
  for (const rowId of rowIds) {
    const loaded = await loadReceipts(db, ctx.workspaceId, rowId);
    if (!loaded) throw new TaxServiceError('not_initialized');
    const facts = loaded.facts[0];
    if (!facts) throw new TaxServiceError('row_not_found');
    if (resolveItem(facts, [], settings).isMeal) throw new TaxServiceError('meal_row');
  }
  const taken = await db.taxAssetPart.findMany({ where: { rowId: { in: rowIds } } });
  if (taken.some((p) => p.assetId !== ownAssetId)) throw new TaxServiceError('row_in_other_asset');
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
  await requireAssetRows(db, ctx, input.rowIds, null);
  const asset = await db.taxAsset.create({
    data: {
      authWorkspaceId: ctx.workspaceId,
      authTenantId: ctx.tenantId,
      ...assetData(input),
      parts: { create: input.rowIds.map((rowId) => ({ rowId, authWorkspaceId: ctx.workspaceId, authTenantId: ctx.tenantId })) },
    },
  });
  return asset.id;
}

/** Change what was stated about an asset, including which receipts make up its cost. */
export async function updateAsset(db: PrismaClient, ctx: TaxContext, assetId: string, raw: unknown): Promise<void> {
  const input = validateAssetInput(raw);
  const existing = await db.taxAsset.findFirst({ where: { id: assetId, authWorkspaceId: ctx.workspaceId } });
  if (!existing) throw new TaxServiceError('asset_not_found');
  await requireAssetRows(db, ctx, input.rowIds, assetId);
  await db.$transaction([
    db.taxAssetPart.deleteMany({ where: { assetId, rowId: { notIn: input.rowIds } } }),
    db.taxAsset.update({ where: { id: assetId }, data: assetData(input) }),
    db.taxAssetPart.createMany({
      data: input.rowIds.map((rowId) => ({ assetId, rowId, authWorkspaceId: ctx.workspaceId, authTenantId: ctx.tenantId })),
      skipDuplicates: true,
    }),
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

async function requireOrdinaryRow(db: PrismaClient, ctx: TaxContext, rowId: string): Promise<ReceiptFacts> {
  const loaded = await loadReceipts(db, ctx.workspaceId, rowId);
  if (!loaded) throw new TaxServiceError('not_initialized');
  const facts = loaded.facts[0];
  if (!facts) throw new TaxServiceError('row_not_found');
  const settings = await getTaxSettings(db, ctx.workspaceId);
  // What a meal is worth is decided by the meal register alone.
  if (resolveItem(facts, [], settings).isMeal) throw new TaxServiceError('meal_row');
  // A receipt that is part of an asset is treated by the asset register.
  if ((await db.taxAssetPart.count({ where: { rowId } })) > 0) throw new TaxServiceError('asset_row');
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
  // An asset keeps existing without the receipt; with no receipt left it shows
  // up as "no cost" and asks for one, instead of vanishing with its history.
  await db.taxAssetPart.deleteMany({ where: { rowId: { in: rowIds } } });
}

export { AssetInputError, TreatmentError };
