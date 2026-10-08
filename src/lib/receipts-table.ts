import 'server-only';
import type { PrismaAdapter } from '@marlinjai/data-table-adapter-prisma';
import type { FooterConfig, ViewConfig } from '@marlinjai/data-table-core';
import type { PrismaClient } from '@prisma/client';
import {
  CATEGORY_TO_KONTO,
  ZUORDNUNG_OPTIONS,
  CURRENCY_OPTIONS,
  PROJECT_OPTIONS,
  MEAL_TYPE_OPTIONS,
  CONSUMPTION_OPTIONS,
  MEAL_COLUMNS,
} from '@/lib/receipts-constants';

/**
 * The Receipts table definition (columns and standard views) and the
 * idempotent routine that brings a workspace's table up to it. Lives outside
 * the server-action file so it can run without a session (database tests,
 * scripts); the action `initializeReceiptsTable` is a thin wrapper.
 */

export const RECEIPTS_TABLE_NAME = 'Receipts';
const CATEGORY_NAMES = Object.keys(CATEGORY_TO_KONTO);

interface ColumnDef {
  name: string;
  type: string;
  isPrimary?: boolean;
  config?: Record<string, unknown>;
  options?: string[];
  optionColors?: string[];
}

const CATEGORY_COLORS = ['#ef4444', '#3b82f6', '#f59e0b', '#8b5cf6', '#06b6d4', '#ec4899', '#10b981', '#f97316', '#14b8a6', '#6b7280'];
const STATUS_OPTIONS = ['Pending', 'Processed', 'Rejected'];
const STATUS_COLORS = ['#f59e0b', '#10b981', '#ef4444'];
const ZUORDNUNG_COLORS = ['#3b82f6', '#10b981', '#f59e0b'];
const DEFAULT_OPTION_COLORS = ['#3b82f6', '#10b981', '#f59e0b', '#8b5cf6', '#ef4444', '#06b6d4', '#ec4899', '#f97316', '#14b8a6', '#6b7280'];

const COLUMNS: ColumnDef[] = [
  { name: 'Name', type: 'text', isPrimary: true },
  { name: 'Vendor', type: 'text' },
  { name: 'Gross', type: 'number' },
  { name: 'Net', type: 'number' },
  { name: 'Tax Rate', type: 'number' },
  { name: 'Date', type: 'date' },
  { name: 'Category', type: 'select', options: CATEGORY_NAMES, optionColors: CATEGORY_COLORS },
  { name: 'Konto', type: 'text' },
  { name: 'Status', type: 'select', options: STATUS_OPTIONS, optionColors: STATUS_COLORS },
  { name: 'Confidence', type: 'number' },
  {
    name: 'Receipt Image',
    type: 'file',
    config: {
      maxFiles: 10,
      allowedTypes: ['application/pdf', 'image/png', 'image/jpeg'],
      maxSizeBytes: 20 * 1024 * 1024,
    },
  },
  { name: 'OCR Text', type: 'text' },
  { name: 'Zuordnung', type: 'select', options: ZUORDNUNG_OPTIONS, optionColors: ZUORDNUNG_COLORS },
  { name: 'Currency', type: 'select', options: CURRENCY_OPTIONS, optionColors: DEFAULT_OPTION_COLORS },
  { name: 'FX Rate', type: 'number', config: { format: 'number', precision: 4 } },
  {
    name: 'EUR Equivalent',
    type: 'formula',
    config: { formula: 'round(prop("Gross") * prop("FX Rate"), 2)', resultType: 'number' },
  },
  { name: 'Business Share %', type: 'number', config: { format: 'number', precision: 0, min: 0, max: 100 } },
  {
    name: 'Attributed EUR',
    type: 'formula',
    config: { formula: 'round(prop("EUR Equivalent") * prop("Business Share %") / 100, 2)', resultType: 'number' },
  },
  { name: 'Project', type: 'select', options: PROJECT_OPTIONS, optionColors: DEFAULT_OPTION_COLORS },
  // Business-meal register (Bewirtungsverzeichnis). Guests are NOT a column:
  // they live in the meal_guests table, so no guest name ever sits in a cell.
  { name: MEAL_COLUMNS.mealType, type: 'select', options: MEAL_TYPE_OPTIONS, optionColors: DEFAULT_OPTION_COLORS },
  { name: MEAL_COLUMNS.occasion, type: 'text' },
  { name: MEAL_COLUMNS.place, type: 'text' },
  { name: MEAL_COLUMNS.tip, type: 'number', config: { format: 'number', precision: 2, min: 0 } },
  { name: MEAL_COLUMNS.host, type: 'text' },
  { name: MEAL_COLUMNS.consumption, type: 'select', options: CONSUMPTION_OPTIONS, optionColors: DEFAULT_OPTION_COLORS },
  { name: MEAL_COLUMNS.detailsAt, type: 'date', config: { includeTime: true } },
  // The receipt's own tax lines as JSON: [{ rate, net, tax }].
  { name: MEAL_COLUMNS.taxLines, type: 'text' },
];

