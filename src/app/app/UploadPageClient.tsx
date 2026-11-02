'use client';

import { Suspense, useCallback, useMemo, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import ReceiptUploader from '@/components/ReceiptUploader';
import type { UploadResult, BatchStats } from '@/components/ReceiptUploader';
import PhoneCapture from '@/components/capture/PhoneCapture';
import { sharedNotice } from '@/lib/capture/shared-notice';
import type { UploadTarget } from '@/lib/auth-workspace';
import type { SaveReceipt, UploadForPayment } from '@/lib/upload/browser-deps';
import type { UploadLink } from '@/lib/upload/pipeline';
import UploadTargetPicker from '@/components/UploadTargetPicker';
import { linkExistingUpload, processReceipt, retakeReceipt } from './actions';
import { afterDiscard, afterSave, checksHref, paymentLine, paymentToLink, refusalText, type UploadFor, type UploadForProgress } from './upload-for';

export type { UploadFor } from './upload-for';
import { deleteRow } from './dashboard/actions';

interface UploadPageProps {
  /** Every company this account may upload into. */
  targets: UploadTarget[];
  /** The company active when the page was opened: the starting choice. */
  initialWorkspaceId: string;
  /** Set when the page was opened for one payment (`?fuer=`): the first saved receipt is linked to it. */
  uploadFor?: UploadFor | null;
}

export default function UploadPageClient(props: UploadPageProps) {
  // useSearchParams needs a Suspense boundary above it.
  return (
    <Suspense fallback={null}>
      <UploadPageContent {...props} />
    </Suspense>
  );
}

function UploadPageContent({ targets, initialWorkspaceId, uploadFor = null }: UploadPageProps) {
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

  // Opened for one payment: files chosen while it waits are for it, and the first link settles it.
  const [progress, setProgress] = useState<UploadForProgress>({ step: 'waiting' });
  // Read when an answer arrives: answers come one after another, and each must see what the last one did.
  const progressNow = useRef<UploadForProgress>({ step: 'waiting' });
  const move = useCallback((next: UploadForProgress) => {
    if (next === progressNow.current) return;
    progressNow.current = next;
    setProgress(next);
  }, []);
  const onLinked = useCallback((link: UploadLink) => move(afterSave(uploadFor, progressNow.current, link)), [uploadFor, move]);
  // The payment a file chosen now is for: only in the payment's company, and only while the page waits.
  const paymentId = uploadFor && uploadFor.workspaceId === workspaceId ? (paymentToLink(uploadFor, progress) ?? null) : null;
  const forPayment = useMemo<UploadForPayment | null>(() => (paymentId ? { paymentId, claim: linkExistingUpload } : null), [paymentId]);
  // Discarding the receipt that was linked takes its links along: the payment waits again.
  const discardRow = useCallback(
    async (rowId: string) => {
      await deleteRow(rowId);
      move(afterDiscard(progressNow.current, rowId));
    },
    [move],
  );

  const processFile = useCallback(
    (result: UploadResult, options: { sha256: string; workspaceId: string; forPaymentId?: string }) =>
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
    const forWhat = uploadFor;
    const now = progressNow.current;
    // Uploaded for a payment and linked: back to the open receipts, where it is now done.
    if (forWhat && now.step === 'linked') {
      router.push(checksHref(forWhat));
      return;
    }
    // A refused link stays on screen with its reason and the way to link by hand.
    if (forWhat && now.step === 'refused') return;
    // The dashboard shows the ACTIVE company. When this page uploaded into
    // another one, going there would hide what was just saved.
    if (stats.succeeded > 0 && workspaceId === initialWorkspaceId) {
      router.push('/app/dashboard');
    }
  }, [router, workspaceId, initialWorkspaceId, uploadFor]);

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

        {uploadFor && <UploadForBanner uploadFor={uploadFor} progress={progress} />}

        {/* For a payment the company is the payment's: no choice to make. */}
        <UploadTargetPicker
          targets={uploadFor?.state === 'open' ? targets.filter((t) => t.workspaceId === uploadFor.workspaceId) : targets}
          workspaceId={workspaceId}
          onChange={setWorkspaceId}
        />

        {target ? (
          <>
            {/* Phone capture: one photo at a time, no redirect */}
            <div className="mb-4">
              <PhoneCapture
                workspaceId={workspaceId}
                onSave={saveCapture}
                onRetake={retakeCapture}
                onDiscardRow={discardRow}
                notice={notice}
                activeWorkspaceId={initialWorkspaceId}
                forPaymentId={paymentId}
                claimExisting={linkExistingUpload}
                onLinked={onLinked}
              />
            </div>

            {/* Upload */}
            <ReceiptUploader
              workspaceId={workspaceId}
              onProcessFile={processFile}
              onAllComplete={handleAllComplete}
              onDiscardRow={discardRow}
              activeWorkspaceId={initialWorkspaceId}
              forPayment={forPayment}
              onLinked={onLinked}
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
            Zu den Belegen
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

/** Which payment this upload is for, and what became of the link. */
function UploadForBanner({ uploadFor, progress }: { uploadFor: UploadFor; progress: UploadForProgress }) {
  const back = checksHref(uploadFor);
  if (uploadFor.state === 'gone') {
    return (
      <div role="status" className="glass-panel rounded-lg px-4 py-3 mb-4 text-sm" style={{ color: 'var(--foreground)' }}>
        Diese Zahlung wartet nicht mehr auf einen Beleg: sie hat inzwischen einen, oder sie gehört zu einer anderen Firma. Was du hier hochlädst, wird keiner Zahlung zugeordnet.{' '}
        <Link href={back} className="underline" style={{ color: 'var(--accent)' }}>
          Zu den offenen Belegen
        </Link>
      </div>
    );
  }
  const line = paymentLine(uploadFor.payment);
  if (progress.step === 'linked') {
    return (
      <div role="status" className="glass-panel rounded-lg px-4 py-3 mb-4 text-sm" style={{ color: 'var(--foreground)' }}>
        Zugeordnet: der Beleg gehört jetzt zu {line}.{' '}
        <Link href={back} className="underline" style={{ color: 'var(--accent)' }}>
          Zurück zu den offenen Belegen
        </Link>
      </div>
    );
  }
  if (progress.step === 'refused') {
    return (
      <div role="alert" className="glass-panel rounded-lg px-4 py-3 mb-4 text-sm" style={{ color: 'var(--foreground)' }}>
        Der Beleg ist gespeichert, aber nicht {line} zugeordnet: {refusalText(progress.reason)}. Unter den offenen Belegen kannst du ihn mit „Vorhandenen Beleg zuordnen“ selbst wählen.{' '}
        <Link href={back} className="underline" style={{ color: 'var(--accent)' }}>
          Zu den offenen Belegen
        </Link>
      </div>
    );
  }
  return (
    <div role="status" className="glass-panel rounded-lg px-4 py-3 mb-4 text-sm" style={{ color: 'var(--foreground)', borderColor: 'var(--accent)' }}>
      <p>
        <strong>Beleg für {line}</strong>
      </p>
      <p className="mt-1" style={{ color: 'var(--muted)' }}>
        Das Foto oder die Datei wird dieser Zahlung zugeordnet.{' '}
        <Link href="/app" className="underline" style={{ color: 'var(--accent)' }}>
          Ohne Zuordnung hochladen
        </Link>
      </p>
    </div>
  );
}
