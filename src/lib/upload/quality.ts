/**
 * Was a receipt read well enough to trust, or should the user be offered a
 * retake? Pure, so the capture screen and the server agree on the rule.
 */

export type ReceiptAttention =
  /** Text recognition failed outright; the row exists with empty fields. */
  | 'ocr_failed'
  /** Read, but poorly: low confidence, or no total, or no date. Likely a blurry photo. */
  | 'low_quality';

/** Below this recognition confidence (0 to 100) a photo is treated as blurry. */
export const LOW_CONFIDENCE_THRESHOLD = 60;

export function receiptAttention(input: {
  ocrOk: boolean;
  /** 0 to 100. */
  confidence: number | null;
  gross: number | null;
  date: string | null;
}): ReceiptAttention | null {
  if (!input.ocrOk) return 'ocr_failed';
  if (input.confidence !== null && input.confidence < LOW_CONFIDENCE_THRESHOLD) return 'low_quality';
  if (input.gross === null || !input.date) return 'low_quality';
  return null;
}
