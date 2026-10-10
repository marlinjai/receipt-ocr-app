import type { CellValue, Column, Row } from '@marlinjai/data-table-core';
import { GROUP_WRITABLE_COLUMNS, isGroupRow } from '@/lib/receipts-kind';

/**
 * What the dashboard shows of a group, as pure functions over the rows it has
 * loaded. Nothing here is stored: the sum of a group is worked out from its
 * receipts every time the table is drawn, so no amount ever sits on a group
 * where a total could pick it up a second time.
 */

type NamedColumn = Pick<Column, 'id' | 'name'>;

/** The columns in which a group shows the sum of its receipts. */
export const GROUP_SUM_COLUMNS: readonly string[] = ['Gross', 'EUR Equivalent', 'Attributed EUR'];

const cents = (value: unknown): number => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
};

/** The sum of one column over the given receipts, in the unit of the column, exact to the cent. */
export function sumOf(rows: readonly Pick<Row, 'cells'>[], columnId: string): number {
  return rows.reduce((total, row) => total + cents(row.cells[columnId]), 0) / 100;
}

/**
 * What a row shows in a column in place of its own cell (the table's
 * `getSubItemSummary`). Undefined means "the row's own cell".
 *
 * - A receipt always shows its own cells.
 * - A group shows the sum of its receipts in the amount columns. The gross sum
 *   only when all its receipts share one currency: amounts in different
 *   currencies do not add up, and the amounts in euros next to it do.
 * - A group shows its own cell where it may carry a value (its name, and the
 *   columns the views sort by), and nothing, read-only, everywhere else.
 */
export function groupCellValue(row: Row, children: readonly Row[], column: NamedColumn, columns: readonly NamedColumn[]): CellValue | undefined {
  if (!isGroupRow(row, columns)) return undefined;
  if (GROUP_WRITABLE_COLUMNS.includes(column.name)) return undefined;
  if (!GROUP_SUM_COLUMNS.includes(column.name)) return null;
  if (column.name === 'Gross') {
    const currencyId = columns.find((c) => c.name === 'Currency')?.id;
    const currencies = new Set(children.map((c) => (currencyId ? (c.cells[currencyId] ?? null) : null)));
    if (currencies.size > 1) return null;
  }
  return sumOf(children, column.id);
}

export interface GroupOption {
  id: string;
  name: string;
}

/** The groups among the rows, by name, for the "move into" menu. */
export function groupsOf(rows: readonly Row[], columns: readonly NamedColumn[]): GroupOption[] {
  const nameId = columns.find((c) => c.name === 'Name')?.id;
  return rows
    .filter((row) => !row.archived && isGroupRow(row, columns))
    .map((row) => {
      const name = nameId ? row.cells[nameId] : null;
      return { id: row.id, name: typeof name === 'string' && name.trim() ? name.trim() : 'Gruppe ohne Namen' };
    })
    .sort((a, b) => a.name.localeCompare(b.name, 'de'));
}

export interface SelectionKinds {
  /** The selected rows that are receipts. Only these go into a group or into a bulk edit. */
  receiptIds: string[];
  /** The selected rows that are groups. */
  groupIds: string[];
  /** The selected receipts that lie in a group that is among the rows. */
  inGroupIds: string[];
}

/** The selection, sorted by what each row is. Ids that are not among the rows are dropped. */
export function selectionKinds(selected: Iterable<string>, rows: readonly Row[], columns: readonly NamedColumn[]): SelectionKinds {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const out: SelectionKinds = { receiptIds: [], groupIds: [], inGroupIds: [] };
  for (const id of selected) {
    const row = byId.get(id);
    if (!row) continue;
    if (isGroupRow(row, columns)) {
      out.groupIds.push(id);
      continue;
    }
    out.receiptIds.push(id);
    const parent = row.parentRowId ? byId.get(row.parentRowId) : undefined;
    if (parent && isGroupRow(parent, columns)) out.inGroupIds.push(id);
  }
  return out;
}

/** The receipts that lie in the given group, in the order of the rows. */
export function receiptsInGroup(groupId: string, rows: readonly Row[], columns: readonly NamedColumn[]): Row[] {
  return rows.filter((row) => row.parentRowId === groupId && !isGroupRow(row, columns));
}

/**
 * The rows a search shows: what it found, plus the receipts of every group it
 * found. A group matched by its name alone would otherwise be drawn without its
 * receipts, with a sum of 0. The order of the table is kept and no row is added twice.
 */
export function searchWithGroupReceipts(found: readonly Row[], rows: readonly Row[], columns: readonly NamedColumn[]): Row[] {
  const foundGroups = new Set(found.filter((row) => isGroupRow(row, columns)).map((row) => row.id));
  if (foundGroups.size === 0) return [...found];
  const keep = new Set(found.map((row) => row.id));
  return rows.filter((row) => keep.has(row.id) || (row.parentRowId !== undefined && foundGroups.has(row.parentRowId)));
}

const receiptsWord = (n: number) => (n === 1 ? '1 Beleg' : `${n} Belege`);
const groupsWord = (n: number) => (n === 1 ? '1 Gruppe' : `${n} Gruppen`);

export interface DeleteWording {
  title: string;
  body: string;
  confirmLabel: string;
}

/**
 * The question asked before a delete. A group is dissolved, never deleted with
 * its receipts: the wording has to say that the receipts stay, and which rows
 * really are deleted for good.
 */
export function deleteWording(receiptCount: number, groupCount: number, receiptsLeftBehind: number): DeleteWording {
  const receiptBody =
    receiptCount === 1
      ? 'Der Beleg wird mit seiner gespeicherten Datei, seinen Gästen und seiner steuerlichen Zuordnung gelöscht. Das lässt sich nicht rückgängig machen.'
      : 'Die Belege werden mit ihren gespeicherten Dateien, ihren Gästen und ihrer steuerlichen Zuordnung gelöscht. Das lässt sich nicht rückgängig machen.';
  if (groupCount === 0) {
    return { title: `${receiptsWord(receiptCount)} endgültig löschen?`, body: receiptBody, confirmLabel: 'Endgültig löschen' };
  }
  const stay =
    receiptsLeftBehind === 0
      ? groupCount === 1
        ? 'Die Gruppe ist leer und wird entfernt.'
        : 'Die Gruppen werden entfernt.'
      : `${groupCount === 1 ? 'Die Gruppe wird' : 'Die Gruppen werden'} entfernt. ${receiptsWord(receiptsLeftBehind)} ${receiptsLeftBehind === 1 ? 'bleibt' : 'bleiben'} erhalten und ${receiptsLeftBehind === 1 ? 'steht' : 'stehen'} danach wieder einzeln in der Tabelle.`;
  if (receiptCount === 0) {
    return { title: `${groupsWord(groupCount)} auflösen?`, body: stay, confirmLabel: groupCount === 1 ? 'Gruppe auflösen' : 'Gruppen auflösen' };
  }
  return {
    title: `${receiptsWord(receiptCount)} endgültig löschen und ${groupsWord(groupCount)} auflösen?`,
    body: `${receiptBody} ${stay}`,
    confirmLabel: 'Löschen und auflösen',
  };
}

/** What a finished delete did, in words. Empty when nothing was deleted. */
export function deletedWording(receiptCount: number, groupCount: number): string {
  const parts: string[] = [];
  if (receiptCount > 0) parts.push(`${receiptsWord(receiptCount)} gelöscht.`);
  if (groupCount > 0) parts.push(`${groupsWord(groupCount)} aufgelöst.`);
  return parts.join(' ');
}
