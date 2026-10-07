'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import MealPanelSection from '@/components/meals/MealPanelSection';
import BottomSheet from '@/components/ui/BottomSheet';
import { drainQueue, singleFlight, type DrainResult } from '@/lib/capture/drain';
import { newQueuedCapture, openCaptureStore, type CaptureStore, type QueuedCapture } from '@/lib/capture/offline-queue';
import { createBrowserDeps, type SaveReceipt } from '@/lib/upload/browser-deps';
import { uploadFailureKind } from '@/lib/upload/errors';
import { runUploadPipeline, type ExistingReceiptRef, type PipelineOutcome, type PipelinePhase } from '@/lib/upload/pipeline';

type Done = Extract<PipelineOutcome, { kind: 'done' }>;

interface PhoneCaptureProps {
  /** Save a recognized photo as a new receipt. */
  onSave: SaveReceipt;
  /** Read a new photo into an EXISTING receipt (retake). */
  onRetake: (rowId: string) => SaveReceipt;
  /** Delete a receipt that was just created (the user discarded a look-alike). */
  onDiscardRow: (rowId: string) => Promise<void>;
  /** Injected in tests; the real IndexedDB queue otherwise. */
  store?: CaptureStore;
}

type View =
  | { kind: 'idle' }
  | { kind: 'working'; phase: PipelinePhase; progress: number; fileName: string }
  | { kind: 'saved'; outcome: Done; retaken: boolean }
  | { kind: 'duplicate'; existing: ExistingReceiptRef; file: File }
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
export default function PhoneCapture({ onSave, onRetake, onDiscardRow, store: injectedStore }: PhoneCaptureProps) {
  const cameraRef = useRef<HTMLInputElement>(null);
  const retakeRef = useRef<HTMLInputElement>(null);
  const [view, setView] = useState<View>({ kind: 'idle' });
  const [waiting, setWaiting] = useState<QueuedCapture[]>([]);
  const [queueNote, setQueueNote] = useState<string | null>(null);
  const [queueBroken, setQueueBroken] = useState(false);
  const [draining, setDraining] = useState(false);
  const [mealRowId, setMealRowId] = useState<string | null>(null);
  const [discarding, setDiscarding] = useState(false);

  const store = useMemo<CaptureStore | null>(() => {
    if (injectedStore) return injectedStore;
    try {
      return typeof indexedDB === 'undefined' ? null : openCaptureStore();
    } catch {
      return null;
    }
  }, [injectedStore]);

  const callbacks = useRef({ onSave, onRetake, onDiscardRow });
  useEffect(() => {
    callbacks.current = { onSave, onRetake, onDiscardRow };
  }, [onSave, onRetake, onDiscardRow]);

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
        await store.add(newQueuedCapture(file, 'camera'));
        await refreshWaiting();
        return true;
      } catch {
        setQueueBroken(true);
        return false;
      }
    },
    [store, refreshWaiting],
  );

  const drain = useMemo(
    () =>
      singleFlight(async (): Promise<DrainResult | null> => {
        if (!store) return null;
        setDraining(true);
        try {
          const deps = createBrowserDeps((file, ocr, options) => callbacks.current.onSave(file, ocr, options));
          const result = await drainQueue(store, (file) => runUploadPipeline(file, deps), {
            isOnline: () => navigator.onLine,
          });
          const saved = result.sent.filter((s) => s.outcome.kind === 'done').length;
          const known = result.sent.length - saved;
          const meals = result.sent.filter((s) => s.outcome.kind === 'done' && s.outcome.isMeal).length;
          const parts: string[] = [];
          if (saved > 0) parts.push(saved === 1 ? '1 wartendes Foto wurde gesendet.' : `${saved} wartende Fotos wurden gesendet.`);
          if (known > 0) parts.push(known === 1 ? '1 Foto war bereits vorhanden.' : `${known} Fotos waren bereits vorhanden.`);
          if (meals > 0) parts.push(meals === 1 ? '1 Bewirtung wartet auf Teilnehmer und Anlass.' : `${meals} Bewirtungen warten auf Teilnehmer und Anlass.`);
          if (result.stopped === 'auth') parts.push('Die Anmeldung ist abgelaufen: bitte neu anmelden, die Fotos bleiben gespeichert.');
          if (result.stopped === 'offline' && result.remaining > 0) parts.push('Keine Verbindung: der Rest wird später gesendet.');
          if (result.failed > 0) parts.push(result.failed === 1 ? '1 Foto konnte nicht verarbeitet werden.' : `${result.failed} Fotos konnten nicht verarbeitet werden.`);
          setQueueNote(parts.length > 0 ? parts.join(' ') : null);
          return result;
        } catch {
          setQueueBroken(true);
          return null;
        } finally {
          setDraining(false);
          await refreshWaiting();
        }
      }),
    [store, refreshWaiting],
  );

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
    async (file: File, options: { retakeRowId?: string; allowDuplicate?: boolean } = {}) => {
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
        const outcome = await runUploadPipeline(file, createBrowserDeps(save), {
          allowDuplicate: options.allowDuplicate,
          onPhase: (phase) => setView((v) => (v.kind === 'working' ? { ...v, phase } : v)),
          onProgress: (progress) => setView((v) => (v.kind === 'working' ? { ...v, progress } : v)),
        });
        if (outcome.kind === 'duplicate') {
          setView({ kind: 'duplicate', existing: outcome.existing, file });
          return;
        }
        setView({ kind: 'saved', outcome, retaken: Boolean(retakeRowId) });
        // A well-read business meal: ask for guests and occasion right away.
        if (outcome.isMeal && !outcome.attention && !outcome.similar) setMealRowId(outcome.rowId);
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
                : err instanceof Error && err.message
                  ? err.message
                  : 'Das Foto konnte nicht verarbeitet werden.',
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
                {saved.ocrError ? `Grund: ${saved.ocrError}. ` : ''}
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
            Genau dieses Foto ist schon beim Beleg „{view.existing.name}“ hinterlegt. Es wurde nichts hochgeladen.
          </p>
          <div className="flex flex-wrap gap-2">
            <button type="button" className="ui-btn ui-btn-primary" onClick={() => { setView({ kind: 'idle' }); cameraRef.current?.click(); }}>
              Nächstes Foto
            </button>
            <button type="button" className="ui-btn" onClick={() => void run(view.file, { allowDuplicate: true })}>
              Trotzdem hochladen
            </button>
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
          {waiting.length > 0 && (
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-sm" style={{ color: 'var(--foreground)' }} role="status">
                {waiting.length === 1 ? '1 Foto wartet auf den Versand.' : `${waiting.length} Fotos warten auf den Versand.`}
              </p>
              <button type="button" className="ui-btn ui-btn-sm" disabled={draining || busy} onClick={() => void drain()}>
                {draining ? 'Wird gesendet…' : 'Jetzt senden'}
              </button>
            </div>
          )}
          {waiting.some((w) => w.lastError) && (
            <ul className="mt-2 space-y-1 text-xs" style={{ color: 'var(--muted)' }}>
              {waiting.filter((w) => w.lastError).map((w) => (
                <li key={w.id}>
                  {w.name}: {w.lastError}
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
