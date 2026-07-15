'use server';

import { PrismaAdapter } from '@marlinjai/data-table-adapter-prisma';
import { prisma } from '@/lib/prisma';
import { extractReceiptFields } from '@/lib/extract-receipt-fields';
import { getFxRate } from '@/lib/fx-rates';
import {
  CATEGORY_TO_KONTO,
  ZUORDNUNG_OPTIONS,
  CURRENCY_OPTIONS,
  PROJECT_OPTIONS,
  getDefaultBusinessSharePercent,
} from '@/lib/receipts-constants';
import { classifyWithWebSearch } from '@/lib/web-search';
import type { CellValue, FooterConfig, ViewConfig } from '@marlinjai/data-table-core';
import type { OcrResult } from '@/lib/ocr-types';

const WORKSPACE_ID = 'receipt-ocr';
const TABLE_NAME = 'Receipts';
const CATEGORY_NAMES = Object.keys(CATEGORY_TO_KONTO);

function getAdapter() {
  return new PrismaAdapter({ prisma });
}

async function getTableId() {
  const adapter = getAdapter();
  const tables = await adapter.listTables(WORKSPACE_ID);
  const existing = tables.find(t => t.name === TABLE_NAME);
  if (existing) return { adapter, tableId: existing.id };
  throw new Error('Receipts table not initialized. Visit the dashboard first.');
}

interface FileData {
  id: string;
  originalName: string;
  fileType?: string;
}

interface ClassificationResult {
  aiName: string | null;
  aiCategory: string | null;
  aiKonto: string | null;
  aiZuordnung: string | null;
  aiTaxRate: number | null;
}

async function classifyReceipt(
  extracted: ReturnType<typeof extractReceiptFields>,
  fullText: string,
): Promise<ClassificationResult> {
  try {
    const result = await classifyWithWebSearch({
      vendor: extracted.vendor,
      gross: extracted.gross,
      date: extracted.date,
      fullText,
      categoryNames: CATEGORY_NAMES,
      categoryToKonto: CATEGORY_TO_KONTO,
      zuordnungOptions: ZUORDNUNG_OPTIONS,
    });

    return {
      aiName: result.name,
      aiCategory: result.category,
      aiKonto: result.konto,
      aiZuordnung: result.zuordnung,
      aiTaxRate: result.taxRate,
    };
  } catch (err) {
    console.error('[classifyReceipt] Classification failed:', err);
    return { aiName: null, aiCategory: null, aiKonto: null, aiZuordnung: null, aiTaxRate: null };
  }
}

export async function processReceipt(
  file: FileData,
  ocrResult: OcrResult | null,
) {
  const { adapter, tableId } = await getTableId();
  const extracted = ocrResult ? extractReceiptFields(ocrResult) : null;

  let aiName: string | null = null;
  let aiCategory: string | null = null;
  let aiKonto: string | null = null;
  let aiZuordnung: string | null = null;
  let aiTaxRate: number | null = null;
  let classificationFailed = false;

  if (extracted && ocrResult?.fullText) {
    const ai = await classifyReceipt(extracted, ocrResult.fullText);
    aiName = ai.aiName;
    aiCategory = ai.aiCategory;
    aiKonto = ai.aiKonto;
    aiZuordnung = ai.aiZuordnung;
    aiTaxRate = ai.aiTaxRate;
    classificationFailed = !aiCategory && !aiKonto && !aiZuordnung;
  }

  // Always ensure net and taxRate are populated
  const finalTaxRate = extracted?.taxRate ?? aiTaxRate ?? 19; // Default 19% standard
  let finalNet = extracted?.net ?? null;
  const finalGross = extracted?.gross ?? null;

  if (finalGross !== null && finalNet === null) {
    finalNet = Math.round((finalGross / (1 + finalTaxRate / 100)) * 100) / 100;
  }

  // Multi-currency: detected currency, historical FX rate (looked up live, on save),
  // and the shared/partial-business-use attribution default for this vendor.
  const currency = extracted?.currency ?? 'EUR';
  const fxRate = currency === 'EUR' ? 1 : await getFxRate(currency, extracted?.date ?? null);
  const businessSharePercent = getDefaultBusinessSharePercent(extracted?.vendor ?? null);

  const columns = await adapter.getColumns(tableId);

  const statusCol = columns.find((c) => c.name === 'Status');
  const categoryCol = columns.find((c) => c.name === 'Category');
  const zuordnungCol = columns.find((c) => c.name === 'Zuordnung');
  const currencyCol = columns.find((c) => c.name === 'Currency');

  const [statusOpts, categoryOpts, zuordnungOpts, currencyOpts] = await Promise.all([
    statusCol ? adapter.getSelectOptions(statusCol.id) : Promise.resolve([]),
    categoryCol ? adapter.getSelectOptions(categoryCol.id) : Promise.resolve([]),
    zuordnungCol ? adapter.getSelectOptions(zuordnungCol.id) : Promise.resolve([]),
    currencyCol ? adapter.getSelectOptions(currencyCol.id) : Promise.resolve([]),
  ]);

  const statusValue = classificationFailed
    ? statusOpts.find((o) => o.name === 'Pending')?.id
    : ocrResult?.fullText
      ? statusOpts.find((o) => o.name === 'Processed')?.id
      : statusOpts.find((o) => o.name === 'Pending')?.id;

  const finalCategory = aiCategory || extracted?.category;
  const categoryValue = finalCategory
    ? categoryOpts.find((o) => o.name === finalCategory)?.id ?? null
    : null;
  const finalKonto = aiKonto || extracted?.konto;
  const zuordnungValue = aiZuordnung
    ? zuordnungOpts.find((o) => o.name === aiZuordnung)?.id ?? null
    : null;
  const currencyValue = currencyOpts.find((o) => o.name === currency)?.id ?? null;

  const cells: Record<string, CellValue> = {};
  for (const col of columns) {
    switch (col.name) {
      case 'Name':
        cells[col.id] = aiName || extracted?.name || file.originalName;
        break;
      case 'Vendor':
        cells[col.id] = extracted?.vendor ?? null;
        break;
      case 'Gross':
        cells[col.id] = finalGross;
        break;
      case 'Net':
        cells[col.id] = finalNet;
        break;
      case 'Tax Rate':
        cells[col.id] = finalTaxRate;
        break;
      case 'Date':
        cells[col.id] = extracted?.date ?? null;
        break;
      case 'Category':
        cells[col.id] = categoryValue;
        break;
      case 'Konto':
        cells[col.id] = finalKonto ?? null;
        break;
      case 'Zuordnung':
        cells[col.id] = zuordnungValue;
        break;
      case 'Status':
        cells[col.id] = statusValue ?? '';
        break;
      case 'Confidence':
        cells[col.id] = ocrResult?.confidence ? Math.round(ocrResult.confidence * 100) : 0;
        break;
      case 'Receipt Image': {
        const isPdf = (file.fileType ?? '').includes('pdf') || (file.originalName ?? '').toLowerCase().endsWith('.pdf');
        cells[col.id] = file.id
          ? isPdf ? `/api/files/${file.id}/thumbnail` : `/api/files/${file.id}`
          : '';
        break;
      }
      case 'OCR Text':
        cells[col.id] = ocrResult?.fullText ?? '';
        break;
      case 'Currency':
        cells[col.id] = currencyValue;
        break;
      case 'FX Rate':
        cells[col.id] = fxRate;
        break;
      case 'Business Share %':
        cells[col.id] = businessSharePercent;
        break;
      // 'EUR Equivalent' and 'Attributed EUR' are formula columns, computed
      // automatically on read from Gross/FX Rate/Business Share % — no cell to set.
      // 'Project' is left unassigned; Marlin tags it manually per invoice.
    }
  }

  await adapter.createRow({ tableId, cells });
}

