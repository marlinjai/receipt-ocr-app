import 'server-only';
import type { Prisma, PrismaClient } from '@prisma/client';
import type { CellValue } from '@marlinjai/data-table-core';
import { getTaxSettings, tableContext } from '@/lib/meals/service';
import type { MealTaxSettings } from '@/lib/meals/types';
import { BUSINESS, PRIVATE, UNIVERSITY, editedAllocations, treatmentToCells, type AssignmentEdit } from './assignment';
import { TreatmentError, validateTreatment, vendorKey, type VendorRule } from './decisions';
import { CATEGORY_FORM_LINE, DEFAULT_EMPLOYMENT_LINE, DEFAULT_STUDY_LINE } from './defaults';
import { resolveItem, type ReceiptFacts, type ResolvedItem } from './facts';
import { RULE_YEARS, rulesForYear } from './rules';
import type { FormLineKey } from './rules/types';
import { listVendorRules, loadReceipts, type TaxContext } from './service';
import type { Allocation } from './types';

/**
 * Keeps the "Zuordnung" and "Business Share %" cells of every receipt in step
 * with the one source of who bears it (see `assignment.ts`):
 *
 *  - `syncAssignmentCells` writes the cells from the resolved treatment
 *    wherever a decision or a vendor rule decides it, keeping first what they
 *    held before (`tax_assignment_origins`, reason "decided"), and gives them
 *    that back once neither decides any more. A private receipt without either
 *    gets share 0; the share it held is kept too (reason "private_share") and
 *    returns when it stops being private. Nothing a person typed is lost.
 *    Writes of decisions, vendor rules, uploads, retakes, rereads, imports,
 *    unarchives, new rows and table edits of vendor, date or category end with
 *    it; the one-time migration is the same call over a workspace.
 *  - `routeAssignmentEdit` turns an edit of those cells in the table (one cell
 *    or "Set field" on a selection) into a decision where one decides the
 *    receipt. The decision is written FIRST and the cells after it, so a
 *    failure in between leaves at most stale cells, which the next sync of
 *    that receipt (or a run of the script) repairs, never a figure the table
 *    does not show.
 *
 * Rows the meal register judges keep their cells as the register's input; no
 * decision applies to them.
 */

const ZUORDNUNG = 'Zuordnung';
const SHARE = 'Business Share %';
/** Edits of these columns can change which vendor rule applies, or make a receipt a meal. */
const TREATMENT_INPUTS = ['Vendor', 'Date', 'Category'];

export class AssignmentEditError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AssignmentEditError';
  }
}

export interface CellValues {
  zuordnung: string | null;
  sharePercent: number | null;
}

type KeptReason = 'decided' | 'private_share';

export interface Kept {
  values: CellValues;
  reason: KeptReason;
}

export interface PlannedCells {
  rowId: string;
  /**
   * Why: the receipt's own decision, its vendor rule, a private receipt's
   * share, or "restore" (neither decides it any more: the cells get back what
   * they held before one did).
   */
  origin: 'item' | 'vendor_rule' | 'legacy_columns' | 'restore';
  from: CellValues;
  /** The cells to write; null when they already say it. */
  to: CellValues | null;
  /** What happens to the kept values: created from `from`, re-labelled, or dropped. */
  kept: { op: 'create'; reason: KeptReason } | { op: 'relabel'; reason: KeptReason } | { op: 'drop' } | null;
}

/** The treatment of the whole receipt (lines aside), as the finance area resolves it. */
function wholeReceipt(facts: ReceiptFacts, rules: readonly VendorRule[], settings: MealTaxSettings): ResolvedItem {
  return resolveItem({ ...facts, lines: [] }, rules, settings);
}

const decidedBy = (resolved: ResolvedItem): 'item' | 'vendor_rule' | null =>
  (resolved.allocationOrigin === 'item' || resolved.allocationOrigin === 'vendor_rule') && resolved.item.allocations ? resolved.allocationOrigin : null;

