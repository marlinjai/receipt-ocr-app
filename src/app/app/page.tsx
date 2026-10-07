'use client';

import { useCallback } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import ReceiptUploader from '@/components/ReceiptUploader';
import type { UploadResult, BatchStats } from '@/components/ReceiptUploader';
import PhoneCapture from '@/components/capture/PhoneCapture';
import type { SaveReceipt } from '@/lib/upload/browser-deps';
import { processReceipt, retakeReceipt } from './actions';
import { deleteRow } from './dashboard/actions';

export default function UploadPage() {
  const router = useRouter();

  const processFile = useCallback(
    (result: UploadResult, options: { sha256: string }) =>
      processReceipt(
        { id: result.file.id, originalName: result.file.originalName, fileType: result.file.fileType },
        result.ocrResult,
        options,
      ),
    [],
  );

  // Phone capture: the same save, plus a retake that reads a new photo into an existing receipt.
  const saveCapture = useCallback<SaveReceipt>(
    (file, ocr, options) =>
      processReceipt({ id: file.id, originalName: file.originalName, fileType: file.fileType }, ocr, options),
    [],
  );
  const retakeCapture = useCallback(
    (rowId: string): SaveReceipt =>
      (file, ocr, options) =>
        retakeReceipt(rowId, { id: file.id, originalName: file.originalName, fileType: file.fileType }, ocr, options),
    [],
  );

  const handleAllComplete = useCallback((stats: BatchStats) => {
    if (stats.succeeded > 0) {
      router.push('/app/dashboard');
    }
  }, [router]);

  return (
    <main className="relative z-10 min-h-svh flex flex-col items-center justify-center px-4 py-16">
      <div className="w-full max-w-lg mx-auto">
        {/* Header */}
        <div className="text-center mb-10">
          <div
            className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-medium tracking-wide uppercase mb-6"
            style={{ background: 'var(--accent-muted)', color: 'var(--accent)' }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
              <polyline points="14 2 14 8 20 8" />
              <line x1="16" y1="13" x2="8" y2="13" />
              <line x1="16" y1="17" x2="8" y2="17" />
            </svg>
            AI-Powered OCR
          </div>

          <h1
            className="text-4xl font-bold tracking-tight mb-3"
            style={{ color: 'var(--foreground)' }}
          >
            Receipt OCR
          </h1>

          <p
            className="text-base leading-relaxed max-w-md mx-auto"
            style={{ color: 'var(--muted)' }}
          >
            Upload receipts and invoices to instantly extract text and structured data.
            Powered by{' '}
            <a
              href="https://github.com/marlinjai/storage-brain"
              target="_blank"
              rel="noopener noreferrer"
              className="transition-colors"
              style={{ color: 'var(--accent)', textDecoration: 'none' }}
              onMouseEnter={e => (e.currentTarget.style.color = 'var(--accent-hover)')}
              onMouseLeave={e => (e.currentTarget.style.color = 'var(--accent)')}
            >
              Storage Brain
            </a>.
          </p>
        </div>

        {/* Phone capture: one photo at a time, no redirect */}
        <div className="mb-4">
          <PhoneCapture onSave={saveCapture} onRetake={retakeCapture} onDiscardRow={deleteRow} />
        </div>

        {/* Upload */}
        <ReceiptUploader
          onProcessFile={processFile}
          onAllComplete={handleAllComplete}
          onDiscardRow={deleteRow}
        />

        {/* Dashboard link */}
        <div className="text-center mt-8">
          <Link
            href="/app/dashboard"
            className="glass-panel inline-flex items-center gap-2 px-5 py-2.5 rounded-lg text-sm font-medium transition-all duration-200 hover:border-[var(--accent)] hover:text-[var(--accent)]"
            style={{
              color: 'var(--foreground)',
            }}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="3" width="7" height="7" />
              <rect x="14" y="3" width="7" height="7" />
              <rect x="14" y="14" width="7" height="7" />
              <rect x="3" y="14" width="7" height="7" />
            </svg>
            View Dashboard
          </Link>
        </div>

        {/* Footer */}
        <footer className="mt-16 text-center text-xs" style={{ color: 'var(--muted)' }}>
          <p>
            Built with{' '}
            <a
              href="https://www.npmjs.com/package/@marlinjai/storage-brain-sdk"
              target="_blank"
              rel="noopener noreferrer"
              className="transition-colors"
              style={{ color: 'var(--muted)', textDecoration: 'underline', textUnderlineOffset: '2px' }}
              onMouseEnter={e => (e.currentTarget.style.color = 'var(--accent)')}
              onMouseLeave={e => (e.currentTarget.style.color = 'var(--muted)')}
            >
              @marlinjai/storage-brain-sdk
            </a>
          </p>
        </footer>
      </div>
    </main>
  );
}
