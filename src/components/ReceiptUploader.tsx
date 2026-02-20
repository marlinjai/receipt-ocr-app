'use client';

import { useState, useCallback } from 'react';
import { getStorageClient, type FileInfo } from '@/lib/storage';
import type { OcrResult } from '@/lib/ocr-types';

export interface UploadResult {
  file: FileInfo;
  ocrResult: OcrResult | null;
}

interface ReceiptUploaderProps {
  onUploadComplete: (result: UploadResult) => void;
}

export default function ReceiptUploader({ onUploadComplete }: ReceiptUploaderProps) {
  const [isDragging, setIsDragging] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [phase, setPhase] = useState<'idle' | 'uploading' | 'ocr'>('idle');
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const handleUpload = useCallback(async (file: File) => {
    setIsUploading(true);
    setPhase('uploading');
    setProgress(0);
    setError(null);

    try {
      const storage = getStorageClient();

      const result = await storage.upload(file, {
        context: 'receipt',
        tags: { source: 'receipt-ocr-app' },
        onProgress: (p) => setProgress(p),
      });

      // Now run OCR
      setPhase('ocr');
      setProgress(0);

      let ocrResult: OcrResult | null = null;
      try {
        const ocrResponse = await fetch('/api/ocr', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ fileUrl: result.url }),
        });

        if (ocrResponse.ok) {
          ocrResult = await ocrResponse.json();
        }
      } catch {
        // OCR failed but upload succeeded — continue with null OCR
      }

      onUploadComplete({ file: result, ocrResult });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setIsUploading(false);
      setPhase('idle');
      setProgress(0);
    }
  }, [onUploadComplete]);

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

  const phaseLabel = phase === 'uploading' ? 'Uploading receipt...' : 'Running OCR...';
  const phaseDetail = phase === 'uploading' ? 'Storing file securely' : 'Extracting text with AI';

  return (
    <div className="w-full">
      <div
        onDrop={handleDrop}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        className="relative rounded-xl p-10 text-center transition-all duration-200 cursor-pointer overflow-hidden"
        style={{
          background: isDragging ? 'var(--accent-muted)' : 'var(--surface)',
          border: `1px solid ${isDragging ? 'var(--accent)' : 'var(--border)'}`,
          opacity: isUploading ? 0.7 : 1,
          pointerEvents: isUploading ? 'none' : 'auto',
        }}
        onMouseEnter={e => {
          if (!isUploading && !isDragging) {
            e.currentTarget.style.borderColor = 'var(--border)';
            e.currentTarget.style.background = 'var(--surface-elevated)';
          }
        }}
        onMouseLeave={e => {
          if (!isUploading && !isDragging) {
            e.currentTarget.style.borderColor = 'var(--border)';
            e.currentTarget.style.background = 'var(--surface)';
          }
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
                    style={{ background: 'var(--border)', color: 'var(--muted)' }}
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
          {error}
        </div>
      )}
    </div>
  );
}