const sameCells = (a: CellValues, b: CellValues) =>
  a.zuordnung === b.zuordnung && (a.sharePercent === null ? b.sharePercent === null : b.sharePercent !== null && Number(a.sharePercent) === Number(b.sharePercent));

const isPrivateWithShare = (v: CellValues) => v.zuordnung === PRIVATE && v.sharePercent !== 0;

function planFor(facts: ReceiptFacts, resolved: ResolvedItem, kept: Kept | undefined): PlannedCells | null {
  const rowId = facts.record.rowId;
  const from: CellValues = { zuordnung: facts.record.zuordnung, sharePercent: facts.businessSharePercent };
  const plan = (origin: PlannedCells['origin'], to: CellValues | null, keptOp: PlannedCells['kept']): PlannedCells | null =>
    to === null && keptOp === null ? null : { rowId, origin, from, to: to && sameCells(from, to) ? null : to, kept: keptOp };

  // A receipt that became a meal is judged by the register from its own cell:
  // what a decision or a rule wrote there is taken back, exactly.
  if (resolved.isMeal) return kept?.reason === 'decided' ? plan('restore', kept.values, { op: 'drop' }) : null;

  const by = decidedBy(resolved);
  if (by) {
    const shown = treatmentToCells(resolved.item.allocations!);
    // The values from before the first decision are what is kept: a private
    // share kept earlier is exactly that, it only changes its label.
    const keptOp: PlannedCells['kept'] = !kept ? { op: 'create', reason: 'decided' } : kept.reason === 'private_share' ? { op: 'relabel', reason: 'decided' } : null;
    const p = plan(by, shown, keptOp);
    return p && (p.to || p.kept) ? p : null;
  }

  if (kept?.reason === 'decided') {
    // Nothing decides the receipt any more: its cells come back. A private one
    // shows share 0, and the share it held stays kept for when it stops being private.
    if (isPrivateWithShare(kept.values)) return plan('restore', { zuordnung: PRIVATE, sharePercent: 0 }, { op: 'relabel', reason: 'private_share' });
    return plan('restore', kept.values, { op: 'drop' });
  }
  if (resolved.allocationOrigin !== 'legacy_columns' || !isPrivateWithShare(from)) return null;
  return plan('legacy_columns', { zuordnung: PRIVATE, sharePercent: 0 }, kept ? null : { op: 'create', reason: 'private_share' });
}

export interface PlanScope {
  /** Only these rows. */
  rowIds?: readonly string[];
  /** Only receipts of this vendor (as the finance area keys vendors). */
  vendor?: string;
  /**
   * Only what a change of treatment calls for (a decision or rule taking over,
   * or letting go), not the share 0 of a private receipt nothing decides: for a
   * follow-up after a write that cannot have changed whether a receipt is private.
   */
  treatmentOnly?: boolean;
}

async function keptOf(db: PrismaClient, workspaceId: string, rowIds?: readonly string[]): Promise<Map<string, Kept>> {
  const rows = await db.taxAssignmentOrigin.findMany({ where: { authWorkspaceId: workspaceId, ...(rowIds ? { rowId: { in: [...rowIds] } } : {}) } });
  return new Map(rows.map((o) => [o.rowId, { values: { zuordnung: o.zuordnung, sharePercent: o.sharePercent }, reason: o.reason === 'private_share' ? 'private_share' : 'decided' }]));
}

