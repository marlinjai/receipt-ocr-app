'use server';

import { TAX_RATES_COLUMN, formatTaxRates, withTaxRates } from '@/lib/tax-rates';
import { PrismaAdapter } from '@marlinjai/data-table-adapter-prisma';
import { prisma } from '@/lib/prisma';
import { extractReceiptFields } from '@/lib/extract-receipt-fields';
import { readAmounts } from '@/lib/extraction/amounts';
import { chooseVendor } from '@/lib/extraction/vendor';
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
import { ClassifierUnavailableError, classifyReceiptText } from '@/lib/receipt-classifier';
import type { ReadFlag } from '@/lib/review/reasons';
import { recordReadFlags } from '@/lib/review/service';
import { ensureReceiptsTable } from '@/lib/receipts-table';
import { findSimilarReceipt, type ExistingReceipt } from '@/lib/upload/duplicates';
import { isSha256Hex } from '@/lib/upload/hash';
import { auth } from '@/lib/auth';
import { requireReceiptsSession } from '@/lib/auth-guards';
import { sessionWorkspaceId, tenantIdForWorkspace } from '@/lib/auth-workspace';
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
  aiVendor: string | null;
  aiGross: number | null;
  meal: MealClassification | null;
}

/** Null when no classification could be had. The caller records that on the receipt: it is never silent. */
async function classifyReceipt(
  extracted: ReturnType<typeof extractReceiptFields>,
  fullText: string,
): Promise<ClassificationResult | null> {
  try {
    const result = await classifyReceiptText({
      vendor: extracted.vendor,
      gross: extracted.gross,
      date: extracted.date,
      fullText,
      categoryNames: CATEGORY_NAMES,
      categoryToKonto: CATEGORY_TO_KONTO,
      zuordnungOptions: ZUORDNUNG_OPTIONS,
    });
    // An answer without a category is no classification (the model's text could not be parsed).
    if (!result.category) {
      console.error('[classifyReceipt] the classifier answered without a usable category', { provider: result.provider });
      return null;
    }
    return {
      aiName: result.name,
      aiCategory: result.category,
      aiKonto: result.konto,
      aiZuordnung: result.zuordnung,
      aiTaxRate: result.taxRate,
      aiVendor: result.vendor,
      aiGross: result.gross,
      meal: result.meal,
    };
  } catch (err) {
    if (err instanceof ClassifierUnavailableError) console.error('[classifyReceipt] no language model is configured: receipts are filed by pattern matching only');
    else console.error('[classifyReceipt] classification failed:', err);
    return null;
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
  /** What the reader could not settle; the same doubts are stored for the review list. */
  reviewFlags: ReadFlag[];
}

type ReceiptsAdapter = ReturnType<typeof getAdapter>;

/**
 * Columns a (re)read of the receipt fills. Guests, occasion and host are never
 * in here. The five meal columns at the end ARE: the classifier reads them on
 * the first save. On a retake they are only written where the row is still
 * blank (see MEAL_READ_COLUMNS), so nothing the user typed is overwritten.
 */
const OCR_DERIVED_COLUMNS = new Set([
  'Name', 'Vendor', 'Gross', 'Net', 'Tax Rate', TAX_RATES_COLUMN, 'Date', 'Category', 'Konto', 'Zuordnung', 'Status',
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
  reviewFlags: ReadFlag[];
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
  const fullText = ocrResult?.fullText ?? '';
  const extracted = ocrResult && fullText.trim() ? extractReceiptFields(ocrResult) : null;
  const ai = extracted ? await classifyReceipt(extracted, fullText) : null;
  const classificationFailed = extracted !== null && ai === null;
  const reviewFlags: ReadFlag[] = [];
  if (classificationFailed) reviewFlags.push('not_classified');

  // Category: the model's answer, else what the text itself shows. A receipt
  // with a table, a waiter and a tip line that the model filed elsewhere is
  // kept as the model said and put up for a look.
  const finalCategory = ai?.aiCategory || extracted?.category || null;
  if (ai && extracted?.mealEvidence.strong && finalCategory !== MEAL_CATEGORY) reviewFlags.push('category_doubt');
  const date = extracted?.date ?? null;
  const vendor = extracted ? chooseVendor({ vendor: extracted.vendor, confidence: extracted.vendorConfidence }, ai?.aiVendor, fullText).vendor : null;
  const meal = finalCategory === MEAL_CATEGORY ? mealFactsFromClassification(ai, fullText, vendor) : null;

  // Amounts: read again with the model's total and tax lines as a second
  // opinion. The receipt's own arithmetic decides; what it cannot confirm is
  // recorded for a look instead of stored as fact.
  const amounts = extracted
    ? readAmounts(fullText, { date, currency: extracted.currency, modelGross: ai?.aiGross ?? null, modelTaxLines: ai?.meal?.taxLines ?? null })
    : null;
  if (amounts?.checks.includes('total_conflict')) reviewFlags.push('total_conflict');
  else if (amounts?.checks.includes('total_unconfirmed')) reviewFlags.push('total_unconfirmed');
  const finalGross = amounts?.gross ?? null;
  const finalTaxRate = amounts?.taxRate ?? ai?.aiTaxRate ?? defaultTaxRate(finalCategory, date, meal?.consumption ?? null);
  let finalNet = amounts?.net ?? null;
  if (finalGross !== null && finalNet === null) {
    finalNet = Math.round((finalGross / (1 + finalTaxRate / 100)) * 100) / 100;
  }
  if (meal) {
    // The printed tax groups and a printed tip, where the model reported none.
    if (!meal.taxLines?.length && amounts && amounts.taxGroups.length > 0) {
      meal.taxLines = amounts.taxGroups.map((g) => ({ rate: g.rate, net: g.net, tax: g.tax }));
    }
    if (amounts?.tip != null) meal.tip = amounts.tip;
  }

  // Multi-currency: detected currency, historical FX rate (looked up live, on save),
  // and the shared/partial-business-use attribution default for this vendor.
  const currency = extracted?.currency ?? 'EUR';
  const fxRate = currency === 'EUR' ? 1 : await getFxRate(currency, date);
  const businessSharePercent = getDefaultBusinessSharePercent(vendor);

  const columns = await adapter.getColumns(tableId);
  const optionId = async (columnName: string, optionName: string | null | undefined) => {
    if (!optionName) return null;
    const col = columns.find((c) => c.name === columnName);
    if (!col) return null;
    return (await adapter.getSelectOptions(col.id)).find((o) => o.name === optionName)?.id ?? null;
  };

  const statusName = classificationFailed || !extracted ? 'Pending' : 'Processed';
  const confidence = ocrResult?.confidence ? Math.round(ocrResult.confidence * 100) : 0;

  const values: Record<string, CellValue> = {
    // A receipt nothing could be read from says so in its name instead of posing as a receipt.
    Name: ai?.aiName || extracted?.name || (extracted ? file.originalName : `Nicht lesbar: ${file.originalName}`),
    Vendor: vendor,
    Gross: finalGross,
    Net: finalNet,
    'Tax Rate': finalTaxRate,
    // Every rate the receipt prints, not only the one that carries most of the bill.
    [TAX_RATES_COLUMN]: formatTaxRates(meal?.taxLines?.length ? meal.taxLines : (amounts?.taxGroups ?? null), finalTaxRate),
    Date: date,
    Category: await optionId('Category', finalCategory),
    Konto: ai?.aiKonto || extracted?.konto || null,
    Zuordnung: await optionId('Zuordnung', ai?.aiZuordnung),
    Status: (await optionId('Status', statusName)) ?? '',
    Confidence: confidence,
    // 'Receipt Image' is a file column: the uploaded file is attached as a
    // file reference after the row exists, not via a cell value.
    'OCR Text': fullText,
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
  } else if (amounts && amounts.taxGroups.length > 0) {
    // Any receipt keeps the tax groups it prints, so the rates text has a
    // stored source and a later write derives the same text again.
    values[MEAL_COLUMNS.taxLines] = serializeTaxLines(amounts.taxGroups.map((g) => ({ rate: g.rate, net: g.net, tax: g.tax })));
  }

  const cells: Record<string, CellValue> = {};
  for (const col of columns) {
    if (col.name in values && OCR_DERIVED_COLUMNS.has(col.name)) cells[col.id] = values[col.name];
  }

  return {
    cells,
    imageColumnId: columns.find((c) => c.name === 'Receipt Image')?.id ?? null,
    category: finalCategory,
    vendor,
    date,
    gross: finalGross,
    attention: receiptAttention({
      ocrOk: extracted !== null,
      confidence: ocrResult ? confidence : null,
      gross: finalGross,
      date,
    }),
    reviewFlags,
  };
}

function fileMetadata(options: ProcessReceiptOptions) {
  return {
    source: 'ocr-upload',
    // Only a well-formed hash is stored; anything else from the browser is dropped.
    ...(isSha256Hex(options.sha256) ? { sha256: options.sha256 } : {}),
  };
}

/**
 * Store what the reader could not settle, for the review list. The receipt is
 * already saved at this point: a failure here is logged and the save stands
 * (the facts that can be seen on the row itself are found on read anyway).
 */
async function storeReviewFlags(workspaceId: string, tenantId: string | null, rowId: string, read: ReadReceipt) {
  try {
    await recordReadFlags(prisma, { workspaceId, tenantId }, rowId, read.reviewFlags);
  } catch (err) {
    console.error('[processReceipt] storing the review flags failed:', err);
  }
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

  await storeReviewFlags(workspaceId, tenantIdForWorkspace(session, workspaceId), row.id, read);

  return {
    rowId: row.id,
    possibleDuplicateOf: await similarReceipt(workspaceId, read, row.id),
    category: read.category,
    isMeal: read.category === MEAL_CATEGORY,
    attention: read.attention,
    reviewFlags: read.reviewFlags,
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
  // The rates text is derived again from what the row holds after this write:
  // tax lines that were kept above must not be contradicted by the new reading's.
  const ratesColumnId = columns.find((c) => c.name === TAX_RATES_COLUMN)?.id;
  if (ratesColumnId) delete read.cells[ratesColumnId];
  await adapter.updateRow(row.id, withTaxRates(columns, read.cells, row.cells) as typeof read.cells);

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

  await storeReviewFlags(workspaceId, tenantIdForWorkspace(session, workspaceId), row.id, read);

  return {
    rowId: row.id,
    possibleDuplicateOf: await similarReceipt(workspaceId, read, row.id),
    category: read.category,
    isMeal: read.category === MEAL_CATEGORY,
    attention: read.attention,
    reviewFlags: read.reviewFlags,
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
  const workspaceId = sessionWorkspaceId(session);
  await ensureReceiptsTable(getAdapter(), workspaceId, { db: prisma, tenantId: tenantIdForWorkspace(session, workspaceId) });
}
