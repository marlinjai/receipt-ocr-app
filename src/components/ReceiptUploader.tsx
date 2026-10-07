'use client';

import { useState, useCallback, useEffect, useRef } from 'react';
import type { FileInfo } from '@/lib/storage';
import type { OcrResult } from '@/lib/ocr-types';
import { createBrowserDeps } from '@/lib/upload/browser-deps';
import { runUploadPipeline, type ExistingReceiptRef, type SavedReceipt } from '@/lib/upload/pipeline';
import { SplitPdfError, splitPdfMessage, splitPdfPages } from '@/lib/upload/split-pdf';

export interface UploadResult {
  file: FileInfo;
  ocrResult: OcrResult | null;
}

export interface BatchStats {
  total: number;
  succeeded: number;
  failed: number;
}

export type ProcessedReceipt = SavedReceipt;

interface ReceiptUploaderProps {
  /** Save one recognized file as a receipt row. Receives the file's content hash. */
  onProcessFile: (result: UploadResult, options: { sha256: string }) => Promise<ProcessedReceipt>;
  onAllComplete: (stats: BatchStats) => void;
  /** Delete a row that was just created (the user discarded a look-alike receipt). */
  onDiscardRow: (rowId: string) => Promise<void>;
}

type ItemPhase = 'pending' | 'checking' | 'uploading' | 'ocr' | 'saving' | 'done' | 'duplicate' | 'error';

interface QueueItem {
  id: string;
  fileName: string;
  phase: ItemPhase;
  progress: number;
  error?: string;
  /** phase 'duplicate': the receipt that already holds exactly this file. */
  existing?: ExistingReceiptRef;
  /** phase 'done': a look-alike receipt (same vendor, day, total) awaiting the user's call. */
  similar?: ExistingReceiptRef;
  rowId?: string;
  /** phase 'done', but the text could not be read: saved for manual entry. */
  notice?: string;
  /** Set once the user dealt with `existing` or `similar`. */
  resolution?: 'skipped' | 'kept' | 'discarded';
  busy?: boolean;
}

let nextId = 0;

const phaseLabels: Record<ItemPhase, string> = {
  pending: 'Waiting',
  checking: 'Checking',
  uploading: 'Uploading',
  ocr: 'OCR',
  saving: 'Saving',
  done: 'Done',
  duplicate: 'Already uploaded',
  error: 'Failed',
};

const ACTIVE_PHASES: ItemPhase[] = ['pending', 'checking', 'uploading', 'ocr', 'saving'];

/** An item still waits for a decision by the user. */
function needsAttention(item: QueueItem): boolean {
  if (item.resolution) return false;
  return item.phase === 'duplicate' || (item.phase === 'done' && Boolean(item.similar));
}

