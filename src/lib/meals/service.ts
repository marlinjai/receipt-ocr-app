import 'server-only';
import { PrismaAdapter } from '@marlinjai/data-table-adapter-prisma';
import type { CellValue, Column, Row } from '@marlinjai/data-table-core';
import type { PrismaClient } from '@prisma/client';
import { PrismaContactStore } from '@/lib/contacts/prisma-store';
import { companyContacts, sharedContactsEnabled } from '@/lib/contacts/db';
import { SharedContactStore } from '@/lib/contacts/shared-store';
import { MissingTenantError } from '@/lib/auth-workspace';
import type { ContactStore } from '@/lib/contacts/store';
import {
  MEAL_COLUMNS,
  consumptionLabel,
  mealTypeLabel,
} from '@/lib/receipts-constants';
import type { MealTypeKey } from '@/lib/receipts-constants';
import type { MealBatchResult, MealBatchSkip } from './batch';
import { inputFromRecord, normalizeMealInput, sameMealInput, type MealDetailsInput } from './input';
import { rowToMealRecord, type SelectOptionsByColumn } from './record';
import { isDismissedMeal, isMealRelated, serializeTaxLines } from './rules';
import { parseRotation, type Rotation } from './viewer-state';
import { DEFAULT_TAX_SETTINGS, type MealGuestEntry, type MealRecord, type MealTaxSettings } from './types';

/**
 * Server-side reads and writes for the meal register.
 *
 * Every function takes the workspace explicitly (`MealContext`), resolved by
 * the caller from the verified session and never from anything the browser
 * sent. A row is only ever addressed through the workspace's own Receipts
 * table, so a row id from another workspace behaves like one that does not
 * exist. That makes this module testable against a real database without the
 * auth stack.
 */

const TABLE_NAME = 'Receipts';
const SELECT_COLUMNS = ['Category', 'Zuordnung', 'Currency', MEAL_COLUMNS.mealType, MEAL_COLUMNS.consumption];

export interface MealContext {
  workspaceId: string;
  /** Stamped on created rows; null only for the development bypass. */
  tenantId: string | null;
}

export type MealServiceErrorCode =
  | 'not_initialized'
  | 'row_not_found'
  | 'unknown_contact'
  | 'archived_contact'
  | 'schema_outdated'
  | 'invalid_rotation';

export class MealServiceError extends Error {
  readonly code: MealServiceErrorCode;
  constructor(code: MealServiceErrorCode, detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'MealServiceError';
    this.code = code;
  }
}

export interface TableContext {
  adapter: PrismaAdapter;
  tableId: string;
  columns: Column[];
  selectOptions: SelectOptionsByColumn;
}

/** The workspace's Receipts table with its columns and select options, or null before the first dashboard visit. */
export async function tableContext(db: PrismaClient, workspaceId: string): Promise<TableContext | null> {
  const adapter = new PrismaAdapter({ prisma: db });
  const tables = await adapter.listTables(workspaceId);
  const table = tables.find((t) => t.name === TABLE_NAME);
  if (!table) return null;
  const columns = await adapter.getColumns(table.id);
  const selectOptions: SelectOptionsByColumn = new Map();
  await Promise.all(
    columns
      .filter((c) => SELECT_COLUMNS.includes(c.name))
      .map(async (c) => {
        selectOptions.set(c.id, await adapter.getSelectOptions(c.id));
      }),
  );
  return { adapter, tableId: table.id, columns, selectOptions };
}

export async function allRows(adapter: PrismaAdapter, tableId: string): Promise<Row[]> {
  const out: Row[] = [];
  let offset = 0;
  const limit = 500;
  for (;;) {
    const page = await adapter.getRows(tableId, { limit, offset, include: ['files'] });
    out.push(...page.items);
    if (!page.hasMore || page.items.length === 0) break;
    offset += page.items.length;
  }
  return out;
}

