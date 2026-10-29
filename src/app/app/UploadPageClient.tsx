'use client';

import { Suspense, useCallback, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import ReceiptUploader from '@/components/ReceiptUploader';
import type { UploadResult, BatchStats } from '@/components/ReceiptUploader';
import PhoneCapture from '@/components/capture/PhoneCapture';
import { sharedNotice } from '@/lib/capture/shared-notice';
import type { UploadTarget } from '@/lib/auth-workspace';
import type { SaveReceipt } from '@/lib/upload/browser-deps';
import UploadTargetPicker from '@/components/UploadTargetPicker';
import { processReceipt, retakeReceipt } from './actions';
import { deleteRow } from './dashboard/actions';

interface UploadPageProps {
  /** Every company this account may upload into. */
  targets: UploadTarget[];
  /** The company active when the page was opened: the starting choice. */
  initialWorkspaceId: string;
}

export default function UploadPageClient(props: UploadPageProps) {
  // useSearchParams needs a Suspense boundary above it.
  return (
    <Suspense fallback={null}>
      <UploadPageContent {...props} />
    </Suspense>
  );
}

function UploadPageContent({ targets, initialWorkspaceId }: UploadPageProps) {
  const router = useRouter();
  // Set by the share target after a file was shared into the app.
  const notice = sharedNotice(useSearchParams().get('shared'));
  // The company every upload of THIS page goes into. It is fixed when the page
  // opens and changes only here: switching the company in another tab or
  // session does not move uploads that this page sends.
  const [workspaceId, setWorkspaceId] = useState(initialWorkspaceId);
  // The company switcher in THIS tab's header re-renders the page with the new
  // active company: then the uploads follow it. Another tab cannot do this.
  const [shownInitial, setShownInitial] = useState(initialWorkspaceId);
  if (shownInitial !== initialWorkspaceId) {
    setShownInitial(initialWorkspaceId);
    setWorkspaceId(initialWorkspaceId);
  }
  const target = targets.find((t) => t.workspaceId === workspaceId) ?? null;

  const processFile = useCallback(
    (result: UploadResult, options: { sha256: string; workspaceId: string }) =>
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
        retakeReceipt(rowId, { id: file.id, originalName: file.originalName, fileType: file.fileType }, ocr, { sha256: options.sha256 }),
    [],
  );

  const handleAllComplete = useCallback((stats: BatchStats) => {
    // The dashboard shows the ACTIVE company. When this page uploaded into
    // another one, going there would hide what was just saved.
    if (stats.succeeded > 0 && workspaceId === initialWorkspaceId) {
      router.push('/app/dashboard');
    }
  }, [router, workspaceId, initialWorkspaceId]);

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

        <UploadTargetPicker targets={targets} workspaceId={workspaceId} onChange={setWorkspaceId} />

        {target ? (
          <>
            {/* Phone capture: one photo at a time, no redirect */}
            <div className="mb-4">
              <PhoneCapture
                workspaceId={workspaceId}
                onSave={saveCapture}
                onRetake={retakeCapture}
                onDiscardRow={deleteRow}
                notice={notice}
                activeWorkspaceId={initialWorkspaceId}
              />
            </div>

            {/* Upload */}
            <ReceiptUploader
              workspaceId={workspaceId}
              onProcessFile={processFile}
              onAllComplete={handleAllComplete}
              onDiscardRow={deleteRow}
              activeWorkspaceId={initialWorkspaceId}
            />
          </>
        ) : (
          <p role="alert" className="glass-panel rounded-lg px-4 py-3 text-sm" style={{ color: 'var(--foreground)' }}>
            This account has no company to upload into. Ask for access to a company, then reload the page.
          </p>
        )}

        <p className="text-center mt-6 text-xs" style={{ color: 'var(--muted)' }}>
          A vendor that is always private, or always university?{' '}
          <Link href="/app/rules" className="underline" style={{ color: 'var(--accent)' }}>
            Assignment rules
          </Link>{' '}
          apply to every receipt read from now on.
        </p>

        {/* Dashboard link */}
        <div className="text-center mt-8">
          <Link
            href="/app/dashboard"
            className="glass-panel inline-flex items-center gap-2 px-5 py-2.5 rounded-lg text-sm font-medium transition-all duration-200 hover:border-[var(--accent)] hover:text-[var(--accent)] max-sm:min-h-11"
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
