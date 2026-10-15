'use server';

import { TAX_RATES_COLUMN, formatTaxRates, withTaxRates } from '@/lib/tax-rates';
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
import { ReceiptsAuthError } from '@/lib/auth-guards';
import { serializeTaxLines } from '@/lib/meals/rules';
import { receiptAttention, type ReceiptAttention } from '@/lib/upload/quality';
import { ClassifierUnavailableError, classifyReceiptText } from '@/lib/receipt-classifier';
import type { ReceiptPage } from '@/lib/receipt-page';
import { loadReceiptPage } from '@/lib/receipt-page-source';
import { settleReading, type ModelReading } from '@/lib/receipt-reading';
import { fileOpenToWorkspace } from '@/lib/file-access';
import type { ReadFlag } from '@/lib/review/reasons';
import type { RereadResult } from '@/lib/review/reread';
import { recordReadFlags } from '@/lib/review/service';
import { ensureReceiptsTable } from '@/lib/receipts-table';
import { isGroupRow, receiptsOnly } from '@/lib/receipts-kind';
import { findSimilarReceipt, type ExistingReceipt } from '@/lib/upload/duplicates';
import { isSha256Hex } from '@/lib/upload/hash';
import { auth } from '@/lib/auth';
import { requireReceiptsSession } from '@/lib/auth-guards';
import { sessionWorkspaceId, tenantIdForWorkspace } from '@/lib/auth-workspace';
import type { CellValue } from '@marlinjai/data-table-core';
import { sameVendor } from '@/lib/extraction/vendor';
import { ITEM_COLUMN, receiptName } from '@/lib/receipt-name';
import { nameFromCells } from '@/lib/receipt-name-cells';
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