export async function guestsByRow(
  db: PrismaClient,
  workspaceId: string,
  rowIds: string[],
): Promise<Map<string, MealGuestEntry[]>> {
  const out = new Map<string, MealGuestEntry[]>();
  if (rowIds.length === 0) return out;
  const guests = await db.mealGuest.findMany({
    where: { authWorkspaceId: workspaceId, rowId: { in: rowIds } },
    orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
  });
  for (const g of guests) {
    const list = out.get(g.rowId) ?? [];
    list.push({ contactId: g.contactId, name: g.displayName, company: g.displayCompany });
    out.set(g.rowId, list);
  }
  return out;
}

/**
 * The contact list for this request. The suite's shared database when the
 * `CONTACTS_STORE=shared` switch is on (scoped to the company), otherwise the
 * app's own table. The switch is read per call, so it is one place to change.
 */
export function contactStore(db: PrismaClient, ctx: MealContext): ContactStore {
  if (!sharedContactsEnabled()) return new PrismaContactStore(db, ctx.workspaceId, ctx.tenantId);
  if (!ctx.tenantId) throw new MissingTenantError();
  return new SharedContactStore(companyContacts(ctx.tenantId), db);
}

/**
 * Every row of the workspace that has anything to do with the register: the
 * register entries, the incomplete ones, and the meals recorded separately.
 * Rows of other categories are left out.
 *
 * `includeDismissed` adds the "Bewirtung" receipts marked "Keine Bewirtung",
 * which the meals page lists so they can be taken back. The register, its
 * exports and the open count never ask for them.
 */
export async function loadMealRecords(
  db: PrismaClient,
  workspaceId: string,
  options: { includeDismissed?: boolean } = {},
): Promise<MealRecord[]> {
  const ctx = await tableContext(db, workspaceId);
  if (!ctx) return [];
  const rows = await allRows(ctx.adapter, ctx.tableId);
  const noGuests: MealGuestEntry[] = [];
  const candidates = rows
    .filter((r) => !r.archived)
    .map((r) => rowToMealRecord(r, ctx.columns, ctx.selectOptions, noGuests))
    .filter((r) => isMealRelated(r) || (options.includeDismissed === true && isDismissedMeal(r)));
  const guests = await guestsByRow(db, workspaceId, candidates.map((r) => r.rowId));
  return candidates.map((r) => ({ ...r, guests: guests.get(r.rowId) ?? [] }));
}

/** One row as a meal record, whatever its category. Null when the row is not in this workspace. */
export async function loadMealRecord(
  db: PrismaClient,
  workspaceId: string,
  rowId: string,
): Promise<MealRecord | null> {
  const ctx = await tableContext(db, workspaceId);
  if (!ctx) return null;
  return loadWithContext(db, workspaceId, ctx, rowId);
}

/**
 * Assumption worth knowing: `adapter.getRow` only searches tables the adapter
 * has migrated to their own physical table. Every Receipts table is migrated
 * the first time its rows are listed (`getRows` does it), and nothing reaches
 * a single meal without the dashboard or the meals page having listed rows
 * first, so this holds in practice. A row in a never-listed table reads as
 * "not found", which is the safe direction.
 */
async function loadWithContext(
  db: PrismaClient,
  workspaceId: string,
  ctx: TableContext,
  rowId: string,
): Promise<MealRecord | null> {
  const row = await ctx.adapter.getRow(rowId);
  // The row must live in THIS workspace's Receipts table.
  if (!row || row.tableId !== ctx.tableId) return null;
  const guests = await guestsByRow(db, workspaceId, [rowId]);
  return rowToMealRecord(row, ctx.columns, ctx.selectOptions, guests.get(rowId) ?? []);
}

export interface SaveMealResult {
  record: MealRecord;
  /** False when the input equals what is stored: nothing was written, the timestamp is untouched. */
  changed: boolean;
}

/**
 * Save the meal details of one row.
 *
 * Saving the same inputs again writes nothing (not even the timestamp), so
 * reopening and confirming an entry does not make it look freshly edited.
 */