/** What `syncAssignmentCells` would do, without doing it. */
export async function plannedAssignmentCells(db: PrismaClient, workspaceId: string, scope: PlanScope = {}): Promise<PlannedCells[]> {
  const only = scope.rowIds ? new Set(scope.rowIds) : null;
  if (only && only.size === 0) return [];
  const key = scope.vendor === undefined ? undefined : vendorKey(scope.vendor);
  const [loaded, rules, settings, kept] = await Promise.all([
    loadReceipts(db, workspaceId, only && only.size === 1 ? [...only][0] : undefined),
    listVendorRules(db, workspaceId),
    getTaxSettings(db, workspaceId),
    keptOf(db, workspaceId, only ? [...only] : undefined),
  ]);
  const plans: PlannedCells[] = [];
  for (const facts of loaded?.facts ?? []) {
    if (only && !only.has(facts.record.rowId)) continue;
    if (key !== undefined && vendorKey(facts.record.vendor) !== key) continue;
    const plan = planFor(facts, wholeReceipt(facts, rules, settings), kept.get(facts.record.rowId));
    if (plan && !(scope.treatmentOnly && plan.origin === 'legacy_columns')) plans.push(plan);
  }
  return plans;
}

/**
 * Rows whose "Business Share %" is not theirs to set: a decision or a vendor
 * rule decides them, or they are private (share 0). The overview's per-vendor
 * share ("apply to ledger") leaves these alone, so it can never make the cells
 * disagree with the finance area.
 */
export async function rowsWithDerivedShare(db: PrismaClient, workspaceId: string): Promise<Set<string>> {
  const [loaded, rules, settings] = await Promise.all([loadReceipts(db, workspaceId), listVendorRules(db, workspaceId), getTaxSettings(db, workspaceId)]);
  const out = new Set<string>();
  for (const facts of loaded?.facts ?? []) {
    const resolved = wholeReceipt(facts, rules, settings);
    if (resolved.isMeal) continue;
    if (decidedBy(resolved) || facts.record.zuordnung === PRIVATE) out.add(facts.record.rowId);
  }
  return out;
}

interface AssignmentColumns {
  adapter: NonNullable<Awaited<ReturnType<typeof tableContext>>>['adapter'];
  zuordnungId: string;
  shareId: string;
  optionId: (name: string) => string;
  optionName: (id: unknown) => string | null;
  /** Column ids of vendor, date and category. */
  inputIds: string[];
  /** Why the cells cannot be written (a column or an option renamed or deleted); null when they can. */
  problem: string | null;
}

const ASSIGNMENT_OPTIONS = [BUSINESS, UNIVERSITY, PRIVATE];

/**
 * The two columns and the options the cells are written with. Null when the
 * workspace has no receipts table yet. `problem` names a column or one of the
 * three options that is missing (renamed or deleted in the table).
 */
async function assignmentColumns(db: PrismaClient, workspaceId: string): Promise<AssignmentColumns | null> {
  const ctx = await tableContext(db, workspaceId);
  if (!ctx) return null;
  const zuordnung = ctx.columns.find((c) => c.name === ZUORDNUNG);
  const share = ctx.columns.find((c) => c.name === SHARE);
  const options = zuordnung ? (ctx.selectOptions.get(zuordnung.id) ?? (await ctx.adapter.getSelectOptions(zuordnung.id))) : [];
  const missing = ASSIGNMENT_OPTIONS.filter((name) => !options.some((o) => o.name === name));
  const problem = !zuordnung || !share
    ? 'Der Tabelle fehlt die Spalte "Zuordnung" oder "Business Share %".'
    : missing.length > 0
      ? `Der Spalte "Zuordnung" fehlt die Auswahl ${missing.map((m) => `"${m}"`).join(', ')}.`
      : null;
  return {
    adapter: ctx.adapter,
    zuordnungId: zuordnung?.id ?? '',
    shareId: share?.id ?? '',
    optionId: (name) => {
      const id = options.find((o) => o.name === name)?.id;
      if (!id) throw new AssignmentEditError(problem ?? `Der Spalte "Zuordnung" fehlt die Auswahl "${name}".`);
      return id;
    },
    optionName: (id) => options.find((o) => o.id === id)?.name ?? null,
    inputIds: ctx.columns.filter((c) => TREATMENT_INPUTS.includes(c.name)).map((c) => c.id),
    problem,
  };
}

