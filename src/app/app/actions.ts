'use server';

import { PrismaAdapter } from '@marlinjai/data-table-adapter-prisma';
import { prisma } from '@/lib/prisma';
import { extractReceiptFields } from '@/lib/extract-receipt-fields';
import { CATEGORY_TO_KONTO, ZUORDNUNG_OPTIONS } from '@/lib/receipts-constants';
import { classifyWithWebSearch } from '@/lib/web-search';
import type { CellValue } from '@marlinjai/data-table-core';
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

  const columns = await adapter.getColumns(tableId);

  const statusCol = columns.find((c) => c.name === 'Status');
  const categoryCol = columns.find((c) => c.name === 'Category');
  const zuordnungCol = columns.find((c) => c.name === 'Zuordnung');

  const [statusOpts, categoryOpts, zuordnungOpts] = await Promise.all([
    statusCol ? adapter.getSelectOptions(statusCol.id) : Promise.resolve([]),
    categoryCol ? adapter.getSelectOptions(categoryCol.id) : Promise.resolve([]),
    zuordnungCol ? adapter.getSelectOptions(zuordnungCol.id) : Promise.resolve([]),
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
    }
  }

  await adapter.createRow({ tableId, cells });
}

export async function initializeReceiptsTable() {
  const adapter = getAdapter();
  const tables = await adapter.listTables(WORKSPACE_ID);
  if (tables.find(t => t.name === TABLE_NAME)) return;

  const table = await adapter.createTable({ workspaceId: WORKSPACE_ID, name: TABLE_NAME });

  const COLUMNS: Array<{ name: string; type: string; isPrimary?: boolean }> = [
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

  const CATEGORY_OPTIONS = Object.keys(CATEGORY_TO_KONTO);
  const CATEGORY_COLORS = ['#ef4444','#3b82f6','#f59e0b','#8b5cf6','#06b6d4','#ec4899','#10b981','#f97316','#14b8a6','#6b7280'];
  const STATUS_OPTIONS = ['Pending', 'Processed', 'Rejected'];
  const STATUS_COLORS = ['#f59e0b', '#10b981', '#ef4444'];

  const columnIds: Record<string, string> = {};
  for (const col of COLUMNS) {
    const c = await adapter.createColumn({ tableId: table.id, name: col.name, type: col.type as any, isPrimary: col.isPrimary });
    columnIds[col.name] = c.id;
  }

  for (let i = 0; i < CATEGORY_OPTIONS.length; i++) {
    await adapter.createSelectOption({ columnId: columnIds['Category'], name: CATEGORY_OPTIONS[i], color: CATEGORY_COLORS[i] });
  }
  for (let i = 0; i < STATUS_OPTIONS.length; i++) {
    await adapter.createSelectOption({ columnId: columnIds['Status'], name: STATUS_OPTIONS[i], color: STATUS_COLORS[i] });
  }

  await adapter.createView({ tableId: table.id, name: 'Table', type: 'table', isDefault: true, config: { groupConfig: { columnId: columnIds['Category'], direction: 'asc', hideEmptyGroups: false } } });
  await adapter.createView({ tableId: table.id, name: 'By Konto', type: 'table', config: { groupConfig: { columnId: columnIds['Konto'], direction: 'asc', hideEmptyGroups: false } } });
  await adapter.createView({ tableId: table.id, name: 'Board', type: 'board', config: { boardConfig: { groupByColumnId: columnIds['Status'], showEmptyGroups: true } } });
  await adapter.createView({ tableId: table.id, name: 'Calendar', type: 'calendar', config: { calendarConfig: { dateColumnId: columnIds['Date'] } } });
}
