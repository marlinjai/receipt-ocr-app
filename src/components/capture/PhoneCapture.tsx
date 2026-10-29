'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import MealPanelSection from '@/components/meals/MealPanelSection';
import BottomSheet from '@/components/ui/BottomSheet';
import ConfirmDialog from '@/components/ui/ConfirmDialog';
import { drainQueue, singleFlight, type DrainResult } from '@/lib/capture/drain';
import { captureErrorText } from '@/lib/capture/messages';
import { newQueuedCapture, openCaptureStore, type CaptureStore, type QueuedCapture } from '@/lib/capture/offline-queue';
import { createBrowserDeps, type SaveReceipt } from '@/lib/upload/browser-deps';
import { uploadFailureKind } from '@/lib/upload/errors';
import { runUploadPipeline, type PipelineOutcome, type PipelinePhase } from '@/lib/upload/pipeline';
import { receiptHref } from '@/lib/receipt-link';

type Done = Extract<PipelineOutcome, { kind: 'done' }>;

interface PhoneCaptureProps {
  /**
   * The company photos taken now go into. A photo put aside in the queue keeps
   * the company it was taken for and is sent there later, whatever this says by then.
   */
  workspaceId: string;
  /** Save a recognized photo as a new receipt. */
  onSave: SaveReceipt;
  /** Read a new photo into an EXISTING receipt (retake). */
  onRetake: (rowId: string) => SaveReceipt;
  /** Delete a receipt that was just created (the user discarded a look-alike). */
  onDiscardRow: (rowId: string) => Promise<void>;
  /** Injected in tests; the real IndexedDB queue otherwise. */
  store?: CaptureStore;
  /** Shown once after a share into the app (see sharedNotice). */
  notice?: { tone: 'info' | 'error'; text: string } | null;
  /** The company the dashboard shows: a receipt that is already there is linked only when it is in that one. */
  activeWorkspaceId?: string;
}

type View =
  | { kind: 'idle' }
  | { kind: 'working'; phase: PipelinePhase; progress: number; fileName: string }
  | { kind: 'saved'; outcome: Done; retaken: boolean }
  | { kind: 'duplicate'; outcome: Extract<PipelineOutcome, { kind: 'duplicate' }>; workspaceId: string }
  | { kind: 'queued'; reason: 'offline' | 'auth' }
  | { kind: 'error'; message: string; file: File; retakeRowId: string | null };

const PHASE_LABELS: Record<PipelinePhase, string> = {
  checking: 'Foto wird vorbereitet',
  uploading: 'Foto wird hochgeladen',
  ocr: 'Text wird gelesen',
  saving: 'Beleg wird eingeordnet',
};

/**
 * Photograph a receipt on the phone and have it filed.
 *
 * One photo at a time: capture, read, file, and (for a business meal) ask for
 * guests and occasion straight away. Nothing redirects while capturing. A
 * photo that cannot be sent right now (no connection, session expired) goes
 * into a queue in the browser and is sent later, visibly counted. Every
 * failure says what happened and offers the next step.
 */
