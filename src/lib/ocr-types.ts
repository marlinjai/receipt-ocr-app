/**
 * OCR block with bounding box — matches what our extraction logic needs.
 * Adapted from Google Cloud Vision textAnnotations format.
 */
export interface OcrBlock {
  text: string;
  boundingBox: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  confidence: number;
}

/**
 * OCR result — the common format our extraction pipeline works with.
 * The /api/ocr route converts Google Vision responses into this shape.
 */
export interface OcrResult {
  fullText: string;
  blocks: OcrBlock[];
  confidence: number;
}
