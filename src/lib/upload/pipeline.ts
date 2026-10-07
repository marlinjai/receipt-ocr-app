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

export interface PipelineDeps {
  hash: (file: File) => Promise<string>;
  /** Is a file with this hash already in the workspace? */
  checkDuplicate: (sha256: string) => Promise<ExistingReceiptRef | null>;
  /** Upload the bytes; reports progress 0 to 100. */
  upload: (file: File, onProgress: (percent: number) => void) => Promise<UploadedFileInfo>;
  recognize: (file: UploadedFileInfo) => Promise<OcrResult>;
  save: (
    file: UploadedFileInfo,
    ocr: OcrResult,
    options: { sha256: string },
  ) => Promise<{ rowId: string; possibleDuplicateOf: ExistingReceiptRef | null }>;
}

export type PipelinePhase = 'checking' | 'uploading' | 'ocr' | 'saving';

export type PipelineOutcome =
  /** Exactly this file is already there. NOTHING was uploaded. */
  | { kind: 'duplicate'; existing: ExistingReceiptRef }
  | { kind: 'done'; rowId: string; similar: ExistingReceiptRef | null };

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
  const sha256 = await deps.hash(file);
  if (!options.allowDuplicate) {
    const existing = await deps.checkDuplicate(sha256);
    if (existing) return { kind: 'duplicate', existing };
  }

  options.onPhase?.('uploading');
  const uploaded = await deps.upload(file, options.onProgress ?? (() => {}));

  options.onPhase?.('ocr');
  const ocr = await deps.recognize(uploaded);

  options.onPhase?.('saving');
  const saved = await deps.save(uploaded, ocr, { sha256 });
  return { kind: 'done', rowId: saved.rowId, similar: saved.possibleDuplicateOf };
}
