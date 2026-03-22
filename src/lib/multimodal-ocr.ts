import { getAiClient, getClassifyModel } from '@/lib/ai-client';
import { CATEGORY_TO_KONTO, CATEGORY_OPTIONS } from '@/lib/receipts-table';
import type { ExtractionResult } from '@/lib/extract-receipt-fields';
import type { OcrResult } from '@/lib/ocr-types';

/**
 * Multimodal OCR — single-call alternative to the two-step pipeline.
 *
 * Instead of:  Google Vision OCR -> regex extraction -> OpenRouter classification
 * This does:   OpenRouter multimodal LLM (image -> structured JSON) in one call
 *
 * Gated behind the USE_MULTIMODAL_OCR env var. Does NOT replace the existing pipeline.
 */

const MULTIMODAL_MODEL = 'anthropic/claude-sonnet-4-20250514';

function getMultimodalModel(): string {
  return process.env.AI_MULTIMODAL_MODEL || getClassifyModel() || MULTIMODAL_MODEL;
}

/**
 * Combined result from the multimodal pipeline: the extraction fields plus
 * an OcrResult-compatible object so callers can use it interchangeably.
 */
export interface MultimodalOcrResponse {
  ocrResult: OcrResult;
  extraction: ExtractionResult;
}

/**
 * Send a receipt image directly to a multimodal LLM via OpenRouter and get
 * back structured extraction data in a single API call.
 *
 * @param base64Content - Base64-encoded image data (no data URL prefix)
 * @param mimeType - MIME type of the image (e.g. "image/jpeg", "image/png")
 * @returns Combined OCR result and extraction fields
 */
export async function multimodalOcr(
  base64Content: string,
  mimeType: string,
): Promise<MultimodalOcrResponse> {
  const client = getAiClient();
  const model = getMultimodalModel();

  const categoryList = CATEGORY_OPTIONS.join(', ');
  const kontoMapping = CATEGORY_OPTIONS
    .map((c) => `  ${c} -> ${CATEGORY_TO_KONTO[c]}`)
    .join('\n');

  const systemPrompt = `You are a receipt/invoice OCR and data extraction system for German business expense tracking (SKR03).

Analyze the provided receipt image and extract ALL text you can read, then parse it into structured fields.

Return a JSON object with these exact fields:
{
  "fullText": "the complete OCR text you read from the image, preserving line breaks",
  "confidence": 0.0-1.0,
  "name": "descriptive summary: Vendor - Items - Amount - Date",
  "vendor": "business/store name or null",
  "gross": 0.00 or null,
  "net": 0.00 or null,
  "taxRate": 19 or null,
  "date": "ISO 8601 date string or null",
  "category": "one of the categories below, or null",
  "konto": "SKR03 account number or null"
}

Categories (with SKR03 Konto):
${kontoMapping}

Rules:
- "gross" is the total including tax
- "net" is the amount before tax
- "taxRate" is a percentage (e.g. 19 for 19%, 7 for 7%)
- "date" must be ISO 8601 format (e.g. "2024-03-15T00:00:00.000Z")
- "category" must be exactly one of: ${categoryList}
- "konto" must match the category mapping above
- "name" should be a human-readable summary: "Vendor - Top items - Amount - Date"
- "fullText" should contain ALL readable text from the receipt
- "confidence" reflects how confident you are in the OCR quality (0.0-1.0)
- If you cannot determine a field, use null
- Respond with ONLY the JSON object, no markdown fences, no explanation`;

  const response = await client.chat.completions.create({
    model,
    max_tokens: 2048,
    messages: [
      { role: 'system', content: systemPrompt },
      {
        role: 'user',
        content: [
          {
            type: 'image_url',
            image_url: {
              url: `data:${mimeType};base64,${base64Content}`,
            },
          },
          {
            type: 'text',
            text: 'Extract all text and structured data from this receipt/invoice image.',
          },
        ],
      },
    ],
  });

  const text = response.choices[0]?.message?.content ?? '';
  // Strip markdown fences if the model wraps the JSON
  const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  const parsed = JSON.parse(cleaned);

  // Validate and normalize the parsed response
  const category = CATEGORY_OPTIONS.includes(parsed.category) ? parsed.category : null;
  const konto = category ? CATEGORY_TO_KONTO[category] ?? null : null;

  const extraction: ExtractionResult = {
    name: typeof parsed.name === 'string' && parsed.name ? parsed.name : 'Receipt',
    vendor: typeof parsed.vendor === 'string' ? parsed.vendor : null,
    gross: typeof parsed.gross === 'number' ? parsed.gross : null,
    net: typeof parsed.net === 'number' ? parsed.net : null,
    taxRate: typeof parsed.taxRate === 'number' ? parsed.taxRate : null,
    date: typeof parsed.date === 'string' ? parsed.date : null,
    category,
    konto,
  };

  const ocrResult: OcrResult = {
    fullText: typeof parsed.fullText === 'string' ? parsed.fullText : '',
    blocks: [], // Multimodal LLM does not provide bounding boxes
    confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0.5,
  };

  return { ocrResult, extraction };
}
