'use server';

import { PrismaAdapter } from '@marlinjai/data-table-adapter-prisma';
import { prisma } from '@/lib/prisma';
import { extractReceiptFields } from '@/lib/extract-receipt-fields';
import { getFxRate } from '@/lib/fx-rates';
import {
  CATEGORY_TO_KONTO,
  ZUORDNUNG_OPTIONS,
  MEAL_CATEGORY,
  MEAL_COLUMNS,
  consumptionLabel,
  mealTypeLabel,
  getDefaultBusinessSharePercent,
} from '@/lib/receipts-constants';
import { defaultTaxRate, mealFactsFromClassification, type MealClassification } from '@/lib/meals/classify';
import { serializeTaxLines } from '@/lib/meals/rules';
import { receiptAttention, type ReceiptAttention } from '@/lib/upload/quality';
import { classifyWithWebSearch } from '@/lib/web-search';
import { ensureReceiptsTable } from '@/lib/receipts-table';
import { findSimilarReceipt, type ExistingReceipt } from '@/lib/upload/duplicates';
import { isSha256Hex } from '@/lib/upload/hash';
import { auth } from '@/lib/auth';
import { requireReceiptsSession } from '@/lib/auth-guards';
import { sessionWorkspaceId } from '@/lib/auth-workspace';
import type { CellValue } from '@marlinjai/data-table-core';
import type { OcrResult } from '@/lib/ocr-types';

const TABLE_NAME = 'Receipts';
const CATEGORY_NAMES = Object.keys(CATEGORY_TO_KONTO);

function getAdapter() {
  return new PrismaAdapter({ prisma });
}

async function getTableId(workspaceId: string) {
  const adapter = getAdapter();
  const tables = await adapter.listTables(workspaceId);
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
  meal: MealClassification | null;
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
      meal: result.meal,
    };
  } catch (err) {
    console.error('[classifyReceipt] Classification failed:', err);
    return { aiName: null, aiCategory: null, aiKonto: null, aiZuordnung: null, aiTaxRate: null, meal: null };
  }
}

export interface ProcessReceiptOptions {
  /** SHA-256 of the uploaded bytes (hex), stored on the file reference for duplicate detection. */
  sha256?: string;
}

export interface ProcessReceiptResult {
  rowId: string;
  /** Another receipt with the same vendor, day and total: a warning, never a block. */
  possibleDuplicateOf: ExistingReceipt | null;
  /** The category the receipt was filed under, by name. */
  category: string | null;
  /** True when it was filed as a business meal: the caller asks for the meal details next. */
  isMeal: boolean;
  /** Set when the receipt was not read well and a retake is worth offering. */
  attention: ReceiptAttention | null;
}

type ReceiptsAdapter = ReturnType<typeof getAdapter>;

/**
 * Columns a (re)read of the receipt fills. Guests, occasion and host are never
 * in here. The five meal columns at the end ARE: the classifier reads them on
 * the first save. On a retake they are only written where the row is still
 * blank (see MEAL_READ_COLUMNS), so nothing the user typed is overwritten.
 */
const OCR_DERIVED_COLUMNS = new Set([
  'Name', 'Vendor', 'Gross', 'Net', 'Tax Rate', 'Date', 'Category', 'Konto', 'Zuordnung', 'Status',
  'Confidence', 'OCR Text', 'Currency', 'FX Rate', 'Business Share %',
  MEAL_COLUMNS.mealType, MEAL_COLUMNS.consumption, MEAL_COLUMNS.tip, MEAL_COLUMNS.taxLines, MEAL_COLUMNS.place,
]);

/** Meal facts the classifier can read but the user may also have typed: a retake fills blanks only. */
const MEAL_READ_COLUMNS: string[] = [
  MEAL_COLUMNS.mealType,
  MEAL_COLUMNS.consumption,
  MEAL_COLUMNS.tip,
  MEAL_COLUMNS.taxLines,
  MEAL_COLUMNS.place,
];