export async function saveMealDetails(
  db: PrismaClient,
  mealCtx: MealContext,
  rowId: string,
  rawInput: MealDetailsInput,
  now: () => Date = () => new Date(),
): Promise<SaveMealResult> {
  const input = normalizeMealInput(rawInput);
  const ctx = await tableContext(db, mealCtx.workspaceId);
  if (!ctx) throw new MealServiceError('not_initialized');
  const current = await loadWithContext(db, mealCtx.workspaceId, ctx, rowId);
  if (!current) throw new MealServiceError('row_not_found');

  // The form leaves date and gross alone unless it was shown them empty.
  const stored = inputFromRecord(current);
  const merged: MealDetailsInput = {
    ...input,
    date: input.date ?? stored.date,
    gross: input.gross ?? stored.gross,
  };
  return writeMealInput(db, mealCtx, ctx, current, merged, now);
}

/**
 * Write `merged` (already normalized, date and gross resolved) onto the row
 * of `current`. Shared by the form save and the batch actions, so "Keine
 * Bewirtung" set from a list is exactly the state the form's option sets.
 */
async function writeMealInput(
  db: PrismaClient,
  mealCtx: MealContext,
  ctx: TableContext,
  current: MealRecord,
  merged: MealDetailsInput,
  now: () => Date,
): Promise<SaveMealResult> {
  const rowId = current.rowId;
  const stored = inputFromRecord(current);
  if (sameMealInput(merged, stored)) return { record: current, changed: false };

  // Guests: every id must be a contact of this workspace. An archived contact
  // may stay on a meal it is already on, but cannot be newly added.
  const store = contactStore(db, mealCtx);
  const contacts = await store.getMany(merged.guestContactIds);
  const contactById = new Map(contacts.map((c) => [c.id, c]));
  const alreadyOnMeal = new Set(current.guests.flatMap((g) => (g.contactId ? [g.contactId] : [])));
  for (const id of merged.guestContactIds) {
    const contact = contactById.get(id);
    if (!contact) throw new MealServiceError('unknown_contact', id);
    if (contact.archived && !alreadyOnMeal.has(id)) throw new MealServiceError('archived_contact', id);
  }

  const columnId = (name: string): string => {
    const col = ctx.columns.find((c) => c.name === name);
    if (!col) throw new MealServiceError('schema_outdated', name);
    return col.id;
  };
  const optionId = (columnName: string, optionName: string | null): string | null => {
    if (optionName === null) return null;
    const id = ctx.selectOptions.get(columnId(columnName))?.find((o) => o.name === optionName)?.id;
    if (!id) throw new MealServiceError('schema_outdated', `${columnName}: ${optionName}`);
    return id;
  };

  const cells: Record<string, CellValue> = {
    [columnId(MEAL_COLUMNS.mealType)]: optionId(
      MEAL_COLUMNS.mealType,
      merged.mealType ? mealTypeLabel(merged.mealType) : null,
    ),
    [columnId(MEAL_COLUMNS.occasion)]: merged.occasion,
    [columnId(MEAL_COLUMNS.place)]: merged.place,
    [columnId(MEAL_COLUMNS.host)]: merged.host,
    [columnId(MEAL_COLUMNS.tip)]: merged.tip,
    [columnId(MEAL_COLUMNS.consumption)]: optionId(
      MEAL_COLUMNS.consumption,
      merged.consumption ? consumptionLabel(merged.consumption) : null,
    ),
    [columnId(MEAL_COLUMNS.taxLines)]: serializeTaxLines(merged.taxLines),
    [columnId(MEAL_COLUMNS.detailsAt)]: now().toISOString(),
  };
  if (merged.date !== stored.date) cells[columnId('Date')] = merged.date;
  if (merged.gross !== null && merged.gross !== stored.gross) cells[columnId('Gross')] = merged.gross;

  await ctx.adapter.updateRow(rowId, cells);

  const linkedBefore = current.guests.flatMap((g) => (g.contactId ? [g.contactId] : []));
  const guestsChanged = JSON.stringify(merged.guestContactIds) !== JSON.stringify(linkedBefore);
  if (guestsChanged) {
    await db.$transaction([
      // Only linked guests are replaced; held copies (contact erased) stay as they are.
      db.mealGuest.deleteMany({ where: { authWorkspaceId: mealCtx.workspaceId, rowId, contactId: { not: null } } }),
      db.mealGuest.createMany({
        data: merged.guestContactIds.map((contactId, position) => {
          const contact = contactById.get(contactId)!;
          return {
            authWorkspaceId: mealCtx.workspaceId,
            authTenantId: mealCtx.tenantId,
            rowId,
            contactId,
            position,
            displayName: contact.name,
            displayCompany: contact.companyOrRole,
          };
        }),
      }),
    ]);
  }

  const record = await loadWithContext(db, mealCtx.workspaceId, ctx, rowId);
  if (!record) throw new MealServiceError('row_not_found');
  return { record, changed: true };
}

