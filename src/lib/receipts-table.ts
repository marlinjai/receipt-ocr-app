import type { ColumnType, DatabaseAdapter } from '@marlinjai/data-table-core';
import {
  CATEGORY_OPTIONS,
  CATEGORY_TO_KONTO,
  ZUORDNUNG_OPTIONS,
  WORKSPACE_ID,
} from './receipts-constants';

const TABLE_NAME = 'Receipts';

// Lazy-initialized to prevent PrismaClient from being bundled into the client
let _adapter: DatabaseAdapter | null = null;
function getAdapter(): DatabaseAdapter {
  if (!_adapter) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { PrismaAdapter } = require('@marlinjai/data-table-adapter-prisma');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { prisma } = require('./prisma');
    _adapter = new PrismaAdapter({ prisma }) as DatabaseAdapter;
  }
  return _adapter!;
}

export const dbAdapter = new Proxy({} as DatabaseAdapter, {
  get(_target, prop, receiver) {
    return Reflect.get(getAdapter(), prop, receiver);
  },
});

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

const CATEGORY_COLORS = [
  '#ef4444', '#3b82f6', '#f59e0b', '#8b5cf6', '#06b6d4',
  '#ec4899', '#10b981', '#f97316', '#14b8a6', '#6b7280',
];

const ZUORDNUNG_COLORS = ['#3b82f6', '#10b981', '#f59e0b'];

const STATUS_OPTIONS = ['Pending', 'Processed', 'Rejected'];
const STATUS_COLORS = ['#f59e0b', '#10b981', '#ef4444'];

let initPromise: Promise<string> | null = null;

export function getReceiptsTableId(): Promise<string> {
  if (!initPromise) {
    initPromise = initializeTable();
  }
  return initPromise;
}

async function initializeTable(): Promise<string> {
  const existingTables = await dbAdapter.listTables(WORKSPACE_ID);
  const existing = existingTables.find((t) => t.name === TABLE_NAME);
  if (existing) return existing.id;

  const table = await dbAdapter.createTable({
    workspaceId: WORKSPACE_ID,
    name: TABLE_NAME,
  });

  const columnIds: Record<string, string> = {};

  for (const col of RECEIPT_COLUMNS) {
    const column = await dbAdapter.createColumn({
      tableId: table.id,
      name: col.name,
      type: col.type,
      isPrimary: col.isPrimary,
    });
    columnIds[col.name] = column.id;
  }

  const categoryColId = columnIds['Category'];
  for (let i = 0; i < CATEGORY_OPTIONS.length; i++) {
    await dbAdapter.createSelectOption({
      columnId: categoryColId,
      name: CATEGORY_OPTIONS[i],
      color: CATEGORY_COLORS[i],
    });
  }

  const statusColId = columnIds['Status'];
  for (let i = 0; i < STATUS_OPTIONS.length; i++) {
    await dbAdapter.createSelectOption({
      columnId: statusColId,
      name: STATUS_OPTIONS[i],
      color: STATUS_COLORS[i],
    });
  }

  await dbAdapter.createView({
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
  await dbAdapter.createView({
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

  await dbAdapter.createView({
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

  await dbAdapter.createView({
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

export async function ensureZuordnungColumn(tableId: string): Promise<{
  columnId: string;
  options: Array<{ id: string; name: string; color: string }>;
}> {
  const columns = await dbAdapter.getColumns(tableId);
  const existing = columns.find((c) => c.name === 'Zuordnung');

  if (existing) {
    const options = await dbAdapter.getSelectOptions(existing.id);
    return {
      columnId: existing.id,
      options: options.map((o) => ({ id: o.id, name: o.name, color: o.color ?? '' })),
    };
  }

  const col = await dbAdapter.createColumn({
    tableId,
    name: 'Zuordnung',
    type: 'select',
  });

  const options: Array<{ id: string; name: string; color: string }> = [];
  for (let i = 0; i < ZUORDNUNG_OPTIONS.length; i++) {
    const opt = await dbAdapter.createSelectOption({
      columnId: col.id,
      name: ZUORDNUNG_OPTIONS[i],
      color: ZUORDNUNG_COLORS[i],
    });
    options.push({ id: opt.id, name: opt.name, color: opt.color ?? ZUORDNUNG_COLORS[i] });
  }

  return { columnId: col.id, options };
}

// Re-export constants for server-side consumers that import from this file
export { CATEGORY_TO_KONTO, ZUORDNUNG_OPTIONS, WORKSPACE_ID, CATEGORY_OPTIONS } from './receipts-constants';
