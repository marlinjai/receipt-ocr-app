'use server';

import { PrismaAdapter } from '@marlinjai/data-table-adapter-prisma';
import { prisma } from '@/lib/prisma';
import { extractReceiptFields } from '@/lib/extract-receipt-fields';
import { getFxRate } from '@/lib/fx-rates';
import {
  CATEGORY_TO_KONTO,
  ZUORDNUNG_OPTIONS,
  getDefaultBusinessSharePercent,
} from '@/lib/receipts-constants';
import { classifyWithWebSearch } from '@/lib/web-search';
import { ensureReceiptsTable } from '@/lib/receipts-table';
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
  // Inner check (the middleware is the outer fence): the session must hold
  // receipts.upload on its ACTIVE workspace. The workspace id is resolved
  // server-side from the verified session, never from the browser.
  const session = await auth.requireAction('receipts.upload');
  const { adapter, tableId } = await getTableId(sessionWorkspaceId(session));
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
      // 'Receipt Image' is a file column: the uploaded file is attached as a
      // file reference after the row exists (below), not via a cell value.
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

  const row = await adapter.createRow({ tableId, cells });

  const imageCol = columns.find((c) => c.name === 'Receipt Image');
  if (imageCol && file.id) {
    await adapter.addFileReference({
      rowId: row.id,
      columnId: imageCol.id,
      fileId: file.id,
      fileUrl: `/api/files/${file.id}`,
      originalName: file.originalName ?? 'receipt',
      mimeType: file.fileType ?? 'application/octet-stream',
      metadata: { source: 'ocr-upload' },
    });
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