/**
 * Set the meal type of several receipts and leave every other detail as it
 * is stored. `not_a_meal` takes a receipt out of queue and register (it stays
 * in the books as an ordinary receipt, guests and occasion kept);
 * `business_meal_external` takes it back.
 *
 * A row that is not in this workspace's Receipts table (deleted meanwhile, or
 * an id of another workspace) is skipped as `not_found` and the rest is
 * carried out. Setting the type a row already has counts as done, so a
 * repeated request changes nothing.
 */
export async function setMealTypeForRows(
  db: PrismaClient,
  mealCtx: MealContext,
  rowIds: string[],
  mealType: MealTypeKey,
  now: () => Date = () => new Date(),
): Promise<MealBatchResult> {
  const ctx = await tableContext(db, mealCtx.workspaceId);
  if (!ctx) throw new MealServiceError('not_initialized');
  const result: MealBatchResult = { done: [], records: [], skipped: [] };
  for (const rowId of [...new Set(rowIds)]) {
    try {
      const current = await loadWithContext(db, mealCtx.workspaceId, ctx, rowId);
      if (!current) {
        result.skipped.push({ rowId, reason: 'not_found' });
        continue;
      }
      const { record } = await writeMealInput(db, mealCtx, ctx, current, { ...inputFromRecord(current), mealType }, now);
      result.done.push(rowId);
      result.records.push(record);
    } catch (e) {
      // The table itself is behind (missing column or option): that is true for every row.
      if (e instanceof MealServiceError && e.code === 'schema_outdated') throw e;
      console.error('[meals] setting the meal type failed', { rowId }, e);
      result.skipped.push({ rowId, reason: 'failed' });
    }
  }
  return result;
}

/**
 * Remember how far a receipt file is turned for viewing and printing.
 *
 * The rotation is stored in the metadata of the file REFERENCE (next to the
 * content hash), so it travels with the receipt into the dashboard and the
 * register export. The stored file itself is never touched.
 *
 * The reference must hang on a row of this workspace's Receipts table;
 * anything else (another workspace, a deleted row, a reference of another
 * row) is `row_not_found`. Returns the record as it is stored now.
 */
export async function setReceiptFileRotation(
  db: PrismaClient,
  mealCtx: MealContext,
  rowId: string,
  fileRefId: string,
  rotation: Rotation,
): Promise<MealRecord> {
  if (parseRotation(rotation) === null) throw new MealServiceError('invalid_rotation');
  const ctx = await tableContext(db, mealCtx.workspaceId);
  if (!ctx) throw new MealServiceError('not_initialized');
  const row = await ctx.adapter.getRow(rowId);
  if (!row || row.tableId !== ctx.tableId) throw new MealServiceError('row_not_found');
  const ref = await db.dtFile.findUnique({ where: { id: fileRefId }, select: { rowId: true, metadata: true } });
  if (!ref || ref.rowId !== rowId) throw new MealServiceError('row_not_found');

  const metadata =
    ref.metadata && typeof ref.metadata === 'object' && !Array.isArray(ref.metadata)
      ? (ref.metadata as Record<string, unknown>)
      : {};
  if (parseRotation(metadata.rotation) !== rotation) {
    // Merge: the content hash and the upload source stay.
    await db.dtFile.update({ where: { id: fileRefId }, data: { metadata: { ...metadata, rotation } } });
  }
  const record = await loadWithContext(db, mealCtx.workspaceId, ctx, rowId);
  if (!record) throw new MealServiceError('row_not_found');
  return record;
}

