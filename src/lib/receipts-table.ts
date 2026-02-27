import { DataBrainAdapter } from '@/lib/data-brain-adapter';
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

const STATUS_OPTIONS = ['Pending', 'Processed', 'Rejected'];
const STATUS_COLORS = ['#f59e0b', '#10b981', '#ef4444'];

// Adapter will be set at runtime — D1 when on Cloudflare, otherwise Data Brain HTTP adapter
let _adapter: DatabaseAdapter | null = null;

export function setAdapter(adapter: DatabaseAdapter) {
  _adapter = adapter;
}

export function getAdapter(): DatabaseAdapter {
  if (!_adapter) {
    // Fallback to Data Brain HTTP adapter for local dev (persistent storage)
    const apiKey = process.env.NEXT_PUBLIC_DATA_BRAIN_API_KEY;
    const baseUrl = process.env.NEXT_PUBLIC_DATA_BRAIN_URL;
    if (apiKey && baseUrl) {
      _adapter = new DataBrainAdapter({ apiKey, baseUrl });
    } else {
      throw new Error(
        'Data Brain environment variables not set: NEXT_PUBLIC_DATA_BRAIN_API_KEY and NEXT_PUBLIC_DATA_BRAIN_URL are required'
      );
    }
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
        hideEmptyGroups: true,
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
        hideEmptyGroups: true,
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

export { WORKSPACE_ID };
