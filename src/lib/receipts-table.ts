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
import { firstColumnIdByName } from '@/lib/column-lookup';
import { mergeDuplicateColumns } from '@/lib/receipts-duplicate-columns';
import { readAmounts } from '@/lib/extraction/amounts';
import { parseTaxLines, serializeTaxLines } from '@/lib/meals/rules';
import { TAX_RATE_COLUMN, TAX_RATES_COLUMN, formatTaxRates } from '@/lib/tax-rates';

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
  // What the receipt says about its rates, as text: "19 %" or "19 % + 7 %" (see tax-rates.ts).
  { name: TAX_RATES_COLUMN, type: 'text' },
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

const STANDARD_VIEWS = ['Table', 'By Konto', 'By Vendor', 'Board', 'Calendar'] as const;
/** The views whose footer sums the attributed amount. */
const FOOTER_SUM_VIEWS: readonly string[] = ['Table', 'By Vendor'];

/**
 * True when a table already is what `ensureReceiptsTable` would make of it:
 * every column of COLUMNS exactly once, every standard view, the footer sums.
 * Pure, so the common page load decides it from two reads and takes no lock.
 */
export function receiptsSchemaIsCurrent(
  columns: readonly { id: string; name: string; config?: unknown }[],
  views: readonly { name: string; config?: ViewConfig }[],
): boolean {
  const count = new Map<string, number>();
  for (const c of columns) count.set(c.name, (count.get(c.name) ?? 0) + 1);
  if (COLUMNS.some((col) => count.get(col.name) !== 1)) return false;
  // Receipts stored before the rates text existed still wait for theirs.
  if (!ratesAreFilled(columns)) return false;

  const viewByName = new Map(views.map((v) => [v.name, v]));
  if (STANDARD_VIEWS.some((name) => !viewByName.has(name))) return false;

  const attributedEurColId = firstColumnIdByName(columns).get('Attributed EUR');
  if (!attributedEurColId) return false;
  return FOOTER_SUM_VIEWS.every((name) => {
    const footer = viewByName.get(name)?.config?.footerConfig as FooterConfig | undefined;
    return footer?.calculations?.[attributedEurColId] === 'sum';
  });
}

/** How long a request waits for another one that is bringing the table up to date. */
const SCHEMA_WAIT_MS = 60_000;
const SCHEMA_POLL_MS = 150;
/** Upper bound for the work itself. A Receipts table is small: this is far above what it takes. */
const SCHEMA_WORK_MS = 120_000;

/**
 * Run `work` under the workspace's schema lock, unless another request already
 * holds it: then wait until `isCurrent` says that request has finished.
 *
 * Two page loads that both find a column missing must not both create it. The
 * one that gets the lock keeps it on a single connection for the length of the
 * transaction, while `work` itself runs on the pool as usual. The others do
 * NOT queue on the lock: a waiter parked inside a transaction would hold a
 * connection each, and a handful of them starve the request doing the work of
 * the connections it needs. They release at once and poll instead.
 */
async function underSchemaLock(
  db: PrismaClient,
  workspaceId: string,
  isCurrent: () => Promise<boolean>,
  work: () => Promise<void>,
): Promise<void> {
  const key = `receipts-schema:${workspaceId}`;
  const deadline = Date.now() + SCHEMA_WAIT_MS;
  for (;;) {
    const done = await db.$transaction(
      async (tx) => {
        const [{ locked }] = await tx.$queryRaw<{ locked: boolean }[]>`
          SELECT pg_try_advisory_xact_lock(hashtextextended(${key}, 0)) AS locked`;
        if (!locked) return false;
        await work();
        return true;
      },
      { maxWait: SCHEMA_WAIT_MS, timeout: SCHEMA_WORK_MS },
    );
    if (done) return;

    await new Promise((resolve) => setTimeout(resolve, SCHEMA_POLL_MS));
    if (await isCurrent()) return;
    if (Date.now() > deadline) {
      throw new Error(`The Receipts table of workspace ${workspaceId} is still being set up by another request.`);
    }
  }
}

/**
 * Idempotently ensures the Receipts table, all COLUMNS, and the standard views exist.
 * Safe to call on every page load, including against an already-live production
 * table that predates a given column/view (self-heals schema drift), and safe to
 * call from several requests at once: whatever has to be created is created under
 * the workspace's schema lock, and a column that an earlier race created twice is
 * folded back into one (see `mergeDuplicateColumns`). That repair is the one step
 * that is not additive: it removes a doubled column once its values are moved.
 */
export async function ensureReceiptsTable(
  adapter: PrismaAdapter,
  workspaceId: string,
  /**
   * The database client, for the schema lock, and the company the workspace
   * belongs to. The adapter knows nothing about companies, so a table it
   * creates is stamped right after: without this a workspace created after the
   * tenant backfill would stay without a company until the backfill is run again.
   */
  owner: { db: PrismaClient; tenantId: string | null },
) {
  const isCurrent = async (): Promise<boolean> => {
    const existing = (await adapter.listTables(workspaceId)).find((t) => t.name === RECEIPTS_TABLE_NAME);
    if (!existing) return false;
    const [columns, views] = await Promise.all([adapter.getColumns(existing.id), adapter.getViews(existing.id)]);
    return receiptsSchemaIsCurrent(columns, views);
  };
  if (await isCurrent()) return;
  await underSchemaLock(owner.db, workspaceId, isCurrent, () => bringReceiptsTableUpToDate(adapter, workspaceId, owner));
}

/** Set on the rates column's config once every receipt that existed before it has its text. */
const RATES_FILLED = 'taxRatesFilled';
/** How long one page load works on the fill before it leaves the rest to the next one. */
const FILL_BUDGET_MS = 45_000;