/**
 * Manual batch recompute for invoices backfilled after their invoice date (the live
 * lookup in processReceipt already covers the common case). Retries any non-EUR row
 * in the date range whose FX Rate lookup previously failed, and refreshes the rest.
 */
export async function recomputeFxRates(
  startDate: string,
  endDate: string,
): Promise<{ updated: number; failed: number; skippedEur: number }> {
  const { adapter, tableId } = await getTableId();
  const columns = await adapter.getColumns(tableId);
  const dateCol = columns.find((c) => c.name === 'Date');
  const currencyCol = columns.find((c) => c.name === 'Currency');
  const fxRateCol = columns.find((c) => c.name === 'FX Rate');
  if (!dateCol || !currencyCol || !fxRateCol) {
    throw new Error('Currency/FX Rate columns are missing. Reload the dashboard once to initialize them.');
  }
  const currencyOpts = await adapter.getSelectOptions(currencyCol.id);
  const currencyNameById = new Map(currencyOpts.map((o) => [o.id, o.name]));

  let updated = 0;
  let failed = 0;
  let skippedEur = 0;
  let offset = 0;
  const limit = 100;

  for (;;) {
    const { items, hasMore } = await adapter.getRows(tableId, {
      filters: [
        { columnId: dateCol.id, operator: 'greaterThanOrEquals', value: startDate },
        { columnId: dateCol.id, operator: 'lessThanOrEquals', value: endDate },
      ],
      limit,
      offset,
    });

    for (const row of items) {
      const currencyOptionId = row.cells[currencyCol.id] as string | null;
      const currencyName = currencyOptionId ? currencyNameById.get(currencyOptionId) ?? null : null;
      const date = row.cells[dateCol.id] as string | null;

      if (!currencyName || currencyName === 'EUR') {
        skippedEur++;
        continue;
      }

      const rate = await getFxRate(currencyName, date);
      if (rate === null) {
        failed++;
        continue;
      }

      await adapter.updateRow(row.id, { [fxRateCol.id]: rate });
      updated++;
    }

    if (!hasMore || items.length === 0) break;
    offset += limit;
  }

  return { updated, failed, skippedEur };
}

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
  { name: 'Receipt Image', type: 'url' },
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
];

/**
 * Idempotently ensures the Receipts table, all COLUMNS, and the standard views exist.
 * Additive only: safe to call on every page load, including against an already-live
 * production table that predates a given column/view (self-heals schema drift).
 */
export async function initializeReceiptsTable() {
  const adapter = getAdapter();
  const tables = await adapter.listTables(WORKSPACE_ID);
  let table = tables.find((t) => t.name === TABLE_NAME);
  if (!table) {
    table = await adapter.createTable({ workspaceId: WORKSPACE_ID, name: TABLE_NAME });
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
