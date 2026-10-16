'use server';

import { touchesTaxRates, withTaxRates } from '@/lib/tax-rates';
import { touchesNameParts, withFollowingName } from '@/lib/receipt-name-cells';
import { PrismaAdapter, ensureRealTable } from '@marlinjai/data-table-adapter-prisma';
import { safeColumnName, safeTableName, serializeCell } from '@marlinjai/data-table-adapter-shared';
import { prisma } from '@/lib/prisma';
import { auth } from '@/lib/auth';
import { deleteReceiptRows } from '@/lib/meals/service';
import { deleteStoredFile } from '@/lib/stored-files';
import { tenantIdForWorkspace } from '@/lib/auth-workspace';
import { stampTableOwner } from '@/lib/receipts-table';
import { cleanScopeYears, yearOfDate, type YearScope } from '@/lib/receipt-years';
import { groupsHoldingReceipts, yearCounts, type YearCounts } from '@/lib/receipt-year-counts';

/** The most receipts one year of the list returns: far above what a year holds. */
const SCOPED_LIST_LIMIT = 5000;
import { MIN_TEXT_SEARCH_LENGTH, TEXT_SEARCH_LIMIT, likePattern, rowsWithoutText, textColumnIds, withoutText } from '@/lib/receipt-text';
import { GROUP_KIND, GROUP_WRITABLE_COLUMNS, ROW_KIND_COLUMN, rowKindColumnId } from '@/lib/receipts-kind';
import { EVERY_ROW_LIMIT, applyDayFilters, boundsYears, readEveryRow, splitDayFilters, yearsWithin } from './day-filters';
import { BULK_SET_BUDGET_MS, BULK_SET_PART, storedAs, type BulkSetFailure, type BulkSetOutcome } from './bulk-set';
import { GroupError, assertCellsWritable } from '@/lib/groups/rules';
import { rowKind } from '@/lib/groups/service';
import { readRowLinks } from '@/lib/groups/links';
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

/**
 * The kind column says which rows are groups and therefore no receipts. Renamed,
 * retyped or deleted, every group would turn into a receipt without an amount,
 * so it cannot be changed from the table.
 */
async function requireNotKindColumn(columnId: string): Promise<void> {
  const column = await getAdapter().getColumn(columnId);
  if (column?.name === ROW_KIND_COLUMN) throw new GroupError('not_writable');
}

export async function updateColumn(columnId: string, updates: UpdateColumnInput): Promise<Column> {
  await requireColumnAccess(columnId, 'receipts.schema.write');
  await requireNotKindColumn(columnId);
  return getAdapter().updateColumn(columnId, updates);
}

