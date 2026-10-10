import type { Column, Row, SelectOption } from '@marlinjai/data-table-core';
import { MEAL_COLUMNS } from '@/lib/receipts-constants';
import { GROUP_KIND, ROW_KIND_COLUMN } from '@/lib/receipts-kind';

/**
 * One receipts table with every case a group can be in, shared by every test
 * that proves a group is never counted and its receipts are counted once.
 * Every name, vendor and amount in here is invented.
 *
 * - `group` "Messe" holds two receipts, `hotel` (100,00) and `dinner` (40,00,
 *   a business meal). The group is made as tempting as possible: it sits in the
 *   meal category, and it carries an amount, a vendor and a date of its own,
 *   which the app never writes on a group. A site that counted it would be off
 *   by 999,00.
 * - `licence` (10,00) is a receipt outside any group.
 * - `emptyGroup` holds nothing and is still not a receipt.
 * - `orphan` (7,00) points at a group that no longer exists.
 */

const COLUMN_DEFS: Array<[name: string, type: string]> = [
  ['Name', 'text'],
  ['Vendor', 'text'],
  ['Gross', 'number'],
  ['Net', 'number'],
  ['Tax Rate', 'number'],
  ['Date', 'date'],
  ['Category', 'select'],
  ['Konto', 'text'],
  ['Status', 'select'],
  ['Zuordnung', 'select'],
  ['Currency', 'select'],
  ['FX Rate', 'number'],
  ['EUR Equivalent', 'formula'],
  ['Business Share %', 'number'],
  ['Attributed EUR', 'formula'],
  ['Project', 'select'],
  [MEAL_COLUMNS.mealType, 'select'],
  [MEAL_COLUMNS.occasion, 'text'],
  [MEAL_COLUMNS.place, 'text'],
  [MEAL_COLUMNS.tip, 'number'],
  [MEAL_COLUMNS.host, 'text'],
  [MEAL_COLUMNS.consumption, 'select'],
  [MEAL_COLUMNS.detailsAt, 'date'],
  [MEAL_COLUMNS.taxLines, 'text'],
  [ROW_KIND_COLUMN, 'text'],
];

export const TABLE_ID = 'tbl_receipts';
export const WORKSPACE_ID = 'ws_1';

export const columnId = (name: string) => `col_${name.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`;

export const columns: Column[] = COLUMN_DEFS.map(
  ([name, type], position) => ({ id: columnId(name), tableId: TABLE_ID, name, type, position, width: 160, isPrimary: name === 'Name' }) as unknown as Column,
);

const option = (columnName: string, name: string) => ({ id: `opt_${name.toLowerCase()}`, columnId: columnId(columnName), name, position: 0 }) as unknown as SelectOption;

export const selectOptions = new Map<string, SelectOption[]>([
  [columnId('Category'), [option('Category', 'Bewirtung'), option('Category', 'Reisekosten'), option('Category', 'Software')]],
  [columnId('Currency'), [option('Currency', 'EUR'), option('Currency', 'USD')]],
  [columnId('Zuordnung'), [option('Zuordnung', 'Geschäftlich')]],
]);

function row(id: string, cells: Record<string, unknown>, parentRowId?: string): Row {
  const byId = Object.fromEntries(Object.entries(cells).map(([name, value]) => [columnId(name), value]));
  return { id, tableId: TABLE_ID, cells: byId, parentRowId, archived: false } as unknown as Row;
}

const receipt = (id: string, name: string, vendor: string, gross: number, day: string, category: string, parentRowId?: string) =>
  row(
    id,
    {
      Name: name,
      Vendor: vendor,
      Gross: gross,
      Date: `${day}T00:00:00.000Z`,
      Category: `opt_${category.toLowerCase()}`,
      Currency: 'opt_eur',
      'FX Rate': 1,
      'EUR Equivalent': gross,
      'Business Share %': 100,
      'Attributed EUR': gross,
      Zuordnung: 'opt_geschäftlich',
    },
    parentRowId,
  );

export const group = row('group', {
  Name: 'Messe',
  Vendor: 'Hotel Nordlicht',
  Gross: 999,
  Date: '2026-03-10T00:00:00.000Z',
  Category: 'opt_bewirtung',
  Currency: 'opt_eur',
  'FX Rate': 1,
  'EUR Equivalent': 999,
  'Business Share %': 100,
  'Attributed EUR': 999,
  [ROW_KIND_COLUMN]: GROUP_KIND,
});
export const hotel = receipt('hotel', 'Hotel', 'Hotel Nordlicht', 100, '2026-03-10', 'Reisekosten', 'group');
export const dinner = receipt('dinner', 'Abendessen', 'Gasthaus Linde', 40, '2026-03-11', 'Bewirtung', 'group');
export const licence = receipt('licence', 'Lizenz', 'Softwarehaus Beispiel', 10, '2026-03-12', 'Software');
export const emptyGroup = row('emptyGroup', { Name: 'Leere Gruppe', [ROW_KIND_COLUMN]: GROUP_KIND });
export const orphan = receipt('orphan', 'Taxi', 'Taxi Beispiel', 7, '2026-03-13', 'Reisekosten', 'deleted-group');

/** Every row of the table, groups included. */
export const allRows: Row[] = [group, hotel, dinner, licence, emptyGroup, orphan];
/** The ids of the receipts: what every count and sum must cover, each once. */
export const RECEIPT_IDS = ['hotel', 'dinner', 'licence', 'orphan'];
/** The gross total of the receipts: 100 + 40 + 10 + 7. The group's own 999 is never part of it. */
export const RECEIPT_TOTAL = 157;

/** A stand-in for the table adapter that serves the fixture, in pages like the real one. */
export function fakeAdapter(rows: Row[] = allRows) {
  const updated: Array<{ rowId: string; cells: Record<string, unknown> }> = [];
  return {
    updated,
    listTables: async () => [{ id: TABLE_ID, name: 'Receipts' }],
    getColumns: async () => columns,
    getSelectOptions: async (id: string) => selectOptions.get(id) ?? [],
    getRows: async (_tableId: string, query?: { limit?: number; offset?: number }) => {
      const offset = query?.offset ?? 0;
      const limit = query?.limit ?? 50;
      const items = rows.slice(offset, offset + limit);
      return { items, total: rows.length, hasMore: offset + limit < rows.length };
    },
    getRow: async (id: string) => rows.find((r) => r.id === id) ?? null,
    updateRow: async (rowId: string, cells: Record<string, unknown>) => {
      updated.push({ rowId, cells });
      return rows.find((r) => r.id === rowId) as Row;
    },
  };
}

/**
 * A stand-in for the database client: every table is empty. Enough for code
 * that only looks things up beside the receipts table (guests, decisions,
 * review state).
 */
export function emptyDb(): never {
  const model = new Proxy(
    {},
    {
      get: (_target, method: string) => async () => {
        if (method === 'findMany') return [];
        if (method === 'count') return 0;
        if (method === 'deleteMany' || method === 'updateMany') return { count: 0 };
        return null;
      },
    },
  );
  return new Proxy({}, { get: () => model }) as never;
}