/** Record the owning company on a table that was just created. Never overwrites an existing owner. */
export async function stampTableOwner(
  tableId: string,
  owner: { db: PrismaClient; tenantId: string | null } | undefined,
): Promise<void> {
  if (!owner?.tenantId) return;
  await owner.db.dtTable.updateMany({ where: { id: tableId, authTenantId: null }, data: { authTenantId: owner.tenantId } });
}

/**
 * Idempotently ensures the Receipts table, all COLUMNS, and the standard views exist.
 * Additive only: safe to call on every page load, including against an already-live
 * production table that predates a given column/view (self-heals schema drift).
 */
export async function ensureReceiptsTable(
  adapter: PrismaAdapter,
  workspaceId: string,
  /**
   * The company the workspace belongs to, with the client to write it. The
   * adapter knows nothing about companies, so a table it creates is stamped
   * right after: without this a workspace created after the tenant backfill
   * would stay without a company until the backfill is run again.
   */
  owner?: { db: PrismaClient; tenantId: string | null },
) {
  const tables = await adapter.listTables(workspaceId);
  let table = tables.find((t) => t.name === RECEIPTS_TABLE_NAME);
  if (!table) {
    table = await adapter.createTable({ workspaceId, name: RECEIPTS_TABLE_NAME });
    await stampTableOwner(table.id, owner);
  }

  const existingColumns = await adapter.getColumns(table.id);
  const columnIds: Record<string, string> = {};
  for (const c of existingColumns) columnIds[c.name] = c.id;

  for (const col of COLUMNS) {
    if (columnIds[col.name]) continue;
    const created = await adapter.createColumn({
      tableId: table.id,
      name: col.name,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      type: col.type as any,
      isPrimary: col.isPrimary,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      config: col.config as any,
    });
    columnIds[col.name] = created.id;

    if (col.options) {
      const colors = col.optionColors ?? DEFAULT_OPTION_COLORS;
      for (let i = 0; i < col.options.length; i++) {
        await adapter.createSelectOption({ columnId: created.id, name: col.options[i], color: colors[i % colors.length] });
      }
    }
  }

  const attributedEurColId = columnIds['Attributed EUR'];

  async function ensureFooterSum(viewId: string, config: ViewConfig | undefined) {
    if (!attributedEurColId) return;
    const calculations = (config?.footerConfig as FooterConfig | undefined)?.calculations ?? {};
    if (calculations[attributedEurColId] === 'sum') return;
    await adapter.updateView(viewId, {
      config: { ...config, footerConfig: { calculations: { ...calculations, [attributedEurColId]: 'sum' } } },
    });
  }

  const existingViews = await adapter.getViews(table.id);
  const viewByName = new Map(existingViews.map((v) => [v.name, v]));

  let tableView = viewByName.get('Table');
  if (!tableView) {
    tableView = await adapter.createView({
      tableId: table.id,
      name: 'Table',
      type: 'table',
      isDefault: true,
      config: {
        groupConfig: { columnId: columnIds['Category'], direction: 'asc', hideEmptyGroups: false },
        footerConfig: { calculations: attributedEurColId ? { [attributedEurColId]: 'sum' } : {} },
      },
    });
  } else {
    await ensureFooterSum(tableView.id, tableView.config);
  }

  if (!viewByName.has('By Konto')) {
    await adapter.createView({
      tableId: table.id,
      name: 'By Konto',
      type: 'table',
      config: { groupConfig: { columnId: columnIds['Konto'], direction: 'asc', hideEmptyGroups: false } },
    });
  }

  let vendorView = viewByName.get('By Vendor');
  if (!vendorView) {
    vendorView = await adapter.createView({
      tableId: table.id,
      name: 'By Vendor',
      type: 'table',
      config: {
        groupConfig: { columnId: columnIds['Vendor'], direction: 'asc', hideEmptyGroups: false },
        footerConfig: { calculations: attributedEurColId ? { [attributedEurColId]: 'sum' } : {} },
      },
    });
  } else {
    await ensureFooterSum(vendorView.id, vendorView.config);
  }

  if (!viewByName.has('Board')) {
    await adapter.createView({
      tableId: table.id,
      name: 'Board',
      type: 'board',
      config: { boardConfig: { groupByColumnId: columnIds['Status'], showEmptyGroups: true } },
    });
  }

  if (!viewByName.has('Calendar')) {
    await adapter.createView({
      tableId: table.id,
      name: 'Calendar',
      type: 'calendar',
      config: { calendarConfig: { dateColumnId: columnIds['Date'] } },
    });
  }
}
