import type { ColumnType, DatabaseAdapter } from '@marlinjai/data-table-core';

const WORKSPACE_ID = 'receipt-ocr';
const TABLE_NAME = 'Receipts';

const RECEIPT_COLUMNS: Array<{ name: string; type: ColumnType; isPrimary?: boolean }> = [
  { name: 'Name', type: 'text', isPrimary: true },
  { name: 'Vendor', type: 'text' },
  { name: 'Gross', type: 'number' },
  { name: 'Net', type: 'number' },
  { name: 'Tax Rate', type: 'number' },
  { name: 'Date', type: 'date' },
  { name: 'Category', type: 'select' },
  { name: 'Konto', type: 'text' },
  { name: 'Status', type: 'select' },
  { name: 'Confidence', type: 'number' },
  { name: 'Receipt Image', type: 'url' },
  { name: 'OCR Text', type: 'text' },
];

const CATEGORY_OPTIONS = [
  'Bewirtung',
  'Reisekosten',
  'Bürobedarf',
  'Software & Lizenzen',
  'Telefon & Internet',
  'Hardware & IT',
  'Miete & Nebenkosten',
  'Versicherungen',
  'Fachliteratur',
  'Sonstige Ausgaben',
];
const CATEGORY_COLORS = [
  '#ef4444', // Bewirtung – red
  '#3b82f6', // Reisekosten – blue
  '#f59e0b', // Bürobedarf – amber
  '#8b5cf6', // Software & Lizenzen – violet
  '#06b6d4', // Telefon & Internet – cyan
  '#ec4899', // Hardware & IT – pink
  '#10b981', // Miete & Nebenkosten – emerald
  '#f97316', // Versicherungen – orange
  '#14b8a6', // Fachliteratur – teal
  '#6b7280', // Sonstige Ausgaben – gray
];

export const CATEGORY_TO_KONTO: Record<string, string> = {
  'Bewirtung': '4650',
  'Reisekosten': '4670',
  'Bürobedarf': '4930',
  'Software & Lizenzen': '4806',
  'Telefon & Internet': '4920',
  'Hardware & IT': '4855',
  'Miete & Nebenkosten': '4210',
  'Versicherungen': '4360',
  'Fachliteratur': '4940',
  'Sonstige Ausgaben': '4900',
};

export const ZUORDNUNG_OPTIONS = ['Universität', 'Geschäftlich', 'Privat'];
const ZUORDNUNG_COLORS = ['#3b82f6', '#10b981', '#f59e0b'];

const STATUS_OPTIONS = ['Pending', 'Processed', 'Rejected'];
const STATUS_COLORS = ['#f59e0b', '#10b981', '#ef4444'];

// Adapter is set at runtime via setAdapter() in AppLayout using the D1 Cloudflare binding
let _adapter: DatabaseAdapter | null = null;

export function setAdapter(adapter: DatabaseAdapter) {
  _adapter = adapter;
}

export function getAdapter(): DatabaseAdapter {
  if (!_adapter) {
    throw new Error(
      'Database adapter not initialized. Ensure setAdapter() is called before accessing data (e.g., in AppLayout).'
    );
  }
  return _adapter;
}

// Alias for backwards compatibility
export const dbAdapter = new Proxy({} as DatabaseAdapter, {
  get(_target, prop, receiver) {
    return Reflect.get(getAdapter(), prop, receiver);
  },
});

let initPromise: Promise<string> | null = null;

export function getReceiptsTableId(): Promise<string> {
  if (!initPromise) {
    initPromise = initializeTable();
  }
  return initPromise;
}

async function initializeTable(): Promise<string> {
  const adapter = getAdapter();

  // Check if table already exists (for D1 persistence)
  const existingTables = await adapter.listTables(WORKSPACE_ID);
  const existing = existingTables.find((t) => t.name === TABLE_NAME);
  if (existing) return existing.id;

  const table = await adapter.createTable({
    workspaceId: WORKSPACE_ID,
    name: TABLE_NAME,
  });

  const columnIds: Record<string, string> = {};

  for (const col of RECEIPT_COLUMNS) {
    const column = await adapter.createColumn({
      tableId: table.id,
      name: col.name,
      type: col.type,
      isPrimary: col.isPrimary,
    });
    columnIds[col.name] = column.id;
  }

  const categoryColId = columnIds['Category'];
  for (let i = 0; i < CATEGORY_OPTIONS.length; i++) {
    await adapter.createSelectOption({
      columnId: categoryColId,
      name: CATEGORY_OPTIONS[i],
      color: CATEGORY_COLORS[i],
    });
  }

  const statusColId = columnIds['Status'];
  for (let i = 0; i < STATUS_OPTIONS.length; i++) {
    await adapter.createSelectOption({
      columnId: statusColId,
      name: STATUS_OPTIONS[i],
      color: STATUS_COLORS[i],
    });
  }

  await adapter.createView({
    tableId: table.id,
    name: 'Table',
    type: 'table',
    isDefault: true,
    config: {
      groupConfig: {
        columnId: categoryColId,
        direction: 'asc',
        hideEmptyGroups: false,
      },
    },
  });

  const kontoColId = columnIds['Konto'];
  await adapter.createView({
    tableId: table.id,
    name: 'By Konto',
    type: 'table',
    config: {
      groupConfig: {
        columnId: kontoColId,
        direction: 'asc',
        hideEmptyGroups: false,
      },
    },
  });

  await adapter.createView({
    tableId: table.id,
    name: 'Board',
    type: 'board',
    config: {
      boardConfig: {
        groupByColumnId: statusColId,
        showEmptyGroups: true,
      },
    },
  });

  await adapter.createView({
    tableId: table.id,
    name: 'Calendar',
    type: 'calendar',
    config: {
      calendarConfig: {
        dateColumnId: columnIds['Date'],
      },
    },
  });

  return table.id;
}

export { WORKSPACE_ID, CATEGORY_OPTIONS };

/**
 * Ensure the Zuordnung (assignment context) column exists on the table.
 * Creates the column + select options if missing; returns the column ID and options.
 */
export async function ensureZuordnungColumn(tableId: string): Promise<{
  columnId: string;
  options: Array<{ id: string; name: string; color: string }>;
}> {
  const adapter = getAdapter();
  const columns = await adapter.getColumns(tableId);
  const existing = columns.find((c) => c.name === 'Zuordnung');

  if (existing) {
    const options = await adapter.getSelectOptions(existing.id);
    return {
      columnId: existing.id,
      options: options.map((o) => ({ id: o.id, name: o.name, color: o.color ?? '' })),
    };
  }

  const col = await adapter.createColumn({
    tableId,
    name: 'Zuordnung',
    type: 'select',
  });

  const options: Array<{ id: string; name: string; color: string }> = [];
  for (let i = 0; i < ZUORDNUNG_OPTIONS.length; i++) {
    const opt = await adapter.createSelectOption({
      columnId: col.id,
      name: ZUORDNUNG_OPTIONS[i],
      color: ZUORDNUNG_COLORS[i],
    });
    options.push({ id: opt.id, name: opt.name, color: opt.color ?? ZUORDNUNG_COLORS[i] });
  }

  return { columnId: col.id, options };
}