async function writableColumns(db: PrismaClient, workspaceId: string): Promise<AssignmentColumns | null> {
  const cols = await assignmentColumns(db, workspaceId);
  if (cols?.problem) throw new AssignmentEditError(cols.problem);
  return cols;
}

/**
 * Refuse up front, before a decision or a rule is written, when its cells could
 * not be written: a decision is never stored that the table could not show.
 */
export async function assertAssignmentColumns(db: PrismaClient, workspaceId: string): Promise<void> {
  await writableColumns(db, workspaceId);
}

export interface SyncResult {
  /** Rows whose cells were written. */
  written: number;
  /** Rows that could not be brought in step (each logged); the others were. */
  failed: string[];
}

async function applyKept(db: PrismaClient, ctx: TaxContext, rowId: string, from: CellValues, op: NonNullable<PlannedCells['kept']>) {
  if (op.op === 'create') {
    await db.taxAssignmentOrigin.upsert({
      where: { rowId },
      create: { authWorkspaceId: ctx.workspaceId, authTenantId: ctx.tenantId, rowId, zuordnung: from.zuordnung, sharePercent: from.sharePercent, reason: op.reason },
      update: {},
    });
  } else if (op.op === 'relabel') {
    await db.taxAssignmentOrigin.updateMany({ where: { authWorkspaceId: ctx.workspaceId, rowId }, data: { reason: op.reason } });
  } else {
    await db.taxAssignmentOrigin.deleteMany({ where: { authWorkspaceId: ctx.workspaceId, rowId } });
  }
}

/**
 * Carry out planned writes, row by row. A row that fails is logged and
 * reported; the others are still written.
 */
export async function writeAssignmentCells(db: PrismaClient, ctx: TaxContext, plans: readonly PlannedCells[]): Promise<SyncResult> {
  const result: SyncResult = { written: 0, failed: [] };
  if (plans.length === 0) return result;
  const cols = await writableColumns(db, ctx.workspaceId);
  if (!cols) throw new Error('the receipts table does not exist');
  for (const plan of plans) {
    try {
      // What the cells held is kept BEFORE they are overwritten; it is dropped only after.
      if (plan.kept && plan.kept.op !== 'drop') await applyKept(db, ctx, plan.rowId, plan.from, plan.kept);
      if (plan.to) {
        await cols.adapter.updateRow(plan.rowId, {
          [cols.zuordnungId]: plan.to.zuordnung === null ? null : cols.optionId(plan.to.zuordnung),
          [cols.shareId]: plan.to.sharePercent,
        });
        result.written += 1;
      }
      if (plan.kept?.op === 'drop') await applyKept(db, ctx, plan.rowId, plan.from, plan.kept);
    } catch (err) {
      console.error('[assignment] a receipt could not be brought in step:', err instanceof Error ? `${err.name}: ${err.message}` : 'error');
      result.failed.push(plan.rowId);
    }
  }
  return result;
}

/** Bring the cells of these receipts (all of the workspace when no scope is given) in step with their treatment. */
export async function syncAssignmentCells(db: PrismaClient, ctx: TaxContext, scope: PlanScope = {}): Promise<SyncResult> {
  return writeAssignmentCells(db, ctx, await plannedAssignmentCells(db, ctx.workspaceId, scope));
}

/**
 * The same for a write that already succeeded (an upload, an import, a row
 * created or unarchived): a failure is logged and never undoes that write.
 * The receipt is brought in step by the next write that touches it, or by a run
 * of `scripts/sync-assignment-cells.ts`.
 */
export async function followTreatment(db: PrismaClient, ctx: TaxContext, scope: PlanScope = {}): Promise<void> {
  try {
    const { failed } = await syncAssignmentCells(db, ctx, scope);
    if (failed.length > 0) console.error(`[assignment] ${failed.length} receipt(s) not in step after a write`);
  } catch (err) {
    console.error('[assignment] bringing the cells in step failed:', err instanceof Error ? `${err.name}: ${err.message}` : 'error');
  }
}

