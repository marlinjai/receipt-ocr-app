'use client';

import { useState, useCallback } from 'react';
import { getStorageClient, type FileInfo } from '@/lib/storage';
import type { OcrResult } from '@/lib/ocr-types';

export interface UploadResult {
  file: FileInfo;
  ocrResult: OcrResult | null;
}

interface ReceiptUploaderProps {
  onUploadComplete: (result: UploadResult) => void | Promise<void>;
  onRetryClassification?: () => Promise<void>;
}

type FailedStep = 'upload' | 'ocr' | 'classification' | 'saving';

interface ErrorState {
  step: FailedStep;
  message: string;
}

export default function ReceiptUploader({ onUploadComplete, onRetryClassification }: ReceiptUploaderProps) {
  const [isDragging, setIsDragging] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [phase, setPhase] = useState<'idle' | 'uploading' | 'ocr' | 'saving'>('idle');
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<ErrorState | null>(null);
  const [ocrWarning, setOcrWarning] = useState<string | null>(null);
  const [isRetrying, setIsRetrying] = useState(false);
  const [lastFile, setLastFile] = useState<File | null>(null);

  const handleUpload = useCallback(async (file: File) => {
    setIsUploading(true);
    setPhase('uploading');
    setProgress(0);
    setError(null);
    setOcrWarning(null);
    setLastFile(file);

    try {
      const storage = getStorageClient();

      let result: FileInfo;
      try {
        result = await storage.upload(file, {
          context: 'receipt',
          tags: { source: 'receipt-ocr-app' },
          onProgress: (p) => setProgress(p),
        });
      } catch (err) {
        setError({
          step: 'upload',
          message: err instanceof Error ? err.message : 'File upload failed',
        });
        return;
      }

      // Now run OCR
      setPhase('ocr');
      setProgress(0);

      let ocrResult: OcrResult | null = null;
      try {
        const ocrResponse = await fetch('/api/ocr', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ fileId: result.id, fileName: result.originalName }),
        });

        if (ocrResponse.ok) {
          ocrResult = await ocrResponse.json();
        } else {
          const errText = await ocrResponse.text().catch(() => '');
          setError({
            step: 'ocr',
            message: `OCR extraction failed (${ocrResponse.status})${errText ? ': ' + errText : ''}`,
          });
          return;
        }
      } catch (err) {
        setError({
          step: 'ocr',
          message: err instanceof Error ? err.message : 'OCR request failed',
        });
        return;
      }

      setPhase('saving');
      try {
        await onUploadComplete({ file: result, ocrResult });
      } catch (err) {
        // Classification or saving error thrown by the parent
        const message = err instanceof Error ? err.message : 'Failed to save receipt';
        const isClassification = message.toLowerCase().includes('classification');
        setError({
          step: isClassification ? 'classification' : 'saving',
          message,
        });
        return;
      }
    } finally {
      setIsUploading(false);
      setPhase('idle');
      setProgress(0);
    }
  }, [onUploadComplete]);

  const handleRetry = useCallback(async () => {
    if (!error) return;
    setIsRetrying(true);

    try {
      if (error.step === 'classification' && onRetryClassification) {
        // Retry just the classification step (no re-upload needed)
        setError(null);
        setPhase('saving');
        setIsUploading(true);
        try {
          await onRetryClassification();
        } catch (err) {
          setError({
            step: 'classification',
            message: err instanceof Error ? err.message : 'Classification retry failed',
          });
        } finally {
          setIsUploading(false);
          setPhase('idle');
        }
      } else if (lastFile) {
        // Re-run the full upload flow from the beginning
        setError(null);
        await handleUpload(lastFile);
      }
    } finally {
      setIsRetrying(false);
    }
  }, [error, lastFile, handleUpload, onRetryClassification]);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    const file = e.dataTransfer.files[0];
    if (file) handleUpload(file);
  }, [handleUpload]);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
  }, []);

  const handleFileInput = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) handleUpload(file);
  }, [handleUpload]);

  const phaseLabel = phase === 'uploading' ? 'Uploading receipt...' : phase === 'ocr' ? 'Running OCR...' : 'Saving to database...';
  const phaseDetail = phase === 'uploading' ? 'Storing file securely' : phase === 'ocr' ? 'Extracting text with AI' : 'Writing receipt data';

  const stepLabels: Record<FailedStep, string> = {
    upload: 'Upload',
    ocr: 'OCR',
    classification: 'AI Classification',
    saving: 'Saving',
  };

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
          opacity: isUploading ? 0.7 : 1,
          pointerEvents: isUploading ? 'none' : 'auto',
        }}
      >
        {isUploading ? (
          <div className="space-y-5">
            {/* Spinner */}
            <div className="w-12 h-12 mx-auto" style={{ color: 'var(--accent)' }}>
              <svg className="animate-spin" viewBox="0 0 24 24" fill="none">
                <circle className="opacity-20" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
                <path className="opacity-90" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
              </svg>
            </div>

            <div>
              <p className="text-sm font-medium" style={{ color: 'var(--foreground)' }}>{phaseLabel}</p>
              <p className="text-xs mt-1" style={{ color: 'var(--muted)' }}>{phaseDetail}</p>
            </div>

            {phase === 'uploading' && (
              <div className="max-w-xs mx-auto space-y-2">
                <div className="w-full h-1.5 rounded-full overflow-hidden" style={{ background: 'var(--border)' }}>
                  <div
                    className="h-full rounded-full transition-all duration-300"
                    style={{ width: `${progress}%`, background: 'var(--accent)' }}
                  />
                </div>
                <p className="text-xs tabular-nums" style={{ color: 'var(--muted)' }}>{progress}%</p>
              </div>
            )}
          </div>
        ) : (
          <label className="cursor-pointer block">
            <input
              type="file"
              accept="image/*,application/pdf"
              onChange={handleFileInput}
              className="hidden"
            />
            <div className="space-y-4">
              {/* Upload icon */}
              <div className="w-10 h-10 mx-auto" style={{ color: 'var(--muted)' }}>
                <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 16V4m0 0l-4 4m4-4l4 4" />
                  <path strokeLinecap="round" strokeLinejoin="round" d="M20 16.7V19a2 2 0 01-2 2H6a2 2 0 01-2-2v-2.3" />
                </svg>
              </div>

              <div>
                <p className="text-sm font-medium" style={{ color: 'var(--foreground)' }}>
                  Drop your receipt here
                </p>
                <p className="text-xs mt-1.5" style={{ color: 'var(--muted)' }}>
                  or click to browse
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
        )}
      </div>

      {error && (
        <div
          className="mt-4 px-4 py-3 rounded-lg text-sm"
          style={{ background: 'var(--danger-muted)', color: 'var(--danger)', border: '1px solid rgba(229, 83, 75, 0.2)' }}
        >
          <div className="flex items-start justify-between gap-3">
            <div className="flex-1 min-w-0">
              <p className="font-medium">{stepLabels[error.step]} failed</p>
              <p className="mt-1 text-xs opacity-80 break-words">{error.message}</p>
              {error.step === 'classification' && (
                <p className="mt-1 text-xs opacity-70">Row was saved with OCR data and Pending status.</p>
              )}
            </div>
            <button
              onClick={handleRetry}
              disabled={isRetrying}
              className="shrink-0 px-3 py-1.5 rounded-md text-xs font-medium transition-all duration-200"
              style={{
                background: 'rgba(229, 83, 75, 0.15)',
                color: 'var(--danger)',
                border: '1px solid rgba(229, 83, 75, 0.3)',
                opacity: isRetrying ? 0.6 : 1,
                cursor: isRetrying ? 'not-allowed' : 'pointer',
              }}
            >
              {isRetrying ? 'Retrying...' : 'Retry'}
            </button>
          </div>
        </div>
      )}

      {ocrWarning && (
        <div
          className="mt-4 px-4 py-3 rounded-lg text-sm"
          style={{ background: 'rgba(234, 179, 8, 0.1)', color: 'rgb(234, 179, 8)', border: '1px solid rgba(234, 179, 8, 0.2)' }}
        >
          {ocrWarning}
        </div>
      )}
    </div>
  );
}
