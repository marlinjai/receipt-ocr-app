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

export interface FileCheck {
  existing: ExistingReceiptRef | null;
  /** Names of the user's other companies that already hold exactly this file. */
  elsewhere: string[];
}

export interface UploadedFileInfo {
  id: string;
  originalName: string;
  fileType?: string;
}

/** No second receipt was kept: the upload is one that is there already (plan 2026-10-29-invoice-number-duplicates). */
export interface AlreadyThereRef extends ExistingReceiptRef {
  reason: 'same_file' | 'same_invoice';
  invoiceNumber: string | null;
  /** True when the arriving file was added to the receipt that is there. */
  fileAdded: boolean;
}

export interface SavedReceipt {
  rowId: string;
  /** Set when the server kept no new receipt because the upload is one that is there already. */
  alreadyThere?: AlreadyThereRef | null;
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
  /**
   * Is a file with this hash already in the workspace the upload is for
   * (`existing`), and which of the user's other companies hold it too
   * (`elsewhere`, their names only)?
   */
  checkDuplicate: (sha256: string) => Promise<FileCheck>;
  /** Upload the bytes; reports progress 0 to 100. */
  upload: (file: File, onProgress: (percent: number) => void) => Promise<UploadedFileInfo>;
  recognize: (file: UploadedFileInfo) => Promise<OcrResult>;
  /** `ocr` is null when text recognition failed: the receipt is saved anyway, for manual entry. */
  save: (file: UploadedFileInfo, ocr: OcrResult | null, options: { sha256: string }) => Promise<SavedReceipt>;
}

export type PipelinePhase = 'checking' | 'uploading' | 'ocr' | 'saving';

export type PipelineOutcome =
  /**
   * The receipt is there already, nothing new was kept: exactly this file (then NOTHING was uploaded,
   * or the stored copy was removed again), or the same invoice of the same vendor (then the file was
   * added to that receipt). Never a question: the same file or invoice is the same receipt.
   */
  | { kind: 'duplicate'; existing: ExistingReceiptRef; reason: 'same_file' | 'same_invoice'; invoiceNumber: string | null; fileAdded: boolean }
  | {
      kind: 'done';
      rowId: string;
      similar: ExistingReceiptRef | null;
      category: string | null;
      isMeal: boolean;
      attention: SavedReceipt['attention'];
      /** Why text recognition failed, when it did. The row exists regardless. */
      ocrError: string | null;
      /**
       * The user's other companies that already hold exactly this file. A
       * warning, not a stop: the same invoice in two companies is usually a
       * mistake, but it was uploaded where the page said, and can be discarded.
       */
      elsewhere: string[];
    };

export interface PipelineOptions {
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
  // Exactly this file in this company: the same receipt, nothing is uploaded (decision 5 of the plan).
  const check = await deps.checkDuplicate(sha256);
  if (check.existing) return { kind: 'duplicate', existing: check.existing, reason: 'same_file', invoiceNumber: null, fileAdded: false };

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
  if (saved.alreadyThere) {
    const { reason, invoiceNumber, fileAdded, rowId, name } = saved.alreadyThere;
    return { kind: 'duplicate', existing: { rowId, name }, reason, invoiceNumber, fileAdded };
  }
  return {
    kind: 'done',
    rowId: saved.rowId,
    similar: saved.possibleDuplicateOf,
    category: saved.category,
    isMeal: saved.isMeal,
    attention: saved.attention,
    ocrError,
    elsewhere: check.elsewhere,
  };
}