export interface DeleteReceiptsDeps {
  /**
   * Remove one stored file for good. Must resolve when the file is already
   * gone and reject when it could not be removed.
   */
  deleteStoredFile: (fileId: string) => Promise<void>;
}

/**
 * Delete receipts entirely: the stored file, the row with its file references
 * and selections, and its meal guests.
 *
 * Order matters. The stored file goes FIRST and the row only after that
 * succeeded: when the file store refuses, the receipt is reported as
 * `file_delete_failed` and stays complete, instead of the row vanishing while
 * its file lives on with nothing pointing at it. A retry then finds the row
 * again (and a file that is already gone counts as removed). With several
 * files, the ones already removed before a later one failed lose their
 * references, so the kept receipt never points at a file that no longer exists.
 *
 * A stored file that another row still references (the same upload attached
 * twice) is kept; only this row's reference to it goes with the row.
 *
 * Rows outside this workspace's Receipts table are skipped as `not_found`,
 * exactly like rows deleted meanwhile, and the rest is carried out.
 */
export async function deleteReceiptRows(
  db: PrismaClient,
  mealCtx: MealContext,
  rowIds: string[],
  deps: DeleteReceiptsDeps,
): Promise<MealBatchResult> {
  const ctx = await tableContext(db, mealCtx.workspaceId);
  if (!ctx) throw new MealServiceError('not_initialized');
  const result: MealBatchResult = { done: [], records: [], skipped: [] };
  for (const rowId of [...new Set(rowIds)]) {
    let skip: MealBatchSkip | null = null;
    try {
      const row = await ctx.adapter.getRow(rowId);
      if (!row || row.tableId !== ctx.tableId) {
        result.skipped.push({ rowId, reason: 'not_found' });
        continue;
      }

      const refs = await db.dtFile.findMany({ where: { rowId }, select: { fileId: true } });
      const fileIds = [...new Set(refs.map((r) => r.fileId))];
      const sharedRefs = fileIds.length
        ? await db.dtFile.findMany({
            where: { fileId: { in: fileIds }, rowId: { not: rowId } },
            select: { fileId: true },
          })
        : [];
      const shared = new Set(sharedRefs.map((r) => r.fileId));
      const removed: string[] = [];
      for (const fileId of fileIds) {
        if (shared.has(fileId)) continue;
        try {
          await deps.deleteStoredFile(fileId);
          removed.push(fileId);
        } catch (e) {
          console.error('[meals] deleting a stored file failed, the receipt is kept', { rowId, fileId }, e);
          skip = { rowId, reason: 'file_delete_failed' };
          break;
        }
      }
      if (skip) {
        // A deleted file cannot be brought back, so the kept receipt must not keep pointing at it:
        // drop the references to the files that are gone, leaving only ones that still exist.
        if (removed.length > 0) {
          await db.dtFile.deleteMany({ where: { rowId, fileId: { in: removed } } });
        }
        result.skipped.push(skip);
        continue;
      }

      await ctx.adapter.deleteRow(rowId);
      // TaxItemDecision.rowId has no foreign key, and a retry cannot find the deleted row again, so
      // this runs before the guest cleanup: a guest failure must not orphan the decisions.
      // Same cleanup as the other deletion paths (tax/service imports this module, so no helper import).
      await db.taxItemDecision.deleteMany({ where: { rowId } });
      // Same for a link into an asset's cost: the asset then asks for its cost again.
      await db.taxAssetPart.deleteMany({ where: { rowId } });
      await deleteGuestsForRows(db, [rowId]);
      result.done.push(rowId);
    } catch (e) {
      console.error('[meals] deleting a receipt failed', { rowId }, e);
      result.skipped.push({ rowId, reason: 'failed' });
    }
  }
  return result;
}

