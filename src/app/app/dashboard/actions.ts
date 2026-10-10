'use server';

import { PrismaAdapter } from '@marlinjai/data-table-adapter-prisma';
import { prisma } from '@/lib/prisma';
import { auth } from '@/lib/auth';
import { deleteReceiptRows } from '@/lib/meals/service';
import { deleteStoredFile } from '@/lib/stored-files';
import { tenantIdForWorkspace } from '@/lib/auth-workspace';
import { stampTableOwner } from '@/lib/receipts-table';
import {
  requireReceiptsSession,
  requireTableAccess,
  requireRowAccess,
  requireColumnAccess,
  requireSelectOptionAccess,
  requireViewAccess,
  requireFileRefAccess,
  resolveRowTableIds,
  sessionWorkspaceId,
  ReceiptsAuthError,
} from '@/lib/auth-guards';
import type {
  CreateTableInput,
  UpdateTableInput,
  CreateColumnInput,
  UpdateColumnInput,
  CreateSelectOptionInput,
  UpdateSelectOptionInput,
  CreateRowInput,
  CreateViewInput,
  UpdateViewInput,
  CellValue,
  Row,
  Column,
  SelectOption,
  View,
  Table,
  QueryOptions,
  QueryResult,
  FileReference,
} from '@marlinjai/data-table-core';

/**
 * Server-actions adapter backend. Every action re-resolves the verified
 * auth-brain session and authorizes against the workspace that OWNS the
 * addressed resource (resolved server-side from the opaque id — the browser
 * can neither pick a workspace nor reach another workspace's ids):
 *
 *   - reads require membership of the owning workspace;
 *   - row/cell mutations require `receipts.row.write` (fail-closed OpenFGA);
 *   - schema mutations (tables/columns/options/views) require
 *     `receipts.schema.write`.
 *
 * `listTables`/`createTable` ignore any client-supplied workspace id and use
 * the session's ACTIVE workspace.
 */

function getAdapter() {
  return new PrismaAdapter({ prisma });
}

// --- Table operations ---

export async function createTable(input: CreateTableInput): Promise<Table> {
  const session = await requireReceiptsSession();
  const workspaceId = sessionWorkspaceId(session);
  if (session.memberships.length > 0) {
    // Real session: fail-closed OpenFGA check on the active workspace (the
    // dev bypass has no real workspace to evaluate).
    await auth.requireAction('receipts.schema.write', workspaceId);
  }
  // The workspace is ALWAYS the session's active one, never client-supplied.
  const table = await getAdapter().createTable({ ...input, workspaceId });
  await stampTableOwner(table.id, { db: prisma, tenantId: tenantIdForWorkspace(session, workspaceId) });
  return table;
}

export async function getTable(tableId: string): Promise<Table | null> {
  await requireTableAccess(tableId);
  return getAdapter().getTable(tableId);
}

export async function updateTable(tableId: string, updates: UpdateTableInput): Promise<Table> {
  await requireTableAccess(tableId, 'receipts.schema.write');
  return getAdapter().updateTable(tableId, updates);
}

export async function deleteTable(tableId: string): Promise<void> {
  await requireTableAccess(tableId, 'receipts.schema.write');
  return getAdapter().deleteTable(tableId);
}

export async function listTables(_workspaceId: string): Promise<Table[]> {
  // The client-supplied workspace id is intentionally ignored: tables are
  // listed for the session's verified ACTIVE workspace only.
  const session = await requireReceiptsSession();
  return getAdapter().listTables(sessionWorkspaceId(session));
}

// --- Column operations ---

export async function createColumn(input: CreateColumnInput): Promise<Column> {
  await requireTableAccess(input.tableId, 'receipts.schema.write');
  return getAdapter().createColumn(input);
}

export async function getColumns(tableId: string): Promise<Column[]> {
  await requireTableAccess(tableId);
  return getAdapter().getColumns(tableId);
}

export async function getColumn(columnId: string): Promise<Column | null> {
  await requireColumnAccess(columnId);
  return getAdapter().getColumn(columnId);
}

export async function updateColumn(columnId: string, updates: UpdateColumnInput): Promise<Column> {
  await requireColumnAccess(columnId, 'receipts.schema.write');
  return getAdapter().updateColumn(columnId, updates);
}

export async function deleteColumn(columnId: string): Promise<void> {
  await requireColumnAccess(columnId, 'receipts.schema.write');
  return getAdapter().deleteColumn(columnId);
}

export async function reorderColumns(tableId: string, columnIds: string[]): Promise<void> {
  await requireTableAccess(tableId, 'receipts.schema.write');
  return getAdapter().reorderColumns(tableId, columnIds);
}

// --- Select option operations ---

export async function createSelectOption(input: CreateSelectOptionInput): Promise<SelectOption> {
  await requireColumnAccess(input.columnId, 'receipts.schema.write');
  return getAdapter().createSelectOption(input);
}