function linesFor(allocations: readonly Allocation[], category: string | null, keep: { formLineKey: FormLineKey | null; employmentLineKey: FormLineKey | null }) {
  const has = (purposes: Allocation['purpose'][]) => allocations.some((a) => purposes.includes(a.purpose) && a.shareBp > 0);
  const byCategory = category ? CATEGORY_FORM_LINE[category] : undefined;
  const formLineKey = has(['business']) ? (keep.formLineKey ?? (byCategory && byCategory !== 'euer.meals' ? byCategory : null)) : null;
  const employmentLineKey = has(['study', 'employment'])
    ? (keep.employmentLineKey ?? (has(['study']) ? DEFAULT_STUDY_LINE : DEFAULT_EMPLOYMENT_LINE))
    : null;
  return { formLineKey, employmentLineKey };
}

/** The same treatment, an explicit private part or not. */
const sameAllocations = (a: readonly Allocation[], b: readonly Allocation[]) => {
  const own = (list: readonly Allocation[]) => list.filter((x) => x.purpose !== 'private' && x.shareBp > 0);
  const x = own(a);
  const y = own(b);
  return x.length === y.length && x.every((v, i) => v.purpose === y[i].purpose && v.shareBp === y[i].shareBp);
};

/**
 * What one edit pass reads once: columns, receipts, kept values, vendor rules,
 * settings. "Set field" on a selection shares one for all its rows (each edit
 * touches only its own row, so the other rows' facts stay true) and collects
 * the rows whose vendor, date or category changed in `followRows`, to bring
 * them in step in one go at the end.
 */
export interface AssignmentEditContext {
  cols: AssignmentColumns | null;
  facts: Map<string, ReceiptFacts>;
  kept: Map<string, Kept>;
  rules: VendorRule[];
  settings: MealTaxSettings;
  followRows?: string[];
}

export async function assignmentEditContext(db: PrismaClient, workspaceId: string, onlyRowId?: string): Promise<AssignmentEditContext> {
  const [cols, loaded, kept, rules, settings] = await Promise.all([
    assignmentColumns(db, workspaceId),
    loadReceipts(db, workspaceId, onlyRowId),
    keptOf(db, workspaceId, onlyRowId ? [onlyRowId] : undefined),
    listVendorRules(db, workspaceId),
    getTaxSettings(db, workspaceId),
  ]);
  return { cols, facts: new Map((loaded?.facts ?? []).map((f) => [f.record.rowId, f])), kept, rules, settings };
}

export interface RoutedEdit {
  /** The cells to write in place of the edit (other columns pass through). */
  cells: Record<string, CellValue>;
  /** Run after the cells were written: follows up a change of vendor, date or category. */
  afterWrite: () => Promise<void>;
  /** True when `afterWrite` may write the row's cells again, so a caller showing the row reads it back. */
  rewrites: boolean;
}

const nothingAfter = async () => {};

/**
 * An edit of one receipt's cells, before it is written.
 *
 * - The receipt has a decision or a vendor rule: the edit becomes a decision on
 *   the receipt (keeping its statement lines, checked like any decision),
 *   stored before the cells, which then show it. An edit that changes nothing
 *   creates no decision. Clearing the assignment removes the receipt's own
 *   decision (its rule then shows again). Where the edit cannot become a
 *   decision (only a rule decides and the edit clears it, the receipt is part
 *   of an asset, or no statement line fits), the cells keep showing what
 *   decides the receipt: the edit does not land, and the row read back says so.
 * - Neither: the cells are the source and are written as given; a private
 *   receipt gets share 0 (the share it held is kept), and one leaving "Privat"
 *   without a share gets that kept share back, else the whole.
 * - A meal, a group, a row the finance area does not know: written as given.
 * - An edit of vendor, date or category: after the write the cells follow
 *   whatever rule (or meal register) now applies.
 */