interface ReadReceipt {
  cells: Record<string, CellValue>;
  imageColumnId: string | null;
  category: string | null;
  vendor: string | null;
  date: string | null;
  gross: number | null;
  attention: ReceiptAttention | null;
}

/**
 * Turn a recognized file into the cells of a receipt row: extraction, AI
 * classification, tax and currency defaults. Shared by the first save and by a
 * retake, so both read a receipt identically.
 *
 * `ocrResult` null means text recognition failed: the cells are then mostly
 * empty and the status is Pending, but there IS a row, with the file on it,
 * for manual entry. The receipt is never lost.
 */
async function readReceipt(
  adapter: ReceiptsAdapter,
  tableId: string,
  file: FileData,
  ocrResult: OcrResult | null,
): Promise<ReadReceipt> {
  const extracted = ocrResult ? extractReceiptFields(ocrResult) : null;

  let ai: ClassificationResult | null = null;
  let classificationFailed = false;
  if (extracted && ocrResult?.fullText) {
    ai = await classifyReceipt(extracted, ocrResult.fullText);
    classificationFailed = !ai.aiCategory && !ai.aiKonto && !ai.aiZuordnung;
  }

  const finalCategory = ai?.aiCategory || extracted?.category || null;
  const date = extracted?.date ?? null;
  const meal = finalCategory === MEAL_CATEGORY ? mealFactsFromClassification(ai, ocrResult?.fullText ?? '') : null;

  // Gross, net and tax rate. The receipt's own tax lines win; without them the
  // rate falls back to what was read, then to a default that knows the date
  // (restaurant food: 19 percent until the end of 2025, 7 percent from 2026).
  const finalGross = extracted?.gross ?? null;
  const lineNet = meal?.taxLines ? meal.taxLines.reduce((sum, l) => sum + l.net, 0) : null;
  const finalTaxRate =
    meal?.taxLines?.length === 1
      ? meal.taxLines[0].rate
      : (extracted?.taxRate ?? ai?.aiTaxRate ?? defaultTaxRate(finalCategory, date, meal?.consumption ?? null));
  let finalNet = lineNet !== null ? Math.round(lineNet * 100) / 100 : (extracted?.net ?? null);
  if (finalGross !== null && finalNet === null) {
    finalNet = Math.round((finalGross / (1 + finalTaxRate / 100)) * 100) / 100;
  }

  // Multi-currency: detected currency, historical FX rate (looked up live, on save),
  // and the shared/partial-business-use attribution default for this vendor.
  const currency = extracted?.currency ?? 'EUR';
  const fxRate = currency === 'EUR' ? 1 : await getFxRate(currency, date);
  const businessSharePercent = getDefaultBusinessSharePercent(extracted?.vendor ?? null);

  const columns = await adapter.getColumns(tableId);
  const optionId = async (columnName: string, optionName: string | null | undefined) => {
    if (!optionName) return null;
    const col = columns.find((c) => c.name === columnName);
    if (!col) return null;
    return (await adapter.getSelectOptions(col.id)).find((o) => o.name === optionName)?.id ?? null;
  };

  const statusName = classificationFailed || !ocrResult?.fullText ? 'Pending' : 'Processed';
  const confidence = ocrResult?.confidence ? Math.round(ocrResult.confidence * 100) : 0;

  const values: Record<string, CellValue> = {
    Name: ai?.aiName || extracted?.name || file.originalName,
    Vendor: extracted?.vendor ?? null,
    Gross: finalGross,
    Net: finalNet,
    'Tax Rate': finalTaxRate,
    Date: date,
    Category: await optionId('Category', finalCategory),
    Konto: ai?.aiKonto || extracted?.konto || null,
    Zuordnung: await optionId('Zuordnung', ai?.aiZuordnung),
    Status: (await optionId('Status', statusName)) ?? '',
    Confidence: confidence,
    // 'Receipt Image' is a file column: the uploaded file is attached as a
    // file reference after the row exists, not via a cell value.
    'OCR Text': ocrResult?.fullText ?? '',
    Currency: await optionId('Currency', currency),
    'FX Rate': fxRate,
    'Business Share %': businessSharePercent,
    // 'EUR Equivalent' and 'Attributed EUR' are formula columns, computed
    // automatically on read. 'Project' is left unassigned; it is tagged manually.
  };
  if (meal) {
    // What the classifier could read about the meal. Guests, occasion and host
    // are never guessed: those are asked.
    values[MEAL_COLUMNS.mealType] = await optionId(MEAL_COLUMNS.mealType, meal.mealType ? mealTypeLabel(meal.mealType) : null);
    values[MEAL_COLUMNS.consumption] = await optionId(MEAL_COLUMNS.consumption, meal.consumption ? consumptionLabel(meal.consumption) : null);
    values[MEAL_COLUMNS.tip] = meal.tip;
    values[MEAL_COLUMNS.taxLines] = serializeTaxLines(meal.taxLines);
    values[MEAL_COLUMNS.place] = meal.place ?? '';
  }

  const cells: Record<string, CellValue> = {};
  for (const col of columns) {
    if (col.name in values && OCR_DERIVED_COLUMNS.has(col.name)) cells[col.id] = values[col.name];
  }

  return {
    cells,
    imageColumnId: columns.find((c) => c.name === 'Receipt Image')?.id ?? null,
    category: finalCategory,
    vendor: extracted?.vendor ?? null,
    date,
    gross: finalGross,
    attention: receiptAttention({
      ocrOk: Boolean(ocrResult?.fullText),
      confidence: ocrResult ? confidence : null,
      gross: finalGross,
      date,
    }),
  };
}

