import type { Column, Row } from '@marlinjai/data-table-core';

/**
 * The recognized text of a receipt is the largest cell of a row by far (several
 * kilobytes of a page's text) and is needed by one place only: the detail
 * panel. The table list therefore leaves it out and the panel asks for it when
 * a receipt is opened. A text search runs on the server (see
 * `searchReceiptText`), so nothing a person could search for goes missing.
 *
 * No server-only import: the dashboard uses the same predicate in the browser.
 */

/** The column that holds the recognized text. */
export const TEXT_COLUMN = 'OCR Text';

type NamedColumn = Pick<Column, 'id' | 'name'>;

/** The id of the text column, or null on a table that has none. */
export function textColumnId(columns: readonly NamedColumn[]): string | null {
  return columns.find((c) => c.name === TEXT_COLUMN)?.id ?? null;
}

/** The row without its recognized text: the cell is empty, nothing else changes. */
export function withoutText<T extends Pick<Row, 'cells'>>(row: T, textId: string | null): T {
  if (!textId || typeof row.cells[textId] !== 'string' || row.cells[textId] === '') return row;
  return { ...row, cells: { ...row.cells, [textId]: '' } };
}

export function rowsWithoutText<T extends Pick<Row, 'cells'>>(rows: readonly T[], textId: string | null): T[] {
  return rows.map((row) => withoutText(row, textId));
}

/** The columns a table list shows: everything the person can read or edit in a grid, never the recognized text. */
export function listColumns<T extends NamedColumn>(columns: readonly T[]): T[] {
  return columns.filter((c) => c.name !== TEXT_COLUMN);
}

/** The shortest term the server is asked to look for: shorter ones match nearly every receipt. */
export const MIN_TEXT_SEARCH_LENGTH = 3;
/** How many receipts a text search returns at most. */
export const TEXT_SEARCH_LIMIT = 300;

/** A search term as a pattern for the database's ILIKE: the characters it treats specially are taken literally. */
export function likePattern(term: string): string {
  return `%${term.trim().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}
