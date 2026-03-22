'use client';

import { useState, useCallback, useEffect, useRef } from 'react';
import { getStorageClient, type FileInfo } from '@/lib/storage';
import type { OcrResult } from '@/lib/ocr-types';

export interface UploadResult {
  file: FileInfo;
  ocrResult: OcrResult | null;
}

export interface BatchStats {
  total: number;
  succeeded: number;
  failed: number;
}

interface ReceiptUploaderProps {
  onProcessFile: (result: UploadResult) => Promise<void>;
  onAllComplete: (stats: BatchStats) => void;
}

type ItemPhase = 'pending' | 'uploading' | 'ocr' | 'saving' | 'done' | 'error';

interface QueueItem {
  id: string;
  fileName: string;
  phase: ItemPhase;
  progress: number;
  error?: string;
}

let nextId = 0;

const phaseLabels: Record<ItemPhase, string> = {
  pending: 'Waiting',
  uploading: 'Uploading',
  ocr: 'OCR',
  saving: 'Saving',
  done: 'Done',
  error: 'Failed',
};

export default function ReceiptUploader({ onProcessFile, onAllComplete }: ReceiptUploaderProps) {
  const [isDragging, setIsDragging] = useState(false);
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const pendingRef = useRef<{ id: string; file: File }[]>([]);
  const processingRef = useRef(false);
  const callbackRefs = useRef({ onProcessFile, onAllComplete });
  callbackRefs.current = { onProcessFile, onAllComplete };

  const updateItem = useCallback((id: string, updates: Partial<QueueItem>) => {
    setQueue(prev => prev.map(q => q.id === id ? { ...q, ...updates } : q));
  }, []);

  const processQueue = useCallback(async () => {
    if (processingRef.current) return;
    processingRef.current = true;

    while (pendingRef.current.length > 0) {
      const { id, file } = pendingRef.current.shift()!;

      updateItem(id, { phase: 'uploading', progress: 0 });
      try {
        const storage = getStorageClient();
        const fileInfo = await storage.upload(file, {
          context: 'receipt',
          tags: { source: 'receipt-ocr-app' },
          onProgress: (p: number) => updateItem(id, { progress: p }),
        });

        updateItem(id, { phase: 'ocr' });
        const ocrRes = await fetch('/api/ocr', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ fileId: fileInfo.id, fileName: fileInfo.originalName }),
        });

        if (!ocrRes.ok) {
          const errText = await ocrRes.text().catch(() => '');
          throw new Error(`OCR failed (${ocrRes.status})${errText ? ': ' + errText : ''}`);
        }

        const ocrResult: OcrResult = await ocrRes.json();

        updateItem(id, { phase: 'saving' });
        await callbackRefs.current.onProcessFile({ file: fileInfo, ocrResult });
        updateItem(id, { phase: 'done' });
      } catch (err) {
        updateItem(id, { phase: 'error', error: err instanceof Error ? err.message : 'Processing failed' });
      }
    }

    processingRef.current = false;

    setQueue(prev => {
      const total = prev.length;
      const succeeded = prev.filter(q => q.phase === 'done').length;
      const failed = prev.filter(q => q.phase === 'error').length;
      if (total > 0 && succeeded + failed === total) {
        setTimeout(() => callbackRefs.current.onAllComplete({ total, succeeded, failed }), 1200);
      }
      return prev;
    });
  }, [updateItem]);

  const addFiles = useCallback((files: File[]) => {
    const valid = files.filter(f => f.type.startsWith('image/') || f.type === 'application/pdf');
    if (!valid.length) return;

    const items: QueueItem[] = valid.map(f => ({
      id: `q-${++nextId}`,
      fileName: f.name,
      phase: 'pending' as const,
      progress: 0,
    }));

    pendingRef.current.push(...valid.map((f, i) => ({ id: items[i].id, file: f })));
    setQueue(prev => [...prev, ...items]);
    processQueue();
  }, [processQueue]);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    addFiles(Array.from(e.dataTransfer.files));
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
    addFiles(Array.from(e.target.files || []));
    e.target.value = '';
  }, [addFiles]);

  const isProcessing = queue.some(q => ['pending', 'uploading', 'ocr', 'saving'].includes(q.phase));
  const completedCount = queue.filter(q => q.phase === 'done' || q.phase === 'error').length;
  const failedCount = queue.filter(q => q.phase === 'error').length;

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
                  or click to browse — select multiple files at once
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
      </div>

      {/* File list */}
      <div className="space-y-1.5">
        {queue.map(item => (
          <div key={item.id} className="glass-panel rounded-lg px-4 py-2.5">
            <div className="flex items-center gap-3">
              {/* Phase icon */}
              <div className="shrink-0 w-5 h-5 flex items-center justify-center">
                {item.phase === 'done' ? (
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
                  <p className="text-xs mt-0.5 truncate" style={{ color: 'var(--danger)' }}>{item.error}</p>
                )}
              </div>

              {/* Phase label */}
              <span
                className="shrink-0 text-xs"
                style={{
                  color: item.phase === 'error' ? 'var(--danger)' : item.phase === 'done' ? '#22c55e' : 'var(--muted)',
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
