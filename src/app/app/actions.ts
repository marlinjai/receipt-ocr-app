'use server';

import { D1Adapter } from '@marlinjai/data-table-adapter-d1';
import { getCloudflareContext } from '@opennextjs/cloudflare';
import { extractReceiptFields } from '@/lib/extract-receipt-fields';
import { getAiClient, getClassifyModel } from '@/lib/ai-client';
import { CATEGORY_TO_KONTO, ZUORDNUNG_OPTIONS } from '@/lib/receipts-table';
import type { CellValue } from '@marlinjai/data-table-core';
import type { OcrResult } from '@/lib/ocr-types';

const CATEGORY_NAMES = Object.keys(CATEGORY_TO_KONTO);
const WORKSPACE_ID = 'receipt-ocr';

interface FileData {
  id: string;
  originalName: string;
  fileType?: string;
}

async function getAdapter() {
  const { env } = await getCloudflareContext({ async: true });
  return new D1Adapter(env.DB);
}

async function getTableId(adapter: D1Adapter) {
  const tables = await adapter.listTables(WORKSPACE_ID);
  const table = tables.find(t => t.name === 'Receipts');
  if (!table) throw new Error('Receipts table not found');
  return table.id;
}

async function classifyReceipt(
  extracted: ReturnType<typeof extractReceiptFields>,
  fullText: string,
): Promise<{ aiCategory: string | null; aiKonto: string | null; aiZuordnung: string | null }> {
  try {
    const client = getAiClient();
    const systemPrompt = `You are a receipt classification assistant for German business expense tracking (SKR03).

Given a receipt's OCR text, vendor, and amount, classify it into:
1. **Category** — one of: ${CATEGORY_NAMES.join(', ')}
2. **Konto** — the SKR03 account number (mapped from category):
${CATEGORY_NAMES.map((c) => `   ${c} → ${CATEGORY_TO_KONTO[c]}`).join('\n')}
3. **Zuordnung** (assignment context) — one of: ${ZUORDNUNG_OPTIONS.join(', ')}

Respond with ONLY a JSON object (no markdown, no explanation):
{ "category": "...", "konto": "...", "zuordnung": "...", "confidence": 0.0-1.0, "reasoning": "..." }`;

    const userContent = [
      extracted.vendor && `Vendor: ${extracted.vendor}`,
      extracted.gross && `Amount: €${extracted.gross}`,
      extracted.date && `Date: ${extracted.date}`,
      `\nOCR Text (first 2000 chars):\n${fullText.slice(0, 2000)}`,
    ].filter(Boolean).join('\n');

    const response = await client.chat.completions.create({
      model: getClassifyModel(),
      max_tokens: 256,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userContent },
      ],
    });

    const text = response.choices[0]?.message?.content ?? '';
    const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
    const parsed = JSON.parse(cleaned);

    return {
      aiCategory: CATEGORY_NAMES.includes(parsed.category) ? parsed.category : null,
      aiKonto: parsed.konto || (parsed.category ? CATEGORY_TO_KONTO[parsed.category] : null),
      aiZuordnung: ZUORDNUNG_OPTIONS.includes(parsed.zuordnung) ? parsed.zuordnung : null,
    };
  } catch {
    return { aiCategory: null, aiKonto: null, aiZuordnung: null };
  }
}

async function buildCells(
  adapter: D1Adapter,
  tableId: string,
  file: FileData,
  ocrResult: OcrResult | null,
  extracted: ReturnType<typeof extractReceiptFields> | null,
  aiCategory: string | null,
  aiKonto: string | null,
  aiZuordnung: string | null,
  classificationFailed: boolean,
) {
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
        cells[col.id] = extracted?.name || file.originalName;
        break;
      case 'Vendor':
        cells[col.id] = extracted?.vendor ?? null;
        break;
      case 'Gross':
        cells[col.id] = extracted?.gross ?? null;
        break;
      case 'Net':
        cells[col.id] = extracted?.net ?? null;
        break;
      case 'Tax Rate':
        cells[col.id] = extracted?.taxRate ?? null;
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

  return cells;
}

export async function processReceipt(
  file: FileData,
  ocrResult: OcrResult | null,
) {
  const adapter = await getAdapter();
  const tableId = await getTableId(adapter);
  const extracted = ocrResult ? extractReceiptFields(ocrResult) : null;

  let aiCategory: string | null = null;
  let aiKonto: string | null = null;
  let aiZuordnung: string | null = null;
  let classificationFailed = false;

  if (extracted && ocrResult?.fullText) {
    const ai = await classifyReceipt(extracted, ocrResult.fullText);
    aiCategory = ai.aiCategory;
    aiKonto = ai.aiKonto;
    aiZuordnung = ai.aiZuordnung;
    classificationFailed = !aiCategory && !aiKonto && !aiZuordnung;
  }

  const cells = await buildCells(
    adapter, tableId, file, ocrResult, extracted,
    aiCategory, aiKonto, aiZuordnung, classificationFailed,
  );
  await adapter.createRow({ tableId, cells });
}