function fileMetadata(options: ProcessReceiptOptions) {
  return {
    source: 'ocr-upload',
    // Only a well-formed hash is stored; anything else from the browser is dropped.
    ...(isSha256Hex(options.sha256) ? { sha256: options.sha256 } : {}),
  };
}

async function similarReceipt(workspaceId: string, read: ReadReceipt, rowId: string) {
  // The same receipt photographed twice has a different file hash, so this is
  // the soft check. A failure here must not fail the save that just succeeded.
  try {
    return await findSimilarReceipt(prisma, workspaceId, { vendor: read.vendor, date: read.date, gross: read.gross }, rowId);
  } catch (err) {
    console.error('[processReceipt] similar-receipt check failed:', err);
    return null;
  }
}

export async function processReceipt(
  file: FileData,
  ocrResult: OcrResult | null,
  options: ProcessReceiptOptions = {},
): Promise<ProcessReceiptResult> {
  // Inner check (the middleware is the outer fence): the session must hold
  // receipts.upload on its ACTIVE workspace. The workspace id is resolved
  // server-side from the verified session, never from the browser.
  const session = await auth.requireAction('receipts.upload');
  const workspaceId = sessionWorkspaceId(session);
  const { adapter, tableId } = await getTableId(workspaceId);
  const read = await readReceipt(adapter, tableId, file, ocrResult);

  const row = await adapter.createRow({ tableId, cells: read.cells });

  if (read.imageColumnId && file.id) {
    await adapter.addFileReference({
      rowId: row.id,
      columnId: read.imageColumnId,
      fileId: file.id,
      fileUrl: `/api/files/${file.id}`,
      originalName: file.originalName ?? 'receipt',
      mimeType: file.fileType ?? 'application/octet-stream',
      metadata: fileMetadata(options),
    });
  }

  return {
    rowId: row.id,
    possibleDuplicateOf: await similarReceipt(workspaceId, read, row.id),
    category: read.category,
    isMeal: read.category === MEAL_CATEGORY,
    attention: read.attention,
  };
}

/**
 * Replace the photo of a receipt that was read badly, on the SAME row: the new
 * file takes the place of the uploaded one and the receipt is read again.
 * Never a second row. Meal details already entered on the row are kept.
 */
