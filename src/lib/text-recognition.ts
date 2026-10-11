import type { OcrBlock, OcrResult } from '@/lib/ocr-types';

/**
 * Text recognition with Google Cloud Vision: the bytes of an image or a PDF
 * in, the common OcrResult out. Used by the /api/ocr route and by the
 * evaluation script, so both recognize a document the same way.
 */

/** The pages of a PDF that are recognized (the synchronous endpoint takes five). */
export const RECOGNIZED_PDF_PAGES = [1, 2, 3, 4, 5];

interface VisionTextAnnotation {
  description: string;
  boundingPoly?: {
    vertices: Array<{ x?: number; y?: number }>;
  };
  confidence?: number;
}

interface VisionPageResponse {
  textAnnotations?: VisionTextAnnotation[];
  fullTextAnnotation?: {
    text: string;
    pages?: Array<{ confidence?: number }>;
  };
  error?: { message: string };
}

/** The recognition service answered with an error status. */
export class TextRecognitionError extends Error {
  readonly status: number;
  readonly details: string;
  constructor(status: number, details: string) {
    super(`Vision API request failed (${status})`);
    this.name = 'TextRecognitionError';
    this.status = status;
    this.details = details;
  }
}

function blocksOf(page: VisionPageResponse, pageConfidence: number): OcrBlock[] {
  // Skip the first annotation (it is the full text), the rest are individual words.
  return (page.textAnnotations?.slice(1) ?? []).map((a) => {
    const vertices = a.boundingPoly?.vertices ?? [];
    const xs = vertices.map((v) => v.x ?? 0);
    const ys = vertices.map((v) => v.y ?? 0);
    const minX = Math.min(...xs);
    const minY = Math.min(...ys);
    return {
      text: a.description,
      boundingBox: { x: minX, y: minY, width: Math.max(...xs) - minX, height: Math.max(...ys) - minY },
      confidence: a.confidence ?? pageConfidence,
    };
  });
}

async function annotate(endpoint: 'images' | 'files', apiKey: string, request: unknown): Promise<unknown> {
  const response = await fetch(`https://vision.googleapis.com/v1/${endpoint}:annotate?key=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ requests: [request] }),
  });
  if (!response.ok) throw new TextRecognitionError(response.status, await response.text());
  return response.json();
}

/** Recognize the text of one image or PDF, given as base64. */
export async function recognizeText(base64Content: string, isPdf: boolean, apiKey: string): Promise<OcrResult> {
  if (!isPdf) {
    const data = (await annotate('images', apiKey, {
      image: { content: base64Content },
      features: [{ type: 'DOCUMENT_TEXT_DETECTION' }],
    })) as { responses: VisionPageResponse[] };
    const page = data.responses[0];
    if (page.error) throw new Error(`Vision API error: ${page.error.message}`);
    const confidence = page.fullTextAnnotation?.pages?.[0]?.confidence ?? 0;
    return { fullText: page.fullTextAnnotation?.text ?? '', blocks: blocksOf(page, confidence), confidence };
  }

  // files:annotate returns { responses: [{ responses: [per page] }] }.
  const data = (await annotate('files', apiKey, {
    inputConfig: { content: base64Content, mimeType: 'application/pdf' },
    features: [{ type: 'DOCUMENT_TEXT_DETECTION' }],
    pages: RECOGNIZED_PDF_PAGES,
  })) as { responses?: Array<{ responses?: VisionPageResponse[] }> };
  const texts: string[] = [];
  const blocks: OcrBlock[] = [];
  let confidenceSum = 0;
  let pageCount = 0;
  for (const page of data.responses?.[0]?.responses ?? []) {
    const fullText = page.fullTextAnnotation?.text ?? '';
    const pageConfidence = page.fullTextAnnotation?.pages?.[0]?.confidence ?? 0;
    if (fullText) {
      texts.push(fullText);
      confidenceSum += pageConfidence;
      pageCount++;
    }
    blocks.push(...blocksOf(page, pageConfidence));
  }
  return { fullText: texts.join('\n'), blocks, confidence: pageCount > 0 ? confidenceSum / pageCount : 0 };
}