export async function getSelectOptions(columnId: string): Promise<SelectOption[]> {
  await requireColumnAccess(columnId);
  return getAdapter().getSelectOptions(columnId);
}

export async function updateSelectOption(optionId: string, updates: UpdateSelectOptionInput): Promise<SelectOption> {
  await requireSelectOptionAccess(optionId, 'receipts.schema.write');
  return getAdapter().updateSelectOption(optionId, updates);
}

export async function deleteSelectOption(optionId: string): Promise<void> {
  await requireSelectOptionAccess(optionId, 'receipts.schema.write');
  return getAdapter().deleteSelectOption(optionId);
}

export async function reorderSelectOptions(columnId: string, optionIds: string[]): Promise<void> {
  await requireColumnAccess(columnId, 'receipts.schema.write');
  return getAdapter().reorderSelectOptions(columnId, optionIds);
}

// --- Row operations ---

export async function createRow(input: CreateRowInput): Promise<Row> {
  await requireTableAccess(input.tableId, 'receipts.row.write');
  return getAdapter().createRow(input);
}

export async function getRow(rowId: string): Promise<Row | null> {
  await requireRowAccess(rowId);
  return getAdapter().getRow(rowId);
}

export async function getRows(tableId: string, query?: QueryOptions): Promise<QueryResult<Row>> {
  await requireTableAccess(tableId);
  return getAdapter().getRows(tableId, query);
}

export async function updateRow(rowId: string, cells: Record<string, CellValue>): Promise<Row> {
  await requireRowAccess(rowId, 'receipts.row.write');
  return getAdapter().updateRow(rowId, cells);
}

/** Why a receipt was kept when a delete was asked for. */
export type KeptReason = 'not_found' | 'file_delete_failed' | 'failed';

export interface DeleteReceiptsOutcome {
  deleted: string[];
  kept: Array<{ rowId: string; reason: KeptReason }>;
}

/**
 * Delete receipts for good, the same way the meals page does: the stored file
 * first, the row with its file references, guests, tax decision and review
 * state only after that succeeded (`deleteReceiptRows`). A file that another
 * receipt still shows is kept. When the file store refuses, the receipt stays
 * complete and is reported, instead of the row vanishing while its file lives
 * on with nothing pointing at it.
 *
 * Every row is authorized through its own table, so a batch across workspaces
 * the session may write to is carried out workspace by workspace.
 */
async function removeReceipts(rowIds: string[]): Promise<DeleteReceiptsOutcome> {
  const ids = [...new Set(rowIds.filter((id) => typeof id === 'string' && id))];
  const outcome: DeleteReceiptsOutcome = { deleted: [], kept: [] };
  const tableByRow = await resolveRowTableIds(ids);
  const workspaceByTable = new Map<string, string>();
  const rowsByWorkspace = new Map<string, string[]>();
  for (const id of ids) {
    const tableId = tableByRow.get(id);
    if (!tableId) {
      outcome.kept.push({ rowId: id, reason: 'not_found' });
      continue;
    }
    let workspaceId = workspaceByTable.get(tableId);
    if (!workspaceId) {
      workspaceId = (await requireTableAccess(tableId, 'receipts.row.write')).workspaceId;
      workspaceByTable.set(tableId, workspaceId);
    }
    rowsByWorkspace.set(workspaceId, [...(rowsByWorkspace.get(workspaceId) ?? []), id]);
  }
  for (const [workspaceId, rows] of rowsByWorkspace) {
    // The company id is only stamped on rows this call would create; a delete creates none.
    const result = await deleteReceiptRows(prisma, { workspaceId, tenantId: null }, rows, { deleteStoredFile });
    outcome.deleted.push(...result.done);
    outcome.kept.push(...result.skipped);
  }
  return outcome;
}

/**
 * The dashboard's delete: what was removed and what was kept, as a value. In a
 * production build a thrown server-action error reaches the browser without
 * its message, so the page could not say which receipts are still there.
 */
export async function deleteReceiptsForGood(rowIds: string[]): Promise<DeleteReceiptsOutcome> {
  if (!Array.isArray(rowIds) || rowIds.length === 0 || rowIds.length > 500) throw new ReceiptsAuthError(404);
  return removeReceipts(rowIds);
}

/**
 * The table adapter's row delete (also used by the chat sidebar and by the
 * upload page when a look-alike receipt is discarded). Same safe delete; this
 * contract returns nothing, so a receipt that had to be kept is an error here
 * and never a silent success.
 */
export async function deleteRow(rowId: string): Promise<void> {
  const outcome = await removeReceipts([rowId]);
  const kept = outcome.kept[0];
  if (!kept) return;
  if (kept.reason === 'not_found') throw new ReceiptsAuthError(404);
  throw new Error(
    kept.reason === 'file_delete_failed'
      ? 'The stored file could not be deleted, so the receipt was kept.'
      : 'The receipt could not be deleted and was kept.',
  );
}

