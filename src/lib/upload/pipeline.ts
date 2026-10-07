import type { OcrResult } from '@/lib/ocr-types';

/**
 * The upload pipeline for ONE file, with every network step injected: hash,
 * duplicate check, upload, text recognition, save. The uploader component runs
 * it with the real endpoints; tests run it with fakes.
 */

export interface ExistingReceiptRef {
  rowId: string;
  name: string;
}

export interface UploadedFileInfo {
  id: string;
  originalName: string;
  fileType?: string;
}

export interface SavedReceipt {
  rowId: string;
  possibleDuplicateOf: ExistingReceiptRef | null;
  /** Category name the receipt was filed under. */
  category: string | null;
  /** Filed as a business meal: the meal details are asked next. */
  isMeal: boolean;
  /** The receipt was not read well; a retake is worth offering. */
  attention: 'ocr_failed' | 'low_quality' | null;
}

export interface PipelineDeps {
  /** Scale and convert a photo for upload; other files pass through. */
  prepare: (file: File) => Promise<File>;
  hash: (file: File) => Promise<string>;
  /** Is a file with this hash already in the workspace? */
  checkDuplicate: (sha256: string) => Promise<ExistingReceiptRef | null>;
  /** Upload the bytes; reports progress 0 to 100. */
  upload: (file: File, onProgress: (percent: number) => void) => Promise<UploadedFileInfo>;
  recognize: (file: UploadedFileInfo) => Promise<OcrResult>;
  /** `ocr` is null when text recognition failed: the receipt is saved anyway, for manual entry. */
  save: (file: UploadedFileInfo, ocr: OcrResult | null, options: { sha256: string }) => Promise<SavedReceipt>;
}

export type PipelinePhase = 'checking' | 'uploading' | 'ocr' | 'saving';

export type PipelineOutcome =
  /** Exactly this file is already there. NOTHING was uploaded. */
  | { kind: 'duplicate'; existing: ExistingReceiptRef }
  | {
      kind: 'done';
      rowId: string;
      similar: ExistingReceiptRef | null;
      category: string | null;
      isMeal: boolean;
      attention: SavedReceipt['attention'];
      /** Why text recognition failed, when it did. The row exists regardless. */
      ocrError: string | null;
    };

export interface PipelineOptions {
  /** The user chose "upload anyway" for a known duplicate. */
  allowDuplicate?: boolean;
  onPhase?: (phase: PipelinePhase) => void;
  onProgress?: (percent: number) => void;
}

export async function runUploadPipeline(
  file: File,
  deps: PipelineDeps,
  options: PipelineOptions = {},
): Promise<PipelineOutcome> {
  options.onPhase?.('checking');
  const prepared = await deps.prepare(file);
  const sha256 = await deps.hash(prepared);
  if (!options.allowDuplicate) {
    const existing = await deps.checkDuplicate(sha256);
    if (existing) return { kind: 'duplicate', existing };
  }

  options.onPhase?.('uploading');
  const uploaded = await deps.upload(prepared, options.onProgress ?? (() => {}));

  // From here on the file is stored. A failing text recognition must not
  // orphan it: the receipt is saved without text, flagged, and can be retaken
  // or filled in by hand.
  options.onPhase?.('ocr');
  let ocr: OcrResult | null = null;
  let ocrError: string | null = null;
  try {
    ocr = await deps.recognize(uploaded);
  } catch (err) {
    ocrError = err instanceof Error ? err.message : 'Text recognition failed';
  }

  options.onPhase?.('saving');
  const saved = await deps.save(uploaded, ocr, { sha256 });
  return {
    kind: 'done',
    rowId: saved.rowId,
    similar: saved.possibleDuplicateOf,
    category: saved.category,
    isMeal: saved.isMeal,
    attention: saved.attention,
    ocrError,
  };
}