export default function PhoneCapture({ workspaceId, onSave, onRetake, onDiscardRow, store: injectedStore, notice, activeWorkspaceId }: PhoneCaptureProps) {
  const cameraRef = useRef<HTMLInputElement>(null);
  const retakeRef = useRef<HTMLInputElement>(null);
  const [view, setView] = useState<View>({ kind: 'idle' });
  const [waiting, setWaiting] = useState<QueuedCapture[]>([]);
  // Photos the server already has but whose entry could not be removed are not "waiting to be sent".
  const pending = waiting.filter((w) => w.sentAt === null);
  const [queueNote, setQueueNote] = useState<string | null>(null);
  const [queueBroken, setQueueBroken] = useState(false);
  const [draining, setDraining] = useState(false);
  const [mealRowId, setMealRowId] = useState<string | null>(null);
  const [discarding, setDiscarding] = useState(false);
  const [removing, setRemoving] = useState<QueuedCapture | null>(null);

  const store = useMemo<CaptureStore | null>(() => {
    if (injectedStore) return injectedStore;
    try {
      return typeof indexedDB === 'undefined' ? null : openCaptureStore();
    } catch {
      return null;
    }
  }, [injectedStore]);

  const callbacks = useRef({ onSave, onRetake, onDiscardRow, workspaceId });
  useEffect(() => {
    callbacks.current = { onSave, onRetake, onDiscardRow, workspaceId };
  }, [onSave, onRetake, onDiscardRow, workspaceId]);

  const refreshWaiting = useCallback(async () => {
    if (!store) return;
    try {
      setWaiting(await store.list());
    } catch {
      setQueueBroken(true);
    }
  }, [store]);

  /** Put a photo aside for later. False when the browser cannot store it. */
  const enqueue = useCallback(
    async (file: File): Promise<boolean> => {
      if (!store) return false;
      try {
        await store.add(newQueuedCapture(file, 'camera', Date.now(), callbacks.current.workspaceId));
        await refreshWaiting();
        return true;
      } catch {
        setQueueBroken(true);
        return false;
      }
    },
    [store, refreshWaiting],
  );

  const drainOnce = useCallback(async (): Promise<DrainResult | null> => {
    if (!store) return null;
    setDraining(true);
    try {
      const save: SaveReceipt = (file, ocr, options) => callbacks.current.onSave(file, ocr, options);
      // A photo goes to the company it was taken for. Only entries that do not
      // know one (shared into the app, or taken on the offline page) go to the
      // company this page shows now.
      const result = await drainQueue(
        store,
        (file, entry) => runUploadPipeline(file, createBrowserDeps(save, entry.workspaceId ?? callbacks.current.workspaceId)),
        { isOnline: () => navigator.onLine },
      );
      const saved = result.sent.filter((s) => s.outcome.kind === 'done').length;
      const known = result.sent.length - saved;
      const meals = result.sent.filter((s) => s.outcome.kind === 'done' && s.outcome.isMeal).length;
      const elsewhere = [...new Set(result.sent.flatMap((s) => (s.outcome.kind === 'done' ? s.outcome.elsewhere : [])))];
      const parts: string[] = [];
      if (saved > 0) parts.push(saved === 1 ? '1 wartendes Foto wurde gesendet.' : `${saved} wartende Fotos wurden gesendet.`);
      if (known > 0) parts.push(known === 1 ? '1 Beleg war schon da und wurde nicht doppelt angelegt.' : `${known} Belege waren schon da und wurden nicht doppelt angelegt.`);
      if (elsewhere.length > 0) parts.push(`Mindestens ein gesendetes Foto liegt genau so schon in deiner Firma ${elsewhere.join(', ')}: bitte im Dashboard prüfen.`);
      if (meals > 0) parts.push(meals === 1 ? '1 Bewirtung wartet auf Teilnehmer und Anlass.' : `${meals} Bewirtungen warten auf Teilnehmer und Anlass.`);
      if (result.stopped === 'auth') parts.push('Die Anmeldung ist abgelaufen: bitte neu anmelden, die Fotos bleiben gespeichert.');
      if (result.stopped === 'offline' && result.remaining > 0) parts.push('Keine Verbindung: der Rest wird später gesendet.');
      if (result.failed > 0) parts.push(result.failed === 1 ? '1 Foto konnte nicht verarbeitet werden.' : `${result.failed} Fotos konnten nicht verarbeitet werden.`);
      if (result.stuck > 0) {
        parts.push(
          result.stuck === 1
            ? '1 gesendetes Foto konnte nicht aus der Warteschlange entfernt werden. Es wird nicht erneut gesendet.'
            : `${result.stuck} gesendete Fotos konnten nicht aus der Warteschlange entfernt werden. Sie werden nicht erneut gesendet.`,
        );
      }
      setQueueNote(parts.length > 0 ? parts.join(' ') : null);
      return result;
    } catch {
      setQueueBroken(true);
      return null;
    } finally {
      setDraining(false);
      await refreshWaiting();
    }
  }, [store, refreshWaiting]);
  // One drain at a time: a second call while one runs joins it instead of sending twice. The single-flight
  // wrapper is made on the first call, never while rendering, and anew when the drain itself changes.
  const drainFlight = useRef<{ work: typeof drainOnce; run: () => Promise<DrainResult | null> } | null>(null);
  const drain = useCallback(() => {
    if (drainFlight.current?.work !== drainOnce) drainFlight.current = { work: drainOnce, run: singleFlight(drainOnce) };
    return drainFlight.current.run();
  }, [drainOnce]);

  // Send what is waiting when the page opens and whenever the connection returns.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      await refreshWaiting();
      if (cancelled || !store) return;
      const list = await store.list().catch(() => []);
      if (list.length > 0 && navigator.onLine) void drain();
    })();
    const onOnline = () => void drain();
    window.addEventListener('online', onOnline);
    return () => {
      cancelled = true;
      window.removeEventListener('online', onOnline);
    };
  }, [store, drain, refreshWaiting]);

  const run = useCallback(
    async (file: File, options: { retakeRowId?: string } = {}) => {
      const retakeRowId = options.retakeRowId ?? null;
      setQueueNote(null);

      // No connection: do not even try. A retake needs the row and stays in memory instead.
      if (!navigator.onLine && !retakeRowId) {
        if (await enqueue(file)) setView({ kind: 'queued', reason: 'offline' });
        else setView({ kind: 'error', file, retakeRowId, message: 'Keine Verbindung, und dieser Browser kann das Foto nicht zwischenspeichern. Bitte mit Verbindung erneut versuchen.' });
        return;
      }

      setView({ kind: 'working', phase: 'checking', progress: 0, fileName: file.name });
      const save: SaveReceipt = retakeRowId
        ? callbacks.current.onRetake(retakeRowId)
        : (f, ocr, o) => callbacks.current.onSave(f, ocr, o);
      try {
        const outcome = await runUploadPipeline(file, createBrowserDeps(save, callbacks.current.workspaceId), {
          onPhase: (phase) => setView((v) => (v.kind === 'working' ? { ...v, phase } : v)),
          onProgress: (progress) => setView((v) => (v.kind === 'working' ? { ...v, progress } : v)),
        });
        if (outcome.kind === 'duplicate') {
          setView({ kind: 'duplicate', outcome, workspaceId: callbacks.current.workspaceId });
          return;
        }
        setView({ kind: 'saved', outcome, retaken: Boolean(retakeRowId) });
        // A well-read business meal: ask for guests and occasion right away.
        if (outcome.isMeal && !outcome.attention && !outcome.similar && outcome.elsewhere.length === 0) setMealRowId(outcome.rowId);
      } catch (err) {
        const kind = uploadFailureKind(err);
        if ((kind === 'network' || kind === 'auth') && !retakeRowId && (await enqueue(file))) {
          setView({ kind: 'queued', reason: kind === 'auth' ? 'auth' : 'offline' });
          return;
        }
        setView({
          kind: 'error',
          file,
          retakeRowId,
          message:
            kind === 'network'
              ? 'Keine Verbindung zum Server.'
              : kind === 'auth'
                ? 'Die Anmeldung ist abgelaufen. Bitte die Seite neu laden und erneut anmelden.'
                : captureErrorText(err instanceof Error ? err.message : null),
        });
      }
    },
    [enqueue],
  );

  const pick = (e: React.ChangeEvent<HTMLInputElement>, retakeRowId?: string) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (file) void run(file, { retakeRowId });
  };

  const discard = async (rowId: string) => {
    setDiscarding(true);
    try {
      await callbacks.current.onDiscardRow(rowId);
      setView({ kind: 'idle' });
      setQueueNote('Der neue Beleg wurde verworfen, der vorhandene bleibt.');
    } catch {
      setQueueNote('Der neue Beleg konnte nicht verworfen werden. Er steht weiter im Dashboard und kann dort gelöscht werden.');
    } finally {
      setDiscarding(false);
    }
  };

  /** Drop one waiting photo for good (a file that keeps failing would otherwise wait forever). */
  const removeWaiting = async (entry: QueuedCapture) => {
    setRemoving(null);
    if (!store) return;
    try {
      await store.remove(entry.id);
      setQueueNote(`„${entry.name}“ wurde aus der Warteschlange entfernt.`);
    } catch {
      setQueueBroken(true);
    }
    await refreshWaiting();
  };

  const busy = view.kind === 'working';
  const saved = view.kind === 'saved' ? view.outcome : null;
  const retakeRowId = saved?.rowId ?? (view.kind === 'error' ? view.retakeRowId : null);

  return (
    <section className="glass-panel rounded-xl p-4 sm:p-5" aria-label="Beleg fotografieren" data-theme="dark">
      <input ref={cameraRef} type="file" accept="image/*" capture="environment" className="hidden" onChange={(e) => pick(e)} />
      <input
        ref={retakeRef}
        type="file"
        accept="image/*"
        capture="environment"
        className="hidden"
        onChange={(e) => pick(e, retakeRowId ?? undefined)}
      />

      {notice && (
        <p className={`ui-note mb-3 ${notice.tone === 'error' ? 'ui-note-danger' : 'ui-note-ok'}`} role={notice.tone === 'error' ? 'alert' : 'status'}>
          {notice.text}
        </p>
      )}

      {view.kind === 'idle' && (
        <div className="text-center">
          <button type="button" className="ui-btn ui-btn-primary w-full sm:w-auto" style={{ minHeight: '3rem' }} onClick={() => cameraRef.current?.click()}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M4 8h3l1.5-2h7L17 8h3a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z" />
              <circle cx="12" cy="13" r="3.5" />
            </svg>
            Foto aufnehmen
          </button>
          <p className="mt-2 text-xs" style={{ color: 'var(--muted)' }}>
            Beleg fotografieren: er wird gelesen und eingeordnet. Bei einer Bewirtung folgt die Frage nach Teilnehmern
            und Anlass.
          </p>
        </div>
      )}

      {view.kind === 'working' && (
        <div role="status" aria-live="polite">
          <p className="text-sm font-medium" style={{ color: 'var(--foreground)' }}>
            {PHASE_LABELS[view.phase]}…
          </p>
          <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full" style={{ background: 'var(--border)' }}>
            <div
              className="h-full rounded-full transition-[width] duration-200 ease-out"
              style={{
                background: 'var(--accent)',
                width: `${view.phase === 'checking' ? 8 : view.phase === 'uploading' ? 10 + view.progress * 0.5 : view.phase === 'ocr' ? 70 : 90}%`,
              }}
            />
          </div>
        </div>
      )}

      {view.kind === 'saved' && saved && (
        <div className="space-y-3">
          {saved.attention === 'ocr_failed' ? (
            <div className="ui-note ui-note-warn" role="alert">
              <p className="font-medium">Der Beleg ist gespeichert, konnte aber nicht gelesen werden.</p>
              <p className="mt-1">
                {saved.ocrError ? `Grund: ${captureErrorText(saved.ocrError)} ` : ''}
                Neu aufnehmen ersetzt das Foto auf demselben Beleg. Oder die Angaben später im Dashboard von Hand
                eintragen.
              </p>
            </div>
          ) : saved.attention === 'low_quality' ? (
            <div className="ui-note ui-note-warn" role="alert">
              <p className="font-medium">Gespeichert, aber schwer lesbar.</p>
              <p className="mt-1">
                Betrag oder Datum wurden nicht sicher erkannt, vermutlich ist das Foto unscharf. Neu aufnehmen ersetzt
                das Foto auf demselben Beleg.
              </p>
            </div>
          ) : (
            <p className="ui-note ui-note-ok" role="status">
              <span className="font-medium">{view.retaken ? 'Foto ersetzt und neu gelesen.' : 'Gespeichert.'}</span>{' '}
              Eingeordnet als: {saved.category ?? 'noch ohne Kategorie'}.
            </p>
          )}

          {saved.elsewhere.length > 0 && (
            <div className="ui-note ui-note-warn">
              <p>
                Genau diese Datei liegt schon in deiner Firma {saved.elsewhere.join(', ')}. Dieselbe Rechnung in zwei
                Firmen ist meist ein Versehen.
              </p>
              <div className="mt-2 flex flex-wrap gap-2">
                <button type="button" className="ui-btn ui-btn-sm" disabled={discarding} onClick={() => setView({ kind: 'saved', outcome: { ...saved, elsewhere: [] }, retaken: view.retaken })}>
                  Hier behalten
                </button>
                <button type="button" className="ui-btn ui-btn-sm ui-btn-danger" disabled={discarding} onClick={() => void discard(saved.rowId)}>
                  {discarding ? 'Wird verworfen…' : 'Hier verwerfen'}
                </button>
              </div>
            </div>
          )}

          {saved.similar && (
            <div className="ui-note ui-note-warn">
              <p>
                Das sieht nach einem Beleg aus, den es schon gibt: „{saved.similar.name}“ hat denselben Anbieter,
                dasselbe Datum und denselben Betrag.
              </p>
              <div className="mt-2 flex flex-wrap gap-2">
                <button type="button" className="ui-btn ui-btn-sm" disabled={discarding} onClick={() => setView({ kind: 'saved', outcome: { ...saved, similar: null }, retaken: view.retaken })}>
                  Beide behalten
                </button>
                <button type="button" className="ui-btn ui-btn-sm ui-btn-danger" disabled={discarding} onClick={() => void discard(saved.rowId)}>
                  {discarding ? 'Wird verworfen…' : 'Neuen verwerfen'}
                </button>
              </div>
            </div>
          )}

          <div className="flex flex-wrap gap-2">
            <button type="button" className="ui-btn ui-btn-primary" onClick={() => { setView({ kind: 'idle' }); cameraRef.current?.click(); }}>
              Nächstes Foto
            </button>
            {saved.attention && (
              <button type="button" className="ui-btn" onClick={() => retakeRef.current?.click()}>
                Neu aufnehmen
              </button>
            )}
            {saved.isMeal && (
              <button type="button" className="ui-btn" onClick={() => setMealRowId(saved.rowId)}>
                Teilnehmer und Anlass eintragen
              </button>
            )}
          </div>
        </div>
      )}

      {view.kind === 'duplicate' && (
        <div className="space-y-3">
          <p className="ui-note ui-note-warn" role="status">
            {view.outcome.reason === 'same_file'
              ? `Diesen Beleg gibt es schon: Genau dieses Foto ist beim Beleg „${view.outcome.existing.name}“ hinterlegt. Es wurde kein zweiter Beleg angelegt.`
              : `Diesen Beleg gibt es schon: „${view.outcome.existing.name}“ ist dieselbe Rechnung${view.outcome.invoiceNumber ? ` (Nummer ${view.outcome.invoiceNumber})` : ''}. Es wurde kein zweiter Beleg angelegt${view.outcome.fileAdded ? ', das Foto hängt jetzt dort mit dran' : ''}.`}
          </p>
          <div className="flex flex-wrap gap-2">
            <button type="button" className="ui-btn ui-btn-primary" onClick={() => { setView({ kind: 'idle' }); cameraRef.current?.click(); }}>
              Nächstes Foto
            </button>
            {view.workspaceId === activeWorkspaceId && (
              <a className="ui-btn" href={receiptHref(view.outcome.existing.rowId)}>
                Beleg öffnen
              </a>
            )}
          </div>
        </div>
      )}

      {view.kind === 'queued' && (
        <div className="space-y-3">
          <p className="ui-note ui-note-warn" role="status">
            {view.reason === 'auth'
              ? 'Die Anmeldung ist abgelaufen. Das Foto ist auf diesem Gerät gespeichert und wird nach der nächsten Anmeldung gesendet.'
              : 'Keine Verbindung. Das Foto ist auf diesem Gerät gespeichert und wird gesendet, sobald die Verbindung zurück ist.'}
          </p>
          <div className="flex flex-wrap gap-2">
            <button type="button" className="ui-btn ui-btn-primary" onClick={() => { setView({ kind: 'idle' }); cameraRef.current?.click(); }}>
              Nächstes Foto
            </button>
            {view.reason === 'auth' && (
              // A full navigation: the middleware sends an expired session to the login and back here.
              <a className="ui-btn" href="/app">
                Neu anmelden
              </a>
            )}
          </div>
        </div>
      )}

      {view.kind === 'error' && (
        <div className="space-y-3">
          <p className="ui-note ui-note-danger" role="alert">
            {view.message} {view.retakeRowId ? 'Der Beleg selbst ist unverändert gespeichert.' : 'Es wurde kein Beleg angelegt.'}
          </p>
          <div className="flex flex-wrap gap-2">
            <button type="button" className="ui-btn ui-btn-primary" onClick={() => void run(view.file, { retakeRowId: view.retakeRowId ?? undefined })}>
              Erneut versuchen
            </button>
            <button type="button" className="ui-btn" onClick={() => setView({ kind: 'idle' })}>
              Abbrechen
            </button>
          </div>
        </div>
      )}

      {/* The queue: always visible while anything waits, so nothing is silently pending. */}
      {(waiting.length > 0 || queueNote || queueBroken) && (
        <div className="mt-4 border-t pt-3" style={{ borderColor: 'var(--border)' }}>
          {pending.length > 0 && (
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-sm" style={{ color: 'var(--foreground)' }} role="status">
                {pending.length === 1 ? '1 Foto wartet auf den Versand.' : `${pending.length} Fotos warten auf den Versand.`}
              </p>
              <button type="button" className="ui-btn ui-btn-sm" disabled={draining || busy} onClick={() => void drain()}>
                {draining ? 'Wird gesendet…' : 'Jetzt senden'}
              </button>
            </div>
          )}
          {waiting.some((w) => w.lastError) && (
            <ul className="mt-2 space-y-1 text-xs" style={{ color: 'var(--muted)' }}>
              {waiting.filter((w) => w.lastError).map((w) => (
                <li key={w.id} className="flex items-center justify-between gap-2">
                  <span className="min-w-0 break-words">
                    {w.name}: {captureErrorText(w.lastError)}
                  </span>
                  <button
                    type="button"
                    className="ui-btn ui-btn-sm ui-btn-danger shrink-0"
                    disabled={draining}
                    aria-label={`${w.name} aus der Warteschlange entfernen`}
                    onClick={() => setRemoving(w)}
                  >
                    Entfernen
                  </button>
                </li>
              ))}
            </ul>
          )}
          {queueNote && (
            <p className="mt-2 text-xs" style={{ color: 'var(--muted)' }} role="status">
              {queueNote}{' '}
              {queueNote.includes('Bewirtung') && (
                <Link href="/app/meals" className="underline" style={{ color: 'var(--accent)' }}>
                  Zu den offenen Bewirtungen
                </Link>
              )}
            </p>
          )}
          {queueBroken && (
            <p className="mt-2 text-xs" style={{ color: 'var(--danger)' }} role="alert">
              Dieser Browser kann Fotos nicht zwischenspeichern (zum Beispiel im privaten Modus). Ohne Verbindung
              aufgenommene Fotos gehen dann verloren: bitte nur mit Verbindung aufnehmen.
            </p>
          )}
        </div>
      )}

      <ConfirmDialog
        open={removing !== null}
        title="Foto aus der Warteschlange entfernen?"
        confirmLabel="Entfernen"
        danger
        onCancel={() => setRemoving(null)}
        onConfirm={() => removing && void removeWaiting(removing)}
      >
        {removing && removing.sentAt === null && (
          <p>
            „{removing.name}“ wurde noch nicht gesendet und wird von diesem Gerät gelöscht. Der Beleg muss dann neu
            fotografiert werden.
          </p>
        )}
        {removing && removing.sentAt !== null && (
          <p>
            „{removing.name}“ wurde bereits gesendet und ist als Beleg gespeichert. Hier wird nur der Eintrag auf
            diesem Gerät entfernt.
          </p>
        )}
      </ConfirmDialog>

      <BottomSheet open={mealRowId !== null} title="Bewirtung: Teilnehmer und Anlass" onClose={() => setMealRowId(null)}>
        {mealRowId && (
          <MealPanelSection
            rowId={mealRowId}
            variant="sheet"
            secondaryAction={{ label: 'Später', onClick: () => setMealRowId(null) }}
            onCompleted={() => setMealRowId(null)}
          />
        )}
      </BottomSheet>
    </section>
  );
}
