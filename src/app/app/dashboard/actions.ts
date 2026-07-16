'use server';

import { PrismaAdapter } from '@marlinjai/data-table-adapter-prisma';
import { prisma } from '@/lib/prisma';
import { auth } from '@/lib/auth';
import {
  requireReceiptsSession,
  requireTableAccess,
  requireRowAccess,
  requireColumnAccess,
  requireSelectOptionAccess,
  requireViewAccess,
  requireFileRefAccess,
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
  return getAdapter().createTable({ ...input, workspaceId });
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

export async function deleteRow(rowId: string): Promise<void> {
  await requireRowAccess(rowId, 'receipts.row.write');
  return getAdapter().deleteRow(rowId);
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
  // Resolve every row's table once; authorize each distinct table.
  const rows = await prisma.dtRow.findMany({
    where: { id: { in: rowIds } },
    select: { id: true, tableId: true },
  });
  if (rows.length !== rowIds.length) throw new ReceiptsAuthError(404);
  const tableIds = [...new Set(rows.map((r) => r.tableId))];
  for (const tableId of tableIds) {
    await requireTableAccess(tableId, 'receipts.row.write');
  }
}

export async function bulkDeleteRows(rowIds: string[]): Promise<void> {
  await requireRowsAccess(rowIds);
  return getAdapter().bulkDeleteRows(rowIds);
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