/** Remove the guests of deleted receipt rows. The caller has already authorized the row delete. */
export async function deleteGuestsForRows(db: PrismaClient, rowIds: string[]): Promise<void> {
  if (rowIds.length === 0) return;
  await db.mealGuest.deleteMany({ where: { rowId: { in: rowIds } } });
}

export async function getTaxSettings(db: PrismaClient, workspaceId: string): Promise<MealTaxSettings> {
  const [row, changes] = await Promise.all([
    db.workspaceTaxSettings.findUnique({ where: { authWorkspaceId: workspaceId } }),
    // Later changes of the section 19 status, each from a day on (recorded in the finance area).
    db.taxStatusChange.findMany({ where: { authWorkspaceId: workspaceId }, orderBy: { effectiveFrom: 'asc' } }),
  ]);
  // Present only when there is a change: a workspace without one reads exactly as before.
  const statusChanges =
    changes.length > 0 ? { statusChanges: changes.map((c) => ({ effectiveFrom: c.effectiveFrom, smallBusiness: c.smallBusiness })) } : {};
  if (!row) return { ...DEFAULT_TAX_SETTINGS, ...statusChanges };
  return { smallBusiness: row.smallBusiness, hostAddressThresholdEur: row.hostAddressThresholdEur, ...statusChanges };
}

export interface TaxSettingsInput {
  smallBusiness: boolean;
  /** Optional: the receipt total above which the receipt must name the host. */
  hostAddressThresholdEur?: number;
}

export class TaxSettingsError extends Error {
  constructor() {
    super('invalid_threshold');
    this.name = 'TaxSettingsError';
  }
}

/** Answer (or change the answer to) the section 19 question, and optionally the host-name threshold. */
export async function saveTaxSettings(
  db: PrismaClient,
  ctx: MealContext,
  input: TaxSettingsInput,
): Promise<MealTaxSettings> {
  const threshold = input.hostAddressThresholdEur;
  if (threshold !== undefined && (!Number.isInteger(threshold) || threshold < 0 || threshold > 100_000)) {
    throw new TaxSettingsError();
  }
  const data = {
    smallBusiness: input.smallBusiness,
    ...(threshold !== undefined ? { hostAddressThresholdEur: threshold } : {}),
  };
  const row = await db.workspaceTaxSettings.upsert({
    where: { authWorkspaceId: ctx.workspaceId },
    create: { authWorkspaceId: ctx.workspaceId, authTenantId: ctx.tenantId, ...data },
    update: data,
  });
  return { smallBusiness: row.smallBusiness, hostAddressThresholdEur: row.hostAddressThresholdEur };
}

/** The host name used most recently among already loaded records, to prefill the form. */
export function lastUsedHost(records: MealRecord[]): string {
  const withHost = records
    .filter((r) => r.host.trim() && r.detailsAt)
    .sort((a, b) => (a.detailsAt! < b.detailsAt! ? 1 : -1));
  return withHost[0]?.host.trim() ?? '';
}

/**
 * The same, as one small query (for the detail panel, which has no reason to
 * load every row of the workspace just to prefill one field).
 */
export async function loadLastUsedHost(db: PrismaClient, workspaceId: string): Promise<string> {
  const ctx = await tableContext(db, workspaceId);
  if (!ctx) return '';
  const hostCol = ctx.columns.find((c) => c.name === MEAL_COLUMNS.host);
  const atCol = ctx.columns.find((c) => c.name === MEAL_COLUMNS.detailsAt);
  if (!hostCol || !atCol) return '';
  const page = await ctx.adapter.getRows(ctx.tableId, {
    filters: [
      { columnId: hostCol.id, operator: 'isNotEmpty', value: null },
      { columnId: atCol.id, operator: 'isNotEmpty', value: null },
    ],
    sorts: [{ columnId: atCol.id, direction: 'desc' }],
    limit: 1,
  });
  const value = page.items[0]?.cells[hostCol.id];
  return typeof value === 'string' ? value.trim() : '';
}