/** Null when no classification could be had. The caller records that on the receipt: it is never silent. */
async function classifyReceipt(
  extracted: ReturnType<typeof extractReceiptFields>,
  fullText: string,
  page: ReceiptPage | null,
): Promise<ModelReading | null> {
  try {
    const result = await classifyReceiptText({
      vendor: extracted.vendor,
      gross: extracted.gross,
      date: extracted.date,
      fullText,
      categoryNames: CATEGORY_NAMES,
      categoryToKonto: CATEGORY_TO_KONTO,
      zuordnungOptions: ZUORDNUNG_OPTIONS,
      page,
    });
    // An answer without a category is no classification (the model's text could not be parsed).
    if (!result.category) {
      console.error('[classifyReceipt] the classifier answered without a usable category', { provider: result.provider });
      return null;
    }
    return result;
  } catch (err) {
    // The message only: an error object of the client library can carry the request, and with it the page.
    if (err instanceof ClassifierUnavailableError) console.error('[classifyReceipt] no language model is configured: receipts are filed by pattern matching only');
    else console.error('[classifyReceipt] classification failed:', err instanceof Error ? `${err.name}: ${err.message}` : 'unknown error');
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
  'Name', 'Vendor', ITEM_COLUMN, 'Gross', 'Net', 'Tax Rate', TAX_RATES_COLUMN, 'Date', 'Category', 'Konto', 'Zuordnung', 'Status',
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

/**
 * Columns that carry a person's decision once they hold a value: a reading of
 * a receipt that is already stored fills them only where they are empty.
 */
const DECISION_COLUMNS: string[] = ['Category', 'Konto', 'Zuordnung'];

/** What was bought is worded by the model and may be reworded by a person: a new reading fills it only where it is empty. */
const WORDED_COLUMNS: string[] = [ITEM_COLUMN];

/**
 * True when a new reading keeps the vendor the row holds. A vendor that is set
 * stays: the name a customer uses ("A2 Hosting") is what groups a vendor's
 * receipts, and the page prints the legal name ("A2 Hosting LLC"). Only on a
 * restaurant's till receipt, which prints the restaurant's own name at the
 * top, is a vendor that is really another name replaced: there the stored one
 * can be a heading the old reader took ("Laufkunde"). The review list follows
 * the same rule (src/lib/review/reading.ts).
 */
function storedVendorStands(stored: CellValue | undefined, read: CellValue | undefined, isMeal: boolean): boolean {
  if (typeof stored !== 'string' || stored.trim() === '') return false;
  return !isMeal || (typeof read === 'string' && sameVendor(stored, read));
}

/** What a new reading of a stored file always writes: the facts the page prints. The vendor follows `storedVendorStands`. */
const REREAD_COLUMNS: string[] = ['Vendor', 'Gross', 'Net', 'Tax Rate', 'Date', 'Currency', 'FX Rate'];

const isBlank = (value: unknown) => value === null || value === undefined || value === '';

/**
 * A file id comes from the browser. It must be a fresh upload or belong to
 * this workspace before its bytes are fetched and shown to a model, or
 * attached to a row here.
 */
async function requireOwnFile(fileId: string | undefined, workspaceId: string) {
  if (fileId && !(await fileOpenToWorkspace(fileId, workspaceId))) throw new Error('File not found');
}

interface ReadReceipt {
  cells: Record<string, CellValue>;
  imageColumnId: string | null;
  category: string | null;
  vendor: string | null;
  date: string | null;
  gross: number | null;
  attention: ReceiptAttention | null;
  reviewFlags: ReadFlag[];
  /** The id of the option "Bewirtung" in the category column, to tell whether a stored row is a meal. */
  mealCategoryOptionId: string | null;
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
  // The model is given the page itself where the stored file can be fetched and
  // is within the limits. Without recognized text nothing could check its
  // answer, so it is not asked at all.
  const page = extracted && file.id ? ((await loadReceiptPage(file.id)).page ?? null) : null;
  const ai = extracted ? await classifyReceipt(extracted, fullText, page) : null;
  const classificationFailed = extracted !== null && ai === null;
  // The two readings, settled: what the text proves stands, what the model
  // read from the page is taken only where the text prints it.
  const settled = extracted ? settleReading(fullText, extracted, ai) : null;
  const reviewFlags: ReadFlag[] = settled?.flags ?? [];
  const finalCategory = settled?.category ?? null;
  const date = settled?.date ?? null;
  const vendor = settled?.vendor ?? null;
  const meal = settled?.meal ?? null;
  const amounts = settled?.amounts ?? null;
  const finalGross = settled?.gross ?? null;
  const finalTaxRate = settled?.taxRate ?? 19;
  const finalNet = settled?.net ?? null;
  // A meal is named by its restaurant; what was eaten belongs to the meal register.
  const item = finalCategory === MEAL_CATEGORY ? null : (ai?.item ?? null);

  // Multi-currency: detected currency, historical FX rate (looked up live, on save),
  // and the shared/partial-business-use attribution default for this vendor.
  const currency = settled?.currency ?? 'EUR';
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
    // Vendor, total and date as they were settled, with what was bought in a few words: never the
    // list of line items, never a name a model wrote.
    Name: receiptName({ vendor, item, gross: finalGross, currency, date }) || (extracted ? file.originalName : `Nicht lesbar: ${file.originalName}`),
    Vendor: vendor,
    [ITEM_COLUMN]: item,
    Gross: finalGross,
    Net: finalNet,
    'Tax Rate': finalTaxRate,
    // Every rate the receipt prints, not only the one that carries most of the bill.
    [TAX_RATES_COLUMN]: formatTaxRates(meal?.taxLines?.length ? meal.taxLines : (amounts?.taxGroups ?? null), finalTaxRate),
    Date: date,
    Category: await optionId('Category', finalCategory),
    Konto: ai?.konto || extracted?.konto || null,
    Zuordnung: await optionId('Zuordnung', ai?.zuordnung),
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
    mealCategoryOptionId: await optionId('Category', MEAL_CATEGORY),
  };
}

type NamedColumns = Array<{ id: string; name: string }>;

/** Drop from a reading the named columns the row already holds a value in. */
function keepWhereFilled(cells: Record<string, CellValue>, row: { cells: Record<string, CellValue> }, columns: NamedColumns, names: string[]) {
  for (const name of names) {
    const columnId = columns.find((c) => c.name === name)?.id;
    if (columnId && !isBlank(row.cells[columnId])) delete cells[columnId];
  }
}

/**
 * The business share is a default that follows the vendor until a person
 * changes it. A share that is not the default of the vendor the row holds was
 * set by hand and stays; one that still is follows the vendor read now.
 */
function keepChangedShare(cells: Record<string, CellValue>, row: { cells: Record<string, CellValue> }, columns: NamedColumns) {
  const shareId = columns.find((c) => c.name === 'Business Share %')?.id;
  if (!shareId || isBlank(row.cells[shareId])) return;
  const vendorId = columns.find((c) => c.name === 'Vendor')?.id;
  const storedVendor = vendorId && typeof row.cells[vendorId] === 'string' ? (row.cells[vendorId] as string) : null;
  if (Number(row.cells[shareId]) !== getDefaultBusinessSharePercent(storedVendor)) delete cells[shareId];
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
  await requireOwnFile(file.id, workspaceId);
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
 * Never a second row. Meal details already entered on the row are kept, and so
 * is what a person decided about it: an assignment that is set, and a business
 * share that is no longer the default of the vendor read before.
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
  const columns = await adapter.getColumns(tableId);
  // A group is a container, never a receipt: nothing is read into it.
  if (isGroupRow(row, columns)) throw new Error('Receipt not found');
  await requireOwnFile(file.id, workspaceId);

  const read = await readReceipt(adapter, tableId, file, ocrResult);

  // Date, amount, category and the like are re-read: that is what a retake is
  // for. Meal facts the user (or an earlier reading) already filled in stay,
  // and so does an assignment: the first reading leaves it empty unless the
  // document itself shows it, so a value there is an answer somebody gave.
  keepWhereFilled(read.cells, row, columns, [...MEAL_READ_COLUMNS, ...WORDED_COLUMNS, 'Zuordnung']);
  keepChangedShare(read.cells, row, columns);
  // The rates text is derived again from what the row holds after this write:
  // tax lines that were kept above must not be contradicted by the new reading's.
  const ratesColumnId = columns.find((c) => c.name === TAX_RATES_COLUMN)?.id;
  if (ratesColumnId) delete read.cells[ratesColumnId];
  // The name says what the row holds after this write: an item that was kept stays in it.
  const retakenNameId = columns.find((c) => c.name === 'Name')?.id;
  if (retakenNameId && retakenNameId in read.cells) {
    read.cells[retakenNameId] = (await nameFromCells(adapter, columns, { ...row.cells, ...read.cells })) || read.cells[retakenNameId];
  }
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

/** A name the reader built from the total it read then: it states that amount, in either notation. */
function nameStatesAmount(name: string, gross: number): boolean {
  const fixed = gross.toFixed(2);
  return name.includes(fixed) || name.includes(fixed.replace('.', ','));
}

/**
 * "Seite neu lesen": read a receipt that is already stored again, from the
 * file and the recognized text it holds, with the model that sees the page.
 *
 * It writes what the page prints (vendor, date, amounts, currency and its
 * exchange rate). Category, account, assignment and the meal facts are
 * filled only where they are empty. The business share, the project and
 * everything a person entered in the meal or tax screens stay untouched; tax
 * decisions live in the tax module's own tables and are not reached from
 * here. The name is replaced only where the reader built it: it is empty,
 * still the file name, or states the total that is now read differently.
 * The status moves on only from "Pending".
 *
 * A reading without the page is not what was asked for: when the model does
 * not answer, or cannot be given the page, nothing is written and the row
 * stays exactly as it is.
 *
 * Failures are RETURNED with a stable code, not thrown: a thrown
 * server-action error reaches the browser with its message stripped.
 */
export async function rereadReceipt(rowId: string): Promise<RereadResult> {
  try {
    if (typeof rowId !== 'string' || !rowId) return { ok: false, error: 'not_found' };
    const session = await auth.requireAction('receipts.row.write');
    const workspaceId = sessionWorkspaceId(session);
    const { adapter, tableId } = await getTableId(workspaceId);
    const row = await adapter.getRow(rowId);
    if (!row || row.tableId !== tableId) return { ok: false, error: 'not_found' };
    const columns = await adapter.getColumns(tableId);
    // A group is a container, never a receipt: nothing is read into it.
    if (isGroupRow(row, columns)) return { ok: false, error: 'not_found' };
    const columnId = (name: string) => columns.find((c) => c.name === name)?.id;
    const cell = (name: string): CellValue => {
      const id = columnId(name);
      return id ? row.cells[id] : null;
    };

    const imageColumnId = columnId('Receipt Image');
    const files = imageColumnId ? await adapter.getFileReferences(row.id, imageColumnId) : [];
    // The file the capture uploaded, else the first one a person attached.
    const stored = files.find((f) => f.metadata?.source === 'ocr-upload') ?? files[0];
    if (!stored) return { ok: false, error: 'no_file' };
    const fullText = typeof cell('OCR Text') === 'string' ? (cell('OCR Text') as string) : '';
    if (!fullText.trim()) return { ok: false, error: 'no_text' };

    const confidence = Number(cell('Confidence'));
    const read = await readReceipt(
      adapter,
      tableId,
      { id: stored.fileId, originalName: stored.originalName, fileType: stored.mimeType },
      { fullText, blocks: [], confidence: Number.isFinite(confidence) ? confidence / 100 : 0 },
    );

    if (read.reviewFlags.includes('not_classified')) return { ok: false, error: 'model_unavailable' };
    if (read.reviewFlags.includes('page_not_read')) return { ok: false, error: 'page_unavailable' };

    const storedName = typeof cell('Name') === 'string' ? (cell('Name') as string).trim() : '';
    const storedGross = Number(cell('Gross'));
    const builtByReader =
      !storedName ||
      storedName === stored.originalName ||
      storedName.startsWith('Nicht lesbar: ') ||
      // A name that states the stored total was put together from the cells: it follows the new reading.
      (!isBlank(cell('Gross')) && Number.isFinite(storedGross) && nameStatesAmount(storedName, storedGross));
    // Tax lines a person may have typed belong to the meal register; on any
    // other receipt they are the printed tax groups and follow the reading.
    const isMeal = (() => {
      const categoryId = columnId('Category');
      const optionId = categoryId ? row.cells[categoryId] : null;
      return typeof optionId === 'string' && optionId !== '' && read.mealCategoryOptionId === optionId;
    })();
    const fillOnly = new Set([...DECISION_COLUMNS, ...WORDED_COLUMNS, ...MEAL_READ_COLUMNS.filter((name) => isMeal || name !== MEAL_COLUMNS.taxLines)]);
    // A receipt that waited as "Pending" because it could not be classified is read now; any other status is somebody's.
    const statusId = columnId('Status');
    const pendingId = statusId ? (await adapter.getSelectOptions(statusId)).find((o) => o.name === 'Pending')?.id : undefined;
    const waiting = statusId !== undefined && (isBlank(row.cells[statusId]) || row.cells[statusId] === pendingId);
    const always = new Set([...REREAD_COLUMNS, ...(builtByReader ? ['Name'] : []), ...(waiting ? ['Status'] : [])]);
    const cells: Record<string, CellValue> = {};
    for (const column of columns) {
      if (!(column.id in read.cells)) continue;
      // A vendor that is set keeps its name (see storedVendorStands).
      if (column.name === 'Vendor' && storedVendorStands(row.cells[column.id], read.cells[column.id], isMeal)) continue;
      // A row filed as a meal is named by its restaurant, whatever this reading takes it for.
      if (column.name === ITEM_COLUMN && isMeal) continue;
      if (always.has(column.name) || (fillOnly.has(column.name) && isBlank(row.cells[column.id]))) cells[column.id] = read.cells[column.id];
    }
    // The name says what the row holds after this write: a vendor or an item that was kept stays in it.
    const nameId = columnId('Name');
    if (nameId && nameId in cells) cells[nameId] = (await nameFromCells(adapter, columns, { ...row.cells, ...cells })) || cells[nameId];
    // The printed tax groups of the new reading, or none: lines of the old
    // reading must not stand next to amounts they no longer belong to.
    const linesId = columnId(MEAL_COLUMNS.taxLines);
    if (linesId && !isMeal) cells[linesId] = read.cells[linesId] ?? serializeTaxLines(null);
    // The rates text is derived from what the row holds after this write.
    await adapter.updateRow(row.id, withTaxRates(columns, cells, row.cells) as typeof cells);
    await storeReviewFlags(workspaceId, tenantIdForWorkspace(session, workspaceId), row.id, read);
    return { ok: true, reviewFlags: read.reviewFlags };
  } catch (e) {
    const status = e instanceof ReceiptsAuthError ? e.status : (e as { status?: number })?.status;
    if (status === 401) return { ok: false, error: 'unauthorized' };
    if (status === 403) return { ok: false, error: 'forbidden' };
    if (status === 404) return { ok: false, error: 'not_found' };
    console.error('[rereadReceipt] failed:', e instanceof Error ? `${e.name}: ${e.message}` : 'unknown error');
    return { ok: false, error: 'failed' };
  }
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

    // Receipts only: a group has no currency and no amount to convert.
    for (const row of receiptsOnly(items, columns)) {
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