export default function ReceiptUploader({ onProcessFile, onAllComplete, onDiscardRow }: ReceiptUploaderProps) {
  const [isDragging, setIsDragging] = useState(false);
  const [queue, setQueue] = useState<QueueItem[]>([]);
  // "One receipt per page": a multi-page scan becomes one upload per page.
  const [splitPages, setSplitPages] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const pendingRef = useRef<{ id: string; file: File; allowDuplicate?: boolean }[]>([]);
  // Files of items that stopped as duplicates, kept for "upload anyway".
  const heldFilesRef = useRef(new Map<string, File>());
  const processingRef = useRef(false);
  const callbackRefs = useRef({ onProcessFile, onAllComplete, onDiscardRow });
  useEffect(() => {
    callbackRefs.current = { onProcessFile, onAllComplete, onDiscardRow };
  }, [onProcessFile, onAllComplete, onDiscardRow]);

  const updateItem = useCallback((id: string, updates: Partial<QueueItem>) => {
    setQueue(prev => prev.map(q => q.id === id ? { ...q, ...updates } : q));
  }, []);

  const processQueue = useCallback(async () => {
    if (processingRef.current) return;
    processingRef.current = true;
    const deps = createBrowserDeps((file, ocr, options) =>
      callbackRefs.current.onProcessFile({ file: file as FileInfo, ocrResult: ocr }, options),
    );

    while (pendingRef.current.length > 0) {
      const { id, file, allowDuplicate } = pendingRef.current.shift()!;

      updateItem(id, { phase: 'checking', progress: 0, error: undefined });
      try {
        const outcome = await runUploadPipeline(file, deps, {
          allowDuplicate,
          onPhase: (phase) => updateItem(id, { phase }),
          onProgress: (progress) => updateItem(id, { progress }),
        });
        if (outcome.kind === 'duplicate') {
          heldFilesRef.current.set(id, file);
          updateItem(id, { phase: 'duplicate', existing: outcome.existing });
        } else {
          updateItem(id, {
            phase: 'done',
            rowId: outcome.rowId,
            similar: outcome.similar ?? undefined,
            notice:
              outcome.attention === 'ocr_failed'
                ? 'Saved without text: the receipt could not be read. Open it in the dashboard to fill in the fields.'
                : outcome.attention === 'low_quality'
                  ? 'Saved, but hard to read: check amount and date in the dashboard.'
                  : undefined,
          });
        }
      } catch (err) {
        updateItem(id, { phase: 'error', error: err instanceof Error ? err.message : 'Processing failed' });
      }
    }

    processingRef.current = false;

    setQueue(prev => {
      const total = prev.length;
      const succeeded = prev.filter(q => q.phase === 'done').length;
      const failed = prev.filter(q => q.phase === 'error').length;
      const settled = prev.every(q => !ACTIVE_PHASES.includes(q.phase));
      // Move on by itself only when nothing waits for a decision: a duplicate
      // prompt or a look-alike warning must not vanish behind a redirect.
      if (total > 0 && settled && !prev.some(needsAttention)) {
        setTimeout(() => callbackRefs.current.onAllComplete({ total, succeeded, failed }), 1200);
      }
      return prev;
    });
  }, [updateItem]);

  const enqueue = useCallback((files: File[], failures: { fileName: string; error: string }[] = []) => {
    const items: QueueItem[] = files.map(f => ({
      id: `q-${++nextId}`,
      fileName: f.name,
      phase: 'pending' as const,
      progress: 0,
    }));
    const failed: QueueItem[] = failures.map(f => ({
      id: `q-${++nextId}`,
      fileName: f.fileName,
      phase: 'error' as const,
      progress: 0,
      error: f.error,
    }));
    if (items.length + failed.length === 0) return;
    pendingRef.current.push(...files.map((f, i) => ({ id: items[i].id, file: f })));
    setQueue(prev => [...prev, ...items, ...failed]);
    if (items.length > 0) processQueue();
  }, [processQueue]);

  const addFiles = useCallback(async (files: File[]) => {
    const valid = files.filter(f => f.type.startsWith('image/') || f.type === 'application/pdf');
    if (!valid.length) return;
    if (!splitPages) {
      enqueue(valid);
      return;
    }
    // Split each multi-page PDF into single pages first. A PDF that cannot be
    // split is listed as failed with the reason; it is NOT uploaded whole, since
    // that would silently merge all its receipts into one.
    setPreparing(true);
    const ready: File[] = [];
    const failures: { fileName: string; error: string }[] = [];
    try {
      for (const file of valid) {
        if (file.type !== 'application/pdf') {
          ready.push(file);
          continue;
        }
        try {
          ready.push(...(await splitPdfPages(file)));
        } catch (err) {
          failures.push({
            fileName: file.name,
            error: splitPdfMessage(err instanceof SplitPdfError ? err.code : 'unreadable'),
          });
        }
      }
    } finally {
      setPreparing(false);
    }
    enqueue(ready, failures);
  }, [splitPages, enqueue]);

  const uploadAnyway = useCallback((id: string) => {
    const file = heldFilesRef.current.get(id);
    if (!file) return;
    heldFilesRef.current.delete(id);
    updateItem(id, { phase: 'pending', existing: undefined });
    pendingRef.current.push({ id, file, allowDuplicate: true });
    processQueue();
  }, [updateItem, processQueue]);

  const skipDuplicate = useCallback((id: string) => {
    heldFilesRef.current.delete(id);
    updateItem(id, { resolution: 'skipped' });
  }, [updateItem]);

  const keepSimilar = useCallback((id: string) => updateItem(id, { resolution: 'kept' }), [updateItem]);

  const discardSimilar = useCallback(async (item: QueueItem) => {
    if (!item.rowId) return;
    updateItem(item.id, { busy: true, error: undefined });
    try {
      await callbackRefs.current.onDiscardRow(item.rowId);
      updateItem(item.id, { busy: false, resolution: 'discarded' });
    } catch {
      updateItem(item.id, { busy: false, error: 'Could not discard the new receipt. It is still in the dashboard; try again or delete it there.' });
    }
  }, [updateItem]);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    void addFiles(Array.from(e.dataTransfer.files));
  }, [addFiles]);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
  }, []);

  const handleFileInput = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    void addFiles(Array.from(e.target.files || []));
    e.target.value = '';
  }, [addFiles]);

  const isProcessing = queue.some(q => ACTIVE_PHASES.includes(q.phase));
  const completedCount = queue.filter(q => !ACTIVE_PHASES.includes(q.phase)).length;
  const failedCount = queue.filter(q => q.phase === 'error').length;
  const attentionCount = queue.filter(needsAttention).length;
  const succeededCount = queue.filter(q => q.phase === 'done' && q.resolution !== 'discarded').length;
  // The automatic hand-off was held back for a decision; offer it as a button.
  const showContinue = !isProcessing && queue.length > 0 && queue.some(q => q.existing || q.similar || q.resolution);

  const splitToggle = (
    <label className="mt-3 flex cursor-pointer items-start gap-2.5 text-left text-xs" style={{ color: 'var(--muted)' }}>
      <input
        type="checkbox"
        className="mt-0.5 h-4 w-4 shrink-0"
        style={{ accentColor: 'var(--accent)' }}
        checked={splitPages}
        onChange={(e) => setSplitPages(e.target.checked)}
      />
      <span>
        <span style={{ color: 'var(--foreground)' }}>One receipt per page.</span> Split multi-page PDF scans so each page
        becomes its own receipt (for a stack of scanned receipts).
      </span>
    </label>
  );

  // Empty state — full drop zone
  if (queue.length === 0) {
    return (
      <div className="w-full">
        <div
          onDrop={handleDrop}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          className="glass-panel relative rounded-xl p-10 text-center transition-all duration-200 cursor-pointer overflow-hidden hover:bg-[var(--surface-elevated)]"
          style={{
            background: isDragging ? 'var(--accent-muted)' : undefined,
            borderColor: isDragging ? 'var(--accent)' : undefined,
          }}
        >
          <label className="cursor-pointer block">
            <input
              type="file"
              accept="image/*,application/pdf"
              multiple
              onChange={handleFileInput}
              className="hidden"
            />
            <div className="space-y-4">
              <div className="w-10 h-10 mx-auto" style={{ color: 'var(--muted)' }}>
                <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 16V4m0 0l-4 4m4-4l4 4" />
                  <path strokeLinecap="round" strokeLinejoin="round" d="M20 16.7V19a2 2 0 01-2 2H6a2 2 0 01-2-2v-2.3" />
                </svg>
              </div>
              <div>
                <p className="text-sm font-medium" style={{ color: 'var(--foreground)' }}>
                  Drop your receipts here
                </p>
                <p className="text-xs mt-1.5" style={{ color: 'var(--muted)' }}>
                  or click to browse, select multiple files at once
                </p>
              </div>
              <div className="flex flex-wrap items-center justify-center gap-1.5">
                {['JPG', 'PNG', 'WebP', 'PDF'].map(fmt => (
                  <span
                    key={fmt}
                    className="px-2 py-0.5 rounded text-[10px] font-medium uppercase tracking-wider"
                    style={{ background: 'rgba(255, 255, 255, 0.06)', color: 'var(--muted)', border: '1px solid rgba(255, 255, 255, 0.06)' }}
                  >
                    {fmt}
                  </span>
                ))}
              </div>
            </div>
          </label>
        </div>
        {splitToggle}
        {preparing && (
          <p className="mt-2 text-xs" style={{ color: 'var(--muted)' }} role="status">
            Splitting pages…
          </p>
        )}
      </div>
    );
  }

  // Queue UI
  return (
    <div className="w-full space-y-3">
      {/* Overall progress */}
      <div className="glass-panel rounded-xl px-5 py-4">
        <div className="flex items-center justify-between mb-2.5">
          <p className="text-sm font-medium" style={{ color: 'var(--foreground)' }}>
            {isProcessing ? 'Processing receipts' : failedCount > 0 ? 'Processing complete' : 'All receipts processed'}
          </p>
          <span className="text-xs font-medium tabular-nums" style={{ color: 'var(--muted)' }}>
            {completedCount} of {queue.length}
          </span>
        </div>
        <div className="w-full h-1.5 rounded-full overflow-hidden" style={{ background: 'var(--border)' }}>
          <div
            className="h-full rounded-full transition-all duration-500 ease-out"
            style={{
              width: `${(completedCount / queue.length) * 100}%`,
              background: !isProcessing && failedCount > 0 ? 'var(--danger)' : 'var(--accent)',
            }}
          />
        </div>
        {!isProcessing && failedCount > 0 && (
          <p className="text-xs mt-2" style={{ color: 'var(--danger)' }}>
            {failedCount} {failedCount === 1 ? 'file' : 'files'} failed
          </p>
        )}
        {attentionCount > 0 && (
          <p className="text-xs mt-2" style={{ color: 'var(--accent)' }} role="status">
            {attentionCount} {attentionCount === 1 ? 'file needs' : 'files need'} your decision below.
          </p>
        )}
        {showContinue && (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button
              type="button"
              className="ui-btn ui-btn-primary ui-btn-sm"
              disabled={attentionCount > 0}
              onClick={() => onAllComplete({ total: queue.length, succeeded: succeededCount, failed: failedCount })}
            >
              Continue to dashboard
            </button>
            {attentionCount > 0 && (
              <span className="text-xs" style={{ color: 'var(--muted)' }}>
                Decide on the marked files first.
              </span>
            )}
          </div>
        )}
      </div>

      {/* File list */}
      <div className="space-y-1.5">
        {queue.map(item => (
          <div key={item.id} className="glass-panel rounded-lg px-4 py-2.5">
            <div className="flex items-start gap-3">
              {/* Phase icon */}
              <div className="shrink-0 w-5 h-5 flex items-center justify-center">
                {item.phase === 'duplicate' ? (
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                    <rect x="8" y="8" width="12" height="12" rx="2" />
                    <path d="M4 16V6a2 2 0 0 1 2-2h10" />
                  </svg>
                ) : item.phase === 'done' ? (
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="20 6 9 17 4 12" stroke="#22c55e" />
                  </svg>
                ) : item.phase === 'error' ? (
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <line x1="18" y1="6" x2="6" y2="18" stroke="var(--danger)" />
                    <line x1="6" y1="6" x2="18" y2="18" stroke="var(--danger)" />
                  </svg>
                ) : item.phase === 'pending' ? (
                  <div className="w-2.5 h-2.5 rounded-full" style={{ background: 'var(--border)' }} />
                ) : (
                  <svg className="animate-spin w-4 h-4" viewBox="0 0 24 24" fill="none" style={{ color: 'var(--accent)' }}>
                    <circle className="opacity-20" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
                    <path className="opacity-90" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                  </svg>
                )}
              </div>

              {/* File name + upload progress */}
              <div className="flex-1 min-w-0">
                <p className="text-sm truncate" style={{ color: 'var(--foreground)' }}>
                  {item.fileName}
                </p>
                {item.phase === 'uploading' && (
                  <div className="mt-1 flex items-center gap-2">
                    <div className="flex-1 h-1 rounded-full overflow-hidden" style={{ background: 'var(--border)' }}>
                      <div
                        className="h-full rounded-full transition-all duration-300"
                        style={{ width: `${item.progress}%`, background: 'var(--accent)' }}
                      />
                    </div>
                    <span className="text-[10px] tabular-nums shrink-0" style={{ color: 'var(--muted)' }}>
                      {item.progress}%
                    </span>
                  </div>
                )}
                {item.error && (
                  <p className="text-xs mt-0.5" style={{ color: 'var(--danger)' }} role="alert">{item.error}</p>
                )}
                {item.notice && (
                  <p className="text-xs mt-0.5" style={{ color: 'var(--accent)' }} role="status">{item.notice}</p>
                )}
                {item.phase === 'duplicate' && item.existing && (
                  <div className="mt-1.5 text-xs" style={{ color: 'var(--muted)' }}>
                    {item.resolution === 'skipped' ? (
                      <p>Skipped: this exact file is already attached to “{item.existing.name}”.</p>
                    ) : (
                      <>
                        <p>
                          This exact file is already attached to “{item.existing.name}”. Nothing was uploaded.
                        </p>
                        <div className="mt-1.5 flex flex-wrap gap-2">
                          <button type="button" className="ui-btn ui-btn-sm" onClick={() => skipDuplicate(item.id)}>
                            Skip this file
                          </button>
                          <button type="button" className="ui-btn ui-btn-sm" onClick={() => uploadAnyway(item.id)}>
                            Upload anyway
                          </button>
                        </div>
                      </>
                    )}
                  </div>
                )}
                {item.phase === 'done' && item.similar && (
                  <div className="mt-1.5 text-xs" style={{ color: 'var(--muted)' }}>
                    {item.resolution === 'discarded' ? (
                      <p>Discarded: the existing receipt “{item.similar.name}” was kept.</p>
                    ) : item.resolution === 'kept' ? (
                      <p>Kept both: this one and “{item.similar.name}”.</p>
                    ) : (
                      <>
                        <p>
                          Saved, but it looks like a receipt you already have: “{item.similar.name}” has the same
                          vendor, date and total.
                        </p>
                        <div className="mt-1.5 flex flex-wrap gap-2">
                          <button type="button" className="ui-btn ui-btn-sm" disabled={item.busy} onClick={() => keepSimilar(item.id)}>
                            Keep both
                          </button>
                          <button type="button" className="ui-btn ui-btn-sm ui-btn-danger" disabled={item.busy} onClick={() => void discardSimilar(item)}>
                            {item.busy ? 'Discarding…' : 'Discard the new one'}
                          </button>
                        </div>
                      </>
                    )}
                  </div>
                )}
              </div>

              {/* Phase label */}
              <span
                className="shrink-0 text-xs"
                style={{
                  color:
                    item.phase === 'error'
                      ? 'var(--danger)'
                      : item.phase === 'duplicate'
                        ? 'var(--accent)'
                        : item.phase === 'done'
                          ? '#22c55e'
                          : 'var(--muted)',
                }}
              >
                {phaseLabels[item.phase]}
              </span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