export async function deleteColumn(columnId: string): Promise<void> {
  await requireColumnAccess(columnId, 'receipts.schema.write');
  await requireNotKindColumn(columnId);
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

/**
 * A row created from the table is a receipt. It cannot name its own kind (a
 * group is only made by `createGroup`), and when it is created underneath
 * another row, that row must be a group of the same table.
 */
async function requireCreatableRow(input: CreateRowInput, columns: Column[]): Promise<void> {
  assertCellsWritable(columns, null, input.cells ?? {});
  if (input.parentRowId === undefined || input.parentRowId === null) return;
  const kindColumnId = rowKindColumnId(columns);
  const parent = kindColumnId ? (await readRowLinks(prisma, input.tableId, kindColumnId, [input.parentRowId])).get(input.parentRowId) : undefined;
  if (!parent || parent.kind !== GROUP_KIND || parent.archived) throw new GroupError('group_not_found');
}

export async function createRow(input: CreateRowInput): Promise<Row> {
  await requireTableAccess(input.tableId, 'receipts.row.write');
  const adapter = getAdapter();
  const columns = await adapter.getColumns(input.tableId);
  await requireCreatableRow(input, columns);
  if (!input.cells) return adapter.createRow(input);
  return adapter.createRow({ ...input, cells: withTaxRates(columns, input.cells) as Record<string, CellValue> });
}

/** The recognized-text column ids of a table, for the actions that return rows to the list. */
async function textColumnsOf(adapter: PrismaAdapter, tableId: string): Promise<string[]> {
  return textColumnIds(await adapter.getColumns(tableId));
}

export async function getRow(rowId: string): Promise<Row | null> {
  await requireRowAccess(rowId);
  const adapter = getAdapter();
  const row = await adapter.getRow(rowId);
  return row ? withoutText(row, await textColumnsOf(adapter, row.tableId)) : null;
}

/**
 * The rows of the list. The recognized text of a receipt is left out (an empty
 * cell): it is several kilobytes per row and only the detail panel needs it,
 * through `getReceiptText`. On 2026-10-12 the full list was 3 MB for 780 rows.
 */
export async function getRows(tableId: string, query?: QueryOptions & YearScope): Promise<QueryResult<Row>> {
  await requireTableAccess(tableId);
  const adapter = getAdapter();
  const columns = await adapter.getColumns(tableId);
  const textIds = textColumnIds(columns);
  const { years: asked, ...asks } = query ?? {};
  // The filter bar's date comparisons are answered here, on the day each date names (see `day-filters.ts`):
  // the adapter's own comparisons fail on this database. Every other filter goes to the adapter as before.
  const { dayFilters, adapterFilters, dayPrefixes } = splitDayFilters(asks.filters, columns);
  const rest: QueryOptions = { ...asks, filters: adapterFilters };
  let years = cleanScopeYears(asked);
  const dateId = columns.find((c) => c.name === 'Date')?.id;
  // A sorted list is not narrowed: the years are queried one by one, so a sort across them (and the place of
  // the groups in it) could not be right. The browser filters the years then.
  const sorted = (rest.sorts?.length ?? 0) > 0;
  if ((!years || !dateId) && !sorted && dayFilters.length === 0) {
    const result = await adapter.getRows(tableId, rest);
    return { ...result, items: rowsWithoutText(result.items, textIds) };
  }
  if (sorted && dayFilters.length === 0) {
    // A sorted list comes in one answer. The adapter orders by the sort column alone, so rows that share a
    // value (a category, a status) can change places between two pages and a paged list would show some twice
    // and others never. A further page is empty.
    if ((rest.offset ?? 0) > 0) return { items: [], total: rest.offset ?? 0, hasMore: false } as QueryResult<Row>;
    const items = await readEveryRow((offset, limit) => adapter.getRows(tableId, { ...rest, offset, limit }), EVERY_ROW_LIMIT);
    return { items: rowsWithoutText(items, textIds), total: items.length, hasMore: false } as QueryResult<Row>;
  }
  // "Is", "after" and "before" on the invoice date bound the years a receipt can lie in: the list then reads
  // only those years, as the year chips do, and compares the days of what they hold. (Like the year chips,
  // that path never shows archived rows; the dashboard does not ask for them.)
  const bounded =
    dateId && !sorted && boundsYears(dayFilters, dateId)
      ? yearsWithin(dayFilters, dateId, years ?? (await yearCounts(prisma, tableId, columns)).years.map((y) => y.year))
      : null;
  if (bounded && bounded.length === 0) return { items: [], total: 0, hasMore: false } as QueryResult<Row>;
  if (bounded) years = bounded;
  if (!years || !dateId || sorted) {
    // A list with a date comparison that bounds no years comes in one answer: which rows pass is only known
    // once they are read, so a page of the adapter could not be counted. A further page is empty. That is a
    // sorted list, or a comparison on a date column other than the invoice date (when the meal details were
    // entered). It reads every row the other filters leave, groups included (so no day match is added: it
    // would drop them), and the recognized text until it is left out below. On the invoice date without a
    // sort, the filter bar's operators always take the per-year path below.
    if ((rest.offset ?? 0) > 0) return { items: [], total: rest.offset ?? 0, hasMore: false } as QueryResult<Row>;
    const every = await readEveryRow((offset, limit) => adapter.getRows(tableId, { ...rest, offset, limit }), EVERY_ROW_LIMIT);
    const items = applyDayFilters(every, dayFilters, columns);
    return { items: rowsWithoutText(items, textIds), total: items.length, hasMore: false } as QueryResult<Row>;
  }

  // A list narrowed to years: one query per year, on the start of the stored invoice date (a plain text
  // match: the adapter's own date comparisons do not take a text parameter on this database). The years
  // of one choice are few and a year has a few hundred receipts, so they come in one answer, without the
  // recognized text; a further page is empty. The groups that hold some of them come along (a group has
  // no date of its own).
  if ((rest.offset ?? 0) > 0) return { items: [], total: rest.offset ?? 0, hasMore: false } as QueryResult<Row>;
  const perYear = await Promise.all(
    years.map((year) =>
      adapter.getRows(tableId, {
        ...rest,
        // Only receipts are read here (the groups come below), so "is" a day may narrow them in the database.
        filters: [...(rest.filters ?? []), ...dayPrefixes, { columnId: dateId, operator: 'startsWith', value: `${year}-` }],
        limit: SCOPED_LIST_LIMIT,
        offset: 0,
      }),
    ),
  );
  let items = perYear.flatMap((r) => r.items);
  const kindId = rowKindColumnId(columns);
  if (kindId) {
    const parents = await groupsHoldingReceipts(prisma, tableId, dateId, years);
    if (parents.size > 0) {
      const groups = await adapter.getRows(tableId, { filters: [{ columnId: kindId, operator: 'equals', value: GROUP_KIND }], limit: SCOPED_LIST_LIMIT });
      const have = new Set(items.map((r) => r.id));
      items = [...items, ...groups.items.filter((g) => parents.has(g.id) && !have.has(g.id))];
    }
  }
  items = applyDayFilters(items, dayFilters, columns);
  return { items: rowsWithoutText(items, textIds), total: items.length, hasMore: false } as QueryResult<Row>;
}

/** The year of a receipt's invoice date, or null: where to look for a receipt a link names. */
export async function getReceiptYear(rowId: string): Promise<number | null> {
  await requireRowAccess(rowId);
  const adapter = getAdapter();
  const row = await adapter.getRow(rowId);
  if (!row) return null;
  const dateId = (await adapter.getColumns(row.tableId)).find((c) => c.name === 'Date')?.id;
  return dateId ? yearOfDate(row.cells[dateId]) : null;
}

/** How many receipts each year has, for the year chips: no row is loaded. */
export async function getYearCounts(tableId: string): Promise<YearCounts> {
  await requireTableAccess(tableId);
  const adapter = getAdapter();
  return yearCounts(prisma, tableId, await adapter.getColumns(tableId));
}

/** The recognized text of one receipt, for the detail panel. Empty when there is none. */
export async function getReceiptText(rowId: string): Promise<string> {
  await requireRowAccess(rowId);
  const adapter = getAdapter();
  const row = await adapter.getRow(rowId);
  if (!row) return '';
  const textId = textColumnIds(await adapter.getColumns(row.tableId))[0];
  const value = textId ? row.cells[textId] : null;
  return typeof value === 'string' ? value : '';
}

export interface TextSearchResult {
  ids: string[];
  /** True when more receipts match than are returned: the term should be made more specific. */
  truncated: boolean;
}

/**
 * Receipts whose recognized text contains the term, as ids (at most
 * TEXT_SEARCH_LIMIT, newest first). The list does not carry the text, so a
 * search in it runs here. Says so when more receipts match than are returned.
 */
export async function searchReceiptText(tableId: string, term: string): Promise<TextSearchResult> {
  await requireTableAccess(tableId);
  const wanted = typeof term === 'string' ? term.trim() : '';
  if (wanted.length < MIN_TEXT_SEARCH_LENGTH || wanted.length > 120) return { ids: [], truncated: false };
  const textId = textColumnIds(await getAdapter().getColumns(tableId))[0];
  if (!textId) return { ids: [], truncated: false };
  // A table that is not in its own real table yet is brought there, as the list does.
  await ensureRealTable(prisma, tableId);
  // Rows live in a real table per data table, one text column per column id (the adapter's own naming,
  // which also validates the identifiers). Only the pattern is a parameter.
  const rows = await prisma.$queryRawUnsafe<Array<{ id: string }>>(
    `SELECT id FROM ${safeTableName(tableId)}
     WHERE _archived = 0 AND ${safeColumnName(textId)} ILIKE $1
     ORDER BY _created_at DESC
     LIMIT ${Math.trunc(TEXT_SEARCH_LIMIT) + 1}`,
    likePattern(wanted),
  );
  return { ids: rows.slice(0, TEXT_SEARCH_LIMIT).map((r) => r.id), truncated: rows.length > TEXT_SEARCH_LIMIT };
}

export async function updateRow(rowId: string, cells: Record<string, CellValue>): Promise<Row> {
  await requireRowAccess(rowId, 'receipts.row.write');
  const { tableId } = await rowTable(rowId);
  const adapter = getAdapter();
  // A rate typed into the grid shows up in the rates text too (see
  // `lib/tax-rates.ts`). Every edit reads the columns to know whether it is
  // one; only an edit of the rate or the tax lines also reads the stored row.
  return writeCells(adapter, tableId, await adapter.getColumns(tableId), rowId, cells);
}

/**
 * True when the guarded write below stores these cells exactly as given (after its group check): no name
 * follows them and no tax rates text. "Set field" writes such cells for many rows in one statement, so **a
 * rule added to `writeCells` that changes cells on their way, or reacts to them, must make this false for
 * them, or run for the rows "Set field" wrote in one go.**
 */
function writesCellsAsGiven(columns: readonly Column[], kind: string | null, cells: Record<string, CellValue>): boolean {
  const followsName = kind !== GROUP_KIND && touchesNameParts(columns, cells);
  return !followsName && !touchesTaxRates(columns, cells);
}

/**
 * The guarded write of a cell edit, for one row the caller has authorized: the
 * rules on groups, the name that follows its cells, the tax rates text. The row
 * comes back without its recognized text, as every row of the list.
 */
async function writeCells(adapter: PrismaAdapter, tableId: string, columns: Column[], rowId: string, cells: Record<string, CellValue>): Promise<Row> {
  // A group takes its name and the columns the views sort by; no row takes a kind (see `assertCellsWritable`).
  const kind = await rowKind(prisma, tableId, columns, rowId);
  assertCellsWritable(columns, kind, cells);
  // A corrected vendor, item, total, currency or date is said by the name too
  // (see `lib/receipt-name-cells.ts`); a group's name is its own.
  const followsName = kind !== GROUP_KIND && touchesNameParts(columns, cells);
  const ratesChange = touchesTaxRates(columns, cells);
  const textId = textColumnIds(columns);
  // The table puts the returned row in its list: without the recognized text, like every row of the list.
  if (writesCellsAsGiven(columns, kind, cells)) return withoutText(await adapter.updateRow(rowId, cells), textId);
  const stored = await adapter.getRow(rowId);
  const named = followsName ? await withFollowingName(adapter, columns, cells, stored?.cells) : cells;
  return withoutText(
    await adapter.updateRow(rowId, (ratesChange ? withTaxRates(columns, named, stored?.cells) : named) as Record<string, CellValue>),
    textId,
  );
}

/** The table a row belongs to; the row was authorized just before. */
async function rowTable(rowId: string): Promise<{ tableId: string }> {
  const tableId = (await resolveRowTableIds([rowId])).get(rowId);
  if (!tableId) throw new Error('Row not found');
  return { tableId };
}

/**
 * "Set field" on a part of a selection (see `bulk-set.ts`): one select column,
 * one option or empty, under the same rules a cell edit takes (see
 * `writesCellsAsGiven`), then read back. A row counts as done only when its
 * stored value is the one asked for; every other row says why it was not set.
 * One row failing does not stop the others. Access is checked once, on the
 * column's table; a row of another table, or an archived one (the list does not
 * show it), is "not found", never written.
 */
export async function setFieldOnRows(rowIds: string[], columnId: string, value: string | null): Promise<BulkSetOutcome> {
  if (
    !Array.isArray(rowIds) ||
    rowIds.length === 0 ||
    rowIds.length > BULK_SET_PART ||
    rowIds.some((id) => typeof id !== 'string' || !id) ||
    typeof columnId !== 'string' ||
    (value !== null && typeof value !== 'string')
  ) {
    throw new Error('Set field: invalid input.');
  }
  // The time budget below counts from here, so one call stays bounded as a whole.
  const startedAt = performance.now();
  await requireColumnAccess(columnId, 'receipts.row.write');
  const ids = [...new Set(rowIds)];
  const everyRow = (reason: BulkSetFailure): BulkSetOutcome => ({ done: [], failed: ids.map((rowId) => ({ rowId, reason })), left: [] });
  const adapter = getAdapter();
  const column = await adapter.getColumn(columnId);
  // The column was deleted between the access check and here: nothing can be set, and a retry would not help.
  if (!column) return everyRow('not_writable');
  const { tableId } = column;
  // The bar sets select columns only; the value is an option of that column, or empty.
  if (column.type !== 'select') return everyRow('not_writable');
  if (value !== null && !(await adapter.getSelectOptions(columnId)).some((o) => o.id === value)) return everyRow('invalid_value');

  const columns = await adapter.getColumns(tableId);
  const cells = { [columnId]: value };
  const tableByRow = await resolveRowTableIds(ids);
  const failed: BulkSetOutcome['failed'] = [];
  const done: string[] = [];
  const mine = ids.filter((rowId) => {
    if (tableByRow.get(rowId) === tableId) return true;
    failed.push({ rowId, reason: 'not_found' });
    return false;
  });

  // What every row holds now, in one query. A row that already holds the value is done without a write: a
  // retry of a part that got no answer sets only what is still missing, and never writes a row twice.
  await ensureRealTable(prisma, tableId);
  const before = await storedCells(tableId, columnId, rowKindColumnId(columns), mine);
  const toWrite: Array<{ rowId: string; kind: string | null }> = [];
  for (const rowId of mine) {
    const row = before.get(rowId);
    if (!row) {
      failed.push({ rowId, reason: 'not_found' });
      continue;
    }
    // The group check a cell edit makes, before anything else: a group never "holds" a value it may not take.
    try {
      assertCellsWritable(columns, row.kind, cells);
    } catch {
      failed.push({ rowId, reason: 'not_writable' });
      continue;
    }
    if (storedAs(row.value, value)) done.push(rowId);
    else toWrite.push({ rowId, kind: row.kind });
  }

  const written: string[] = [];
  const uncertain: string[] = [];
  // Rows written through the table adapter, which does not look at the archive mark: one archived between
  // the first read and its write is not missing but in an unclear state.
  const perRow = new Set<string>();
  const plain = toWrite.filter(({ kind }) => writesCellsAsGiven(columns, kind, cells));
  if (plain.length > 0) {
    // A cell no rule changes on its way (a category, a status, the assignment) is written for the whole part
    // in one statement. Through the table adapter each row costs two look-ups across every table of the
    // database; on 2026-10-16 a part of 25 got no answer on production.
    const allowed = plain.map(({ rowId }) => rowId);
    try {
      await writeCellOnRows(tableId, column, rowKindColumnId(columns), value, allowed);
      written.push(...allowed);
    } catch {
      // The statement may or may not have run: the read-back below decides.
      uncertain.push(...allowed);
    }
  }
  // Every other cell takes the guarded write of a cell edit, row after row (the name that follows its cells,
  // the tax rates text). That costs the table adapter's look-ups per row, so the part
  // stops after a time budget and hands back the rows it has not touched; the bar sends them again. At least
  // one row is written per call, so a slow server still moves on.
  const left: string[] = [];
  for (const { rowId } of toWrite.filter(({ kind }) => !writesCellsAsGiven(columns, kind, cells))) {
    if (written.length + uncertain.length > 0 && performance.now() - startedAt > BULK_SET_BUDGET_MS) {
      left.push(rowId);
      continue;
    }
    try {
      perRow.add(rowId);
      await writeCells(adapter, tableId, columns, rowId, cells);
      written.push(rowId);
    } catch (error) {
      // A row deleted meanwhile is not found; a cell the row may not take (the kind, an amount on a group) is not writable.
      // (The adapter says a row deleted between its two reads with a plain "Row not found".)
      const code = error instanceof GroupError ? error.code : null;
      const gone = code === 'row_not_found' || (error instanceof Error && error.message === 'Row not found');
      if (gone || code === 'not_writable') failed.push({ rowId, reason: gone ? 'not_found' : 'not_writable' });
      // Any other error may have come after the value was stored (the adapter reads the row again after its
      // write): the read-back below decides.
      else uncertain.push(rowId);
    }
  }

  // Read back what is stored now, all rows at once: a write that answered is not yet a value that landed.
  if (written.length + uncertain.length > 0) {
    const after = await storedCells(tableId, columnId, null, [...written, ...uncertain]);
    for (const rowId of written) {
      const row = after.get(rowId);
      if (row && storedAs(row.value, value)) done.push(rowId);
      else failed.push({ rowId, reason: row ? 'not_stored' : perRow.has(rowId) ? 'failed' : 'not_found' });
    }
    for (const rowId of uncertain) {
      const row = after.get(rowId);
      if (row && storedAs(row.value, value)) done.push(rowId);
      else failed.push({ rowId, reason: row ? 'failed' : 'not_found' });
    }
  }
  return { done, failed, left };
}

/** The stored value of one column, and the kind, of the given rows of a real table that are not archived. */
async function storedCells(
  tableId: string,
  columnId: string,
  kindColumnId: string | null,
  rowIds: readonly string[],
): Promise<Map<string, { value: string | null; kind: string | null }>> {
  if (rowIds.length === 0) return new Map();
  const kind = kindColumnId ? safeColumnName(kindColumnId) : 'NULL';
  const rows = await prisma.$queryRawUnsafe<Array<{ id: string; value: string | null; kind: string | null }>>(
    `SELECT id, ${safeColumnName(columnId)} AS value, ${kind} AS kind FROM ${safeTableName(tableId)} WHERE _archived = 0 AND id = ANY($1::text[])`,
    [...rowIds],
  );
  return new Map(rows.map((r) => [r.id, { value: r.value, kind: r.kind }]));
}

/**
 * One select cell on many rows of a real table, in one statement, stored as the table adapter stores it. A
 * column a group may not take is never written onto a group, even one that became a group since it was read
 * (the read-back then says the row was not set).
 */
async function writeCellOnRows(tableId: string, column: Column, kindColumnId: string | null, value: string | null, rowIds: readonly string[]): Promise<void> {
  if (rowIds.length === 0) return;
  const notGroup = kindColumnId && !GROUP_WRITABLE_COLUMNS.includes(column.name) ? `AND ${safeColumnName(kindColumnId)} IS DISTINCT FROM '${GROUP_KIND}'` : '';
  await prisma.$executeRawUnsafe(
    `UPDATE ${safeTableName(tableId)} SET ${safeColumnName(column.id)} = $1, _updated_at = $2 WHERE _archived = 0 AND id = ANY($3::text[]) ${notGroup}`,
    serializeCell(value, column.type),
    new Date().toISOString(),
    [...rowIds],
  );
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
  const adapter = getAdapter();
  // The columns of each table once, not once per row.
  const columnsByTable = new Map(await Promise.all(tableIds.map(async (tableId) => [tableId, await adapter.getColumns(tableId)] as const)));
  for (const input of inputs) await requireCreatableRow(input, columnsByTable.get(input.tableId) ?? []);
  return adapter.bulkCreateRows(
    inputs.map((i) => (i.cells ? { ...i, cells: withTaxRates(columnsByTable.get(i.tableId) ?? [], i.cells) as Record<string, CellValue> } : i)),
  );
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
  // A group holds receipts and has no document of its own: a file on it would be a receipt nothing counts.
  const { tableId } = await rowTable(input.rowId);
  if ((await rowKind(prisma, tableId, await getAdapter().getColumns(tableId), input.rowId)) === GROUP_KIND) throw new GroupError('not_writable');
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