function ratesAreFilled(columns: ReadonlyArray<{ name: string; config?: unknown }>): boolean {
  const column = columns.find((c) => c.name === TAX_RATES_COLUMN);
  return Boolean(column && (column.config as Record<string, unknown> | null | undefined)?.[RATES_FILLED] === true);
}

/**
 * The tax groups a stored receipt prints, read again from its stored text.
 * Only for a row without tax lines, and only when the reading arrives at the
 * row's own total and finds more than one rate: anything less sure keeps the
 * single rate.
 */
function printedTaxLines(cells: Record<string, unknown>, ids: Map<string, string>): Array<{ rate: number; net: number; tax: number }> | null {
  const cell = (name: string): unknown => {
    const id = ids.get(name);
    return id ? cells[id] : null;
  };
  const stored = cell(MEAL_COLUMNS.taxLines);
  const text = cell('OCR Text');
  const gross = Number(cell('Gross'));
  if ((typeof stored === 'string' && stored.trim()) || typeof text !== 'string' || !text.trim() || !Number.isFinite(gross)) return null;
  const day = cell('Date');
  const iso = day instanceof Date ? day.toISOString().slice(0, 10) : typeof day === 'string' && /^\d{4}-\d{2}-\d{2}/.test(day) ? day.slice(0, 10) : null;
  const read = readAmounts(text, { date: iso });
  if (read.gross === null || Math.abs(read.gross - gross) > 0.005 || new Set(read.taxGroups.map((g) => g.rate)).size < 2) return null;
  return read.taxGroups.map((g) => ({ rate: g.rate, net: g.net, tax: g.tax }));
}

/**
 * A table that existed before the rates text did: put the column next to the
 * number column, and give every receipt its text from what it already holds
 * (its tax lines, else its stored text where that prints two rates, else its
 * single rate). An old receipt found to print two rates gets its tax lines
 * stored too, so later writes derive the same text.
 *
 * The work can be interrupted at any point and is taken up again by the next
 * page load: only a row whose text is still empty is written, each row is read
 * again right before, and the column is marked as filled only after a complete
 * pass. One page load works on it for a bounded time. Returns whether it finished.
 */
async function fillTaxRates(adapter: PrismaAdapter, tableId: string): Promise<boolean> {
  const columns = await adapter.getColumns(tableId);
  const ids = firstColumnIdByName(columns);
  const ratesId = ids.get(TAX_RATES_COLUMN);
  if (!ratesId) return false;
  const rateId = ids.get(TAX_RATE_COLUMN);
  const linesId = ids.get(MEAL_COLUMNS.taxLines);

  const order = columns.map((c) => c.id);
  if (rateId && order[order.indexOf(rateId) + 1] !== ratesId) {
    const next = order.filter((id) => id !== ratesId);
    next.splice(next.indexOf(rateId) + 1, 0, ratesId);
    await adapter.reorderColumns(tableId, next);
  }

  const blank = (v: unknown) => v === null || v === undefined || v === '';
  const deadline = Date.now() + FILL_BUDGET_MS;
  let offset = 0;
  for (;;) {
    const page = await adapter.getRows(tableId, { limit: 500, offset, includeArchived: true });
    for (const listed of page.items) {
      if (!blank(listed.cells[ratesId])) continue;
      if (Date.now() > deadline) return false;
      try {
        // Read again: the row may have been edited since the page was listed.
        const row = await adapter.getRow(listed.id);
        if (!row || !blank(row.cells[ratesId])) continue;
        const printed = linesId ? printedTaxLines(row.cells, ids) : null;
        const lines = printed && linesId ? { [linesId]: serializeTaxLines(printed) } : {};
        // The text any write of these lines, or of this rate, would get.
        const text = formatTaxRates(printed ?? (linesId ? parseTaxLines(row.cells[linesId]) : null), rateId ? numberOrNull(row.cells[rateId]) : null);
        if (!text) continue;
        await adapter.updateRow(row.id, { ...lines, [ratesId]: text });
      } catch (e) {
        // Ids only: no cell value reaches the log. The row gets its text with its next save.
        console.error('[receipts-table] could not fill the tax rates of a row', JSON.stringify({ tableId, rowId: listed.id }), e);
      }
    }
    if (!page.hasMore || page.items.length === 0) break;
    offset += page.items.length;
  }
  const column = columns.find((c) => c.id === ratesId);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await adapter.updateColumn(ratesId, { config: { ...((column?.config as Record<string, unknown> | undefined) ?? {}), [RATES_FILLED]: true } as any });
  return true;
}

function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** The work of `ensureReceiptsTable`. Only ever runs under the workspace's schema lock. */
async function bringReceiptsTableUpToDate(
  adapter: PrismaAdapter,
  workspaceId: string,
  owner: { db: PrismaClient; tenantId: string | null },
) {
  const tables = await adapter.listTables(workspaceId);
  let table = tables.find((t) => t.name === RECEIPTS_TABLE_NAME);
  if (!table) {
    table = await adapter.createTable({ workspaceId, name: RECEIPTS_TABLE_NAME });
    await stampTableOwner(table.id, owner);
  }

  const merged = await mergeDuplicateColumns(adapter, table.id, COLUMNS.map((c) => c.name));
  if (merged.length > 0) {
    // Names and counts only: no cell value ever reaches the log.
    console.warn('[receipts-table] merged duplicate columns', JSON.stringify({ workspaceId, tableId: table.id, merged }));
  }

  const existingColumns = await adapter.getColumns(table.id);
  const columnIds: Record<string, string> = Object.fromEntries(firstColumnIdByName(existingColumns));

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

  // Receipts that existed before the rates text get theirs; resumed by the next page load until done.
  if (!ratesAreFilled(await adapter.getColumns(table.id))) await fillTaxRates(adapter, table.id);

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
