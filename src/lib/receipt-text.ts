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

/** The ids of the text columns. Normally one; a leftover duplicate column of the same name must not carry the text either. */
export function textColumnIds(columns: readonly NamedColumn[]): string[] {
  return columns.filter((c) => c.name === TEXT_COLUMN).map((c) => c.id);
}

/** The row without its recognized text: the cell is empty, nothing else changes. */
export function withoutText<T extends Pick<Row, 'cells'>>(row: T, textIds: readonly string[]): T {
  const present = textIds.filter((id) => typeof row.cells[id] === 'string' && row.cells[id] !== '');
  if (present.length === 0) return row;
  const cells = { ...row.cells };
  for (const id of present) cells[id] = '';
  return { ...row, cells };
}

export function rowsWithoutText<T extends Pick<Row, 'cells'>>(rows: readonly T[], textIds: readonly string[]): T[] {
  return rows.map((row) => withoutText(row, textIds));
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