export async function archiveRow(rowId: string): Promise<void> {
  await requireRowAccess(rowId, 'receipts.row.write');
  return getAdapter().archiveRow(rowId);
}

export async function unarchiveRow(rowId: string): Promise<void> {
  await requireRowAccess(rowId, 'receipts.row.write');
  return getAdapter().unarchiveRow(rowId);
}

export async function bulkCreateRows(inputs: CreateRowInput[]): Promise<Row[]> {
  const tableIds = [...new Set(inputs.map((i) => i.tableId))];
  for (const tableId of tableIds) {
    await requireTableAccess(tableId, 'receipts.row.write');
  }
  return getAdapter().bulkCreateRows(inputs);
}

async function requireRowsAccess(rowIds: string[]): Promise<void> {
  // Resolve every row's table once (across BOTH row-storage layouts — see
  // resolveRowTableIds); authorize each distinct table.
  const resolved = await resolveRowTableIds(rowIds);
  if (resolved.size !== new Set(rowIds).size) throw new ReceiptsAuthError(404);
  const tableIds = [...new Set(resolved.values())];
  for (const tableId of tableIds) {
    await requireTableAccess(tableId, 'receipts.row.write');
  }
}

export async function bulkDeleteRows(rowIds: string[]): Promise<void> {
  // All or nothing on access, as before: an id that is not a row of a table
  // this session may write to refuses the whole batch before anything is removed.
  await requireRowsAccess(rowIds);
  const outcome = await removeReceipts(rowIds);
  if (outcome.kept.length > 0) {
    throw new Error(`${outcome.kept.length} of ${rowIds.length} receipts could not be deleted and were kept.`);
  }
}

export async function bulkArchiveRows(rowIds: string[]): Promise<void> {
  await requireRowsAccess(rowIds);
  return getAdapter().bulkArchiveRows(rowIds);
}

// --- Relation operations ---

export async function createRelation(input: { sourceRowId: string; sourceColumnId: string; targetRowId: string }): Promise<void> {
  await requireRowAccess(input.sourceRowId, 'receipts.row.write');
  await requireRowAccess(input.targetRowId, 'receipts.row.write');
  return getAdapter().createRelation(input);
}

export async function deleteRelation(sourceRowId: string, columnId: string, targetRowId: string): Promise<void> {
  await requireRowAccess(sourceRowId, 'receipts.row.write');
  return getAdapter().deleteRelation(sourceRowId, columnId, targetRowId);
}

export async function getRelatedRows(rowId: string, columnId: string): Promise<Row[]> {
  await requireRowAccess(rowId);
  return getAdapter().getRelatedRows(rowId, columnId);
}

export async function getRelationsForRow(rowId: string): Promise<Array<{ columnId: string; targetRowId: string }>> {
  await requireRowAccess(rowId);
  return getAdapter().getRelationsForRow(rowId);
}

// --- File reference operations ---

export async function addFileReference(input: {
  rowId: string;
  columnId: string;
  fileId: string;
  fileUrl: string;
  originalName: string;
  mimeType: string;
  sizeBytes?: number;
  position?: number;
  metadata?: Record<string, unknown>;
}): Promise<FileReference> {
  await requireRowAccess(input.rowId, 'receipts.row.write');
  return getAdapter().addFileReference(input);
}

export async function removeFileReference(fileRefId: string): Promise<void> {
  await requireFileRefAccess(fileRefId, 'receipts.row.write');
  return getAdapter().removeFileReference(fileRefId);
}

export async function getFileReferences(rowId: string, columnId: string): Promise<FileReference[]> {
  await requireRowAccess(rowId);
  return getAdapter().getFileReferences(rowId, columnId);
}

export async function reorderFileReferences(rowId: string, columnId: string, fileRefIds: string[]): Promise<void> {
  await requireRowAccess(rowId, 'receipts.row.write');
  return getAdapter().reorderFileReferences(rowId, columnId, fileRefIds);
}

// --- View operations ---

export async function createView(input: CreateViewInput): Promise<View> {
  await requireTableAccess(input.tableId, 'receipts.schema.write');
  return getAdapter().createView(input);
}

export async function getViews(tableId: string): Promise<View[]> {
  await requireTableAccess(tableId);
  return getAdapter().getViews(tableId);
}

export async function getView(viewId: string): Promise<View | null> {
  await requireViewAccess(viewId);
  return getAdapter().getView(viewId);
}

export async function updateView(viewId: string, updates: UpdateViewInput): Promise<View> {
  await requireViewAccess(viewId, 'receipts.schema.write');
  return getAdapter().updateView(viewId, updates);
}

export async function deleteView(viewId: string): Promise<void> {
  await requireViewAccess(viewId, 'receipts.schema.write');
  return getAdapter().deleteView(viewId);
}

export async function reorderViews(tableId: string, viewIds: string[]): Promise<void> {
  await requireTableAccess(tableId, 'receipts.schema.write');
  return getAdapter().reorderViews(tableId, viewIds);
}