export async function retakeReceipt(
  rowId: string,
  file: FileData,
  ocrResult: OcrResult | null,
  options: ProcessReceiptOptions = {},
): Promise<ProcessReceiptResult> {
  const session = await auth.requireAction('receipts.upload');
  const workspaceId = sessionWorkspaceId(session);
  const { adapter, tableId } = await getTableId(workspaceId);
  const row = await adapter.getRow(String(rowId));
  // Only a row of the active workspace's own table can be retaken.
  if (!row || row.tableId !== tableId) throw new Error('Receipt not found');

  const read = await readReceipt(adapter, tableId, file, ocrResult);

  // Date, amount, category and the like are re-read: that is what a retake is
  // for. Meal facts the user (or an earlier reading) already filled in stay.
  const columns = await adapter.getColumns(tableId);
  for (const name of MEAL_READ_COLUMNS) {
    const columnId = columns.find((c) => c.name === name)?.id;
    if (!columnId) continue;
    const current = row.cells[columnId];
    if (current !== null && current !== undefined && current !== '') delete read.cells[columnId];
  }
  await adapter.updateRow(row.id, read.cells);

  if (read.imageColumnId && file.id) {
    // Swap the file: drop what the capture uploaded before, keep anything a
    // user attached by hand.
    const existing = await adapter.getFileReferences(row.id, read.imageColumnId);
    for (const ref of existing) {
      if (ref.metadata?.source === 'ocr-upload') await adapter.removeFileReference(ref.id);
    }
    await adapter.addFileReference({
      rowId: row.id,
      columnId: read.imageColumnId,
      fileId: file.id,
      fileUrl: `/api/files/${file.id}`,
      originalName: file.originalName ?? 'receipt',
      mimeType: file.fileType ?? 'application/octet-stream',
      metadata: fileMetadata(options),
    });
  }

  return {
    rowId: row.id,
    possibleDuplicateOf: await similarReceipt(workspaceId, read, row.id),
    category: read.category,
    isMeal: read.category === MEAL_CATEGORY,
    attention: read.attention,
  };
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
  const session = await auth.requireAction('receipts.fx.recompute');
  const { adapter, tableId } = await getTableId(sessionWorkspaceId(session));
  const columns = await adapter.getColumns(tableId);
  const dateCol = columns.find((c) => c.name === 'Date');
  const currencyCol = columns.find((c) => c.name === 'Currency');
  const fxRateCol = columns.find((c) => c.name === 'FX Rate');
  if (!dateCol || !currencyCol || !fxRateCol) {
    throw new Error('Currency/FX Rate columns are missing. Reload the dashboard once to initialize them.');
  }
  const currencyOpts = await adapter.getSelectOptions(currencyCol.id);
  const currencyNameById = new Map(currencyOpts.map((o) => [o.id, o.name]));

  // Date objects, not strings: the Date column is a timestamp in the database
  // and a string bound as text cannot be compared with it. With strings this
  // query failed outright ("timestamp with time zone >= text").
  const from = new Date(`${String(startDate).slice(0, 10)}T00:00:00.000Z`);
  const to = new Date(`${String(endDate).slice(0, 10)}T23:59:59.999Z`);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    throw new Error('Start and end must be dates in the form YYYY-MM-DD.');
  }

  let updated = 0;
  let failed = 0;
  let skippedEur = 0;
  let offset = 0;
  const limit = 100;

  for (;;) {
    const { items, hasMore } = await adapter.getRows(tableId, {
      filters: [
        { columnId: dateCol.id, operator: 'greaterThanOrEquals', value: from },
        { columnId: dateCol.id, operator: 'lessThanOrEquals', value: to },
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

/**
 * Idempotently ensures the Receipts table, all columns, and the standard views
 * exist for the session's ACTIVE workspace (see ensureReceiptsTable).
 */
export async function initializeReceiptsTable() {
  // Per-workspace lazy init: each company workspace gets its own Receipts
  // table on first visit, keyed by the session's ACTIVE workspace UUID.
  const session = await requireReceiptsSession();
  await ensureReceiptsTable(getAdapter(), sessionWorkspaceId(session));
}