export async function routeAssignmentEdit(
  db: PrismaClient,
  ctx: TaxContext,
  rowId: string,
  cells: Record<string, CellValue>,
  shared?: AssignmentEditContext,
): Promise<RoutedEdit> {
  const quick = shared ? shared.cols : await assignmentColumns(db, ctx.workspaceId);
  if (!quick) return { cells, afterWrite: nothingAfter, rewrites: false };
  const touchesAssignment = quick.zuordnungId in cells || quick.shareId in cells;
  const touchesInputs = quick.inputIds.some((id) => id in cells);
  if (!touchesAssignment && !touchesInputs) return { cells, afterWrite: nothingAfter, rewrites: false };

  const follow = !touchesInputs
    ? nothingAfter
    : shared?.followRows
      ? async () => {
          shared.followRows!.push(rowId);
        }
      : async () => {
          await followTreatment(db, ctx, { rowIds: [rowId] });
        };
  const rewrites = touchesInputs && !shared?.followRows;
  const pass = (out: Record<string, CellValue>): RoutedEdit => ({ cells: out, afterWrite: follow, rewrites });
  if (!touchesAssignment) return pass(cells);
  if (quick.problem) throw new AssignmentEditError(quick.problem);

  const loaded = shared ?? (await assignmentEditContext(db, ctx.workspaceId, rowId));
  const cols = quick;
  const edit: AssignmentEdit = {};
  if (cols.zuordnungId in cells) {
    const value = cells[cols.zuordnungId];
    edit.zuordnung = value === null || value === undefined || value === '' ? null : cols.optionName(value);
    if (edit.zuordnung === null && value) throw new AssignmentEditError('Diese Zuordnung gibt es nicht.');
  }
  if (cols.shareId in cells) {
    const value = cells[cols.shareId];
    edit.sharePercent = value === null || value === undefined || value === '' ? null : Number(value);
  }

  const facts = loaded.facts.get(rowId);
  if (!facts) return pass(cells);
  const resolved = wholeReceipt(facts, loaded.rules, loaded.settings);
  if (resolved.isMeal) return pass(cells);
  const kept = loaded.kept.get(rowId);
  const before: CellValues = { zuordnung: facts.record.zuordnung, sharePercent: facts.businessSharePercent };

  const out = { ...cells };
  const by = decidedBy(resolved);
  if (!by) {
    const zuordnung = edit.zuordnung !== undefined ? edit.zuordnung : facts.record.zuordnung;
    if (zuordnung === PRIVATE) {
      out[cols.shareId] = 0;
      // The share the receipt held is kept, so turning it back gives it back.
      if (!kept && before.zuordnung !== PRIVATE && before.sharePercent !== 0) {
        await applyKept(db, ctx, rowId, { zuordnung: PRIVATE, sharePercent: before.sharePercent }, { op: 'create', reason: 'private_share' });
      } else if (!kept && isPrivateWithShare(before)) {
        await applyKept(db, ctx, rowId, before, { op: 'create', reason: 'private_share' });
      }
    } else if (zuordnung && facts.record.zuordnung === PRIVATE && edit.sharePercent === undefined) {
      // Leaving "Privat" without a share: the share kept from before, else the whole, as an upload stores it.
      out[cols.shareId] = kept?.reason === 'private_share' && kept.values.sharePercent !== null && kept.values.sharePercent !== 0 ? kept.values.sharePercent : 100;
      if (kept?.reason === 'private_share') await applyKept(db, ctx, rowId, before, { op: 'drop' });
    }
    return pass(out);
  }

  const current = resolved.item.allocations!;
  const shownNow = treatmentToCells(current);
  const showDecided = (): RoutedEdit => {
    out[cols.zuordnungId] = cols.optionId(shownNow.zuordnung);
    out[cols.shareId] = shownNow.sharePercent;
    return pass(out);
  };
  // The table shows whole percent: typing back the shown, rounded share of a
  // decided 33.33 % changes nothing.
  if (edit.sharePercent !== undefined && edit.sharePercent !== null && (edit.zuordnung === undefined || edit.zuordnung === shownNow.zuordnung) && Math.round(shownNow.sharePercent) === edit.sharePercent) {
    delete edit.sharePercent;
  }
  const inAsset = (await db.taxAssetPart.count({ where: { authWorkspaceId: ctx.workspaceId, rowId } })) > 0;
  if (inAsset) {
    console.warn('[assignment] an edit of a receipt in an asset is not stored: the asset register decides it');
    return showDecided();
  }
  const allocations = editedAllocations(current, edit);
  const decision = await db.taxItemDecision.findFirst({ where: { rowId, authWorkspaceId: ctx.workspaceId } });

  if (allocations === null) {
    if (by !== 'item' || !decision) return showDecided();
    await db.taxItemDecision.deleteMany({ where: { rowId, authWorkspaceId: ctx.workspaceId } });
    const underneath = wholeReceipt({ ...facts, decision: null }, loaded.rules, loaded.settings);
    if (decidedBy(underneath)) {
      // A vendor rule decides the receipt now: the cells show it (the kept values stay for when it goes).
      const shown = treatmentToCells(underneath.item.allocations!);
      out[cols.zuordnungId] = cols.optionId(shown.zuordnung);
      out[cols.shareId] = shown.sharePercent;
    } else if (kept?.reason === 'decided') {
      // The person emptied the assignment: that is the receipt's state now, not what it held before.
      await applyKept(db, ctx, rowId, before, { op: 'drop' });
    }
    return pass(out);
  }

  // Re-selecting what is shown (or clearing the share) changes nothing: no
  // decision, so a receipt its rule decides keeps following the rule.
  if (sameAllocations(allocations, current)) return showDecided();

  const lines = linesFor(allocations, facts.record.category, {
    formLineKey: (decision?.formLineKey as FormLineKey | null) ?? resolved.item.formLineKey,
    employmentLineKey: (decision?.employmentLineKey as FormLineKey | null) ?? resolved.item.employmentLineKey,
  });
  const year = facts.record.date ? Number(facts.record.date.slice(0, 4)) : Math.max(...RULE_YEARS);
  let treatment;
  try {
    treatment = validateTreatment(
      { allocations, formLineKey: lines.formLineKey, employmentLineKey: lines.employmentLineKey, severalLowValueItems: decision?.severalLowValueItems ?? false },
      rulesForYear(year).rules,
    );
  } catch (err) {
    if (!(err instanceof TreatmentError)) throw err;
    console.warn(`[assignment] an edit needs a statement line the receipt has none for (${err.code}): it is decided under Finanzen`);
    return showDecided();
  }
  const data = {
    allocations: treatment.allocations as unknown as Prisma.InputJsonValue,
    formLineKey: treatment.formLineKey,
    employmentLineKey: treatment.employmentLineKey,
    severalLowValueItems: treatment.severalLowValueItems === true,
  };
  // The source first: what the cells hold is kept, the decision is stored, and
  // only then are the cells written to show it.
  if (!kept) await applyKept(db, ctx, rowId, before, { op: 'create', reason: 'decided' });
  else if (kept.reason === 'private_share') await applyKept(db, ctx, rowId, before, { op: 'relabel', reason: 'decided' });
  await db.taxItemDecision.upsert({
    where: { rowId },
    create: { authWorkspaceId: ctx.workspaceId, authTenantId: ctx.tenantId, rowId, ...data },
    update: data,
  });
  const shown = treatmentToCells(treatment.allocations);
  out[cols.zuordnungId] = cols.optionId(shown.zuordnung);
  out[cols.shareId] = shown.sharePercent;
  return pass(out);
}
