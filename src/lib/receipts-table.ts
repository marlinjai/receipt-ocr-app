import { MemoryAdapter } from '@marlinjai/data-table-adapter-memory';
import type { ColumnType } from '@marlinjai/data-table-core';

const WORKSPACE_ID = 'receipt-ocr';
const TABLE_NAME = 'Receipts';

const RECEIPT_COLUMNS: Array<{ name: string; type: ColumnType; isPrimary?: boolean }> = [
  { name: 'Name', type: 'text', isPrimary: true },
  { name: 'Vendor', type: 'text' },
  { name: 'Amount', type: 'number' },
  { name: 'Date', type: 'date' },
  { name: 'Category', type: 'select' },
  { name: 'Status', type: 'select' },
  { name: 'Confidence', type: 'number' },
  { name: 'Receipt Image', type: 'url' },
  { name: 'OCR Text', type: 'text' },
];

const CATEGORY_OPTIONS = ['Food', 'Travel', 'Office', 'Utilities', 'Entertainment', 'Other'];
const CATEGORY_COLORS = ['#ef4444', '#3b82f6', '#f59e0b', '#10b981', '#8b5cf6', '#6b7280'];

const STATUS_OPTIONS = ['Pending', 'Processed', 'Rejected'];
const STATUS_COLORS = ['#f59e0b', '#10b981', '#ef4444'];

export const dbAdapter = new MemoryAdapter();

let initPromise: Promise<string> | null = null;

export function getReceiptsTableId(): Promise<string> {
  if (!initPromise) {
    initPromise = initializeTable();
  }
  return initPromise;
}

async function initializeTable(): Promise<string> {
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

  // Create select options for Category
  const categoryColId = columnIds['Category'];
  for (let i = 0; i < CATEGORY_OPTIONS.length; i++) {
    await dbAdapter.createSelectOption({
      columnId: categoryColId,
      name: CATEGORY_OPTIONS[i],
      color: CATEGORY_COLORS[i],
    });
  }

  // Create select options for Status
  const statusColId = columnIds['Status'];
  for (let i = 0; i < STATUS_OPTIONS.length; i++) {
    await dbAdapter.createSelectOption({
      columnId: statusColId,
      name: STATUS_OPTIONS[i],
      color: STATUS_COLORS[i],
    });
  }

  // Create default views
  await dbAdapter.createView({
    tableId: table.id,
    name: 'Table',
    type: 'table',
    isDefault: true,
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

export { WORKSPACE_ID };
