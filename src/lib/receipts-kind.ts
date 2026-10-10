import type { Column, Row } from '@marlinjai/data-table-core';

/**
 * What a row of the receipts table is. A row is a receipt unless its kind says
 * otherwise: every row stored before groups existed has no kind at all.
 *
 * A **group** is a container a person creates. Receipts are put underneath it
 * (their `parentRowId` names it) and it shows their sum. It is never a receipt:
 * it carries no amount, and no count, sum, export or tax figure may include it.
 *
 * Every place that counts or sums receipts asks THIS module, so there is one
 * answer to "is this a receipt". The test is always the row's kind and never
 * "has rows underneath": an empty group is still not a receipt, and a link that
 * points at a deleted group must never take a receipt out of a total.
 *
 * No server-only import: the dashboard uses the same predicate in the browser.
 */

/** The column that holds a row's kind. Text, so no option can be renamed or deleted. */
export const ROW_KIND_COLUMN = 'Row Kind';
/** The kind of a group. A receipt has no kind. */
export const GROUP_KIND = 'group';

/**
 * The columns a group may carry a value in: its name, and the columns the
 * views sort rows into sections by. Everything else (amounts, dates, files,
 * meal details, the kind itself) is refused on a group.
 */
export const GROUP_WRITABLE_COLUMNS: readonly string[] = ['Name', 'Category', 'Konto', 'Vendor', 'Project', 'Zuordnung'];

type NamedColumn = Pick<Column, 'id' | 'name'>;
type KindRow = Pick<Row, 'cells'>;

/** The id of the kind column, or null on a table that has not received it yet (then no row is a group). */
export function rowKindColumnId(columns: readonly NamedColumn[]): string | null {
  return columns.find((c) => c.name === ROW_KIND_COLUMN)?.id ?? null;
}

/** True when the row is a group, a container that is never a receipt. */
export function isGroupRow(row: KindRow, columns: readonly NamedColumn[]): boolean {
  const columnId = rowKindColumnId(columns);
  return columnId !== null && row.cells[columnId] === GROUP_KIND;
}

/** The rows that are receipts: everything except groups, in the given order. */
export function receiptsOnly<T extends KindRow>(rows: readonly T[], columns: readonly NamedColumn[]): T[] {
  const columnId = rowKindColumnId(columns);
  if (columnId === null) return [...rows];
  return rows.filter((row) => row.cells[columnId] !== GROUP_KIND);
}

/** The columns a person sees and edits: everything except the kind column. */
export function visibleColumns<T extends NamedColumn>(columns: readonly T[]): T[] {
  return columns.filter((c) => c.name !== ROW_KIND_COLUMN);
}
