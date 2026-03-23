'use server';

import { PrismaAdapter } from '@marlinjai/data-table-adapter-prisma';
import { prisma } from '@/lib/prisma';
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

function getAdapter() {
  return new PrismaAdapter({ prisma });
}

// --- Table operations ---

export async function createTable(input: CreateTableInput): Promise<Table> {
  return getAdapter().createTable(input);
}

export async function getTable(tableId: string): Promise<Table | null> {
  return getAdapter().getTable(tableId);
}

export async function updateTable(tableId: string, updates: UpdateTableInput): Promise<Table> {
  return getAdapter().updateTable(tableId, updates);
}

export async function deleteTable(tableId: string): Promise<void> {
  return getAdapter().deleteTable(tableId);
}

export async function listTables(workspaceId: string): Promise<Table[]> {
  return getAdapter().listTables(workspaceId);
}

// --- Column operations ---

export async function createColumn(input: CreateColumnInput): Promise<Column> {
  return getAdapter().createColumn(input);
}

export async function getColumns(tableId: string): Promise<Column[]> {
  return getAdapter().getColumns(tableId);
}

export async function getColumn(columnId: string): Promise<Column | null> {
  return getAdapter().getColumn(columnId);
}

export async function updateColumn(columnId: string, updates: UpdateColumnInput): Promise<Column> {
  return getAdapter().updateColumn(columnId, updates);
}

export async function deleteColumn(columnId: string): Promise<void> {
  return getAdapter().deleteColumn(columnId);
}

export async function reorderColumns(tableId: string, columnIds: string[]): Promise<void> {
  return getAdapter().reorderColumns(tableId, columnIds);
}

// --- Select option operations ---

export async function createSelectOption(input: CreateSelectOptionInput): Promise<SelectOption> {
  return getAdapter().createSelectOption(input);
}

export async function getSelectOptions(columnId: string): Promise<SelectOption[]> {
  return getAdapter().getSelectOptions(columnId);
}

export async function updateSelectOption(optionId: string, updates: UpdateSelectOptionInput): Promise<SelectOption> {
  return getAdapter().updateSelectOption(optionId, updates);
}

export async function deleteSelectOption(optionId: string): Promise<void> {
  return getAdapter().deleteSelectOption(optionId);
}

export async function reorderSelectOptions(columnId: string, optionIds: string[]): Promise<void> {
  return getAdapter().reorderSelectOptions(columnId, optionIds);
}

// --- Row operations ---

export async function createRow(input: CreateRowInput): Promise<Row> {
  return getAdapter().createRow(input);
}

export async function getRow(rowId: string): Promise<Row | null> {
  return getAdapter().getRow(rowId);
}

export async function getRows(tableId: string, query?: QueryOptions): Promise<QueryResult<Row>> {
  const result = await getAdapter().getRows(tableId, query);
  console.log('[getRows]', tableId, 'total:', result.total, 'items:', result.items.length, 'query:', JSON.stringify(query));
  if (result.items.length > 0) {
    console.log('[getRows] first row cells:', Object.keys(result.items[0].cells), 'sample:', Object.entries(result.items[0].cells).slice(0, 3));
  }
  return result;
}

export async function updateRow(rowId: string, cells: Record<string, CellValue>): Promise<Row> {
  return getAdapter().updateRow(rowId, cells);
}

export async function deleteRow(rowId: string): Promise<void> {
  return getAdapter().deleteRow(rowId);
}

export async function archiveRow(rowId: string): Promise<void> {
  return getAdapter().archiveRow(rowId);
}

export async function unarchiveRow(rowId: string): Promise<void> {
  return getAdapter().unarchiveRow(rowId);
}

export async function bulkCreateRows(inputs: CreateRowInput[]): Promise<Row[]> {
  return getAdapter().bulkCreateRows(inputs);
}

export async function bulkDeleteRows(rowIds: string[]): Promise<void> {
  return getAdapter().bulkDeleteRows(rowIds);
}

export async function bulkArchiveRows(rowIds: string[]): Promise<void> {
  return getAdapter().bulkArchiveRows(rowIds);
}

// --- Relation operations ---

export async function createRelation(input: { sourceRowId: string; sourceColumnId: string; targetRowId: string }): Promise<void> {
  return getAdapter().createRelation(input);
}

export async function deleteRelation(sourceRowId: string, columnId: string, targetRowId: string): Promise<void> {
  return getAdapter().deleteRelation(sourceRowId, columnId, targetRowId);
}

export async function getRelatedRows(rowId: string, columnId: string): Promise<Row[]> {
  return getAdapter().getRelatedRows(rowId, columnId);
}

export async function getRelationsForRow(rowId: string): Promise<Array<{ columnId: string; targetRowId: string }>> {
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
  return getAdapter().addFileReference(input);
}

export async function removeFileReference(fileRefId: string): Promise<void> {
  return getAdapter().removeFileReference(fileRefId);
}

export async function getFileReferences(rowId: string, columnId: string): Promise<FileReference[]> {
  return getAdapter().getFileReferences(rowId, columnId);
}

export async function reorderFileReferences(rowId: string, columnId: string, fileRefIds: string[]): Promise<void> {
  return getAdapter().reorderFileReferences(rowId, columnId, fileRefIds);
}

// --- View operations ---

export async function createView(input: CreateViewInput): Promise<View> {
  return getAdapter().createView(input);
}

export async function getViews(tableId: string): Promise<View[]> {
  return getAdapter().getViews(tableId);
}

export async function getView(viewId: string): Promise<View | null> {
  return getAdapter().getView(viewId);
}

export async function updateView(viewId: string, updates: UpdateViewInput): Promise<View> {
  return getAdapter().updateView(viewId, updates);
}

export async function deleteView(viewId: string): Promise<void> {
  return getAdapter().deleteView(viewId);
}

export async function reorderViews(tableId: string, viewIds: string[]): Promise<void> {
  return getAdapter().reorderViews(tableId, viewIds);
}
