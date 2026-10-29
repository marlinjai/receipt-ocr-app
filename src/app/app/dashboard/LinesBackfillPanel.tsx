'use client';

import { useRef, useState } from 'react';
import type { LinesBackfillResult } from '@/lib/line-items/backfill';

/** What the runs so far did, summed. */
interface Progress {
  read: number;
  addUp: number;
  differ: number;
  noLines: number;
  failed: number;
  remaining: number | null;
  noText: Array<{ rowId: string; name: string }>;
}

const EMPTY: Progress = { read: 0, addUp: 0, differ: 0, noLines: 0, failed: 0, remaining: null, noText: [] };

/** What went wrong with a run, in words a person can act on. */
function errorText(status: number, error: unknown): string {
  if (status === 401) return 'Die Anmeldung ist abgelaufen. Bitte die Seite neu laden und neu anmelden.';
  if (status === 403) return 'Für diesen Arbeitsbereich fehlt die Berechtigung zum Ändern.';
  if (error === 'model_unavailable') return 'Es ist kein Sprachmodell eingerichtet: Die Positionen können gerade nicht gelesen werden. An den Belegen wurde nichts geändert.';
  return 'Der Lauf ist fehlgeschlagen. Was schon gelesen wurde, bleibt; ein neuer Lauf macht weiter.';
}

/**
 * "Positionen lesen" (plan 2026-10-26-receipt-line-items, decision 5): reads
 * the lines of the stored receipts of the active company from their stored
 * text, a batch per request, until none is left, a batch makes no progress,
 * or the person stops it. The receipts are chosen on the server.
 */
export default function LinesBackfillPanel() {
  const [open, setOpen] = useState(false);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<Progress>(EMPTY);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const stop = useRef(false);

  const run = async () => {
    setRunning(true);
    setError(null);
    setDone(false);
    stop.current = false;
    let total: Progress = EMPTY;
    setProgress(EMPTY);
    try {
      for (;;) {
        const response = await fetch('/api/receipts/lines', { method: 'POST' });
        const body = (await response.json().catch(() => ({}))) as { result?: LinesBackfillResult; error?: unknown };
        if (!response.ok || !body.result) {
          setError(errorText(response.status, body.error));
          break;
        }
        const r = body.result;
        const before = total.remaining;
        total = {
          read: total.read + r.read,
          addUp: total.addUp + r.addUp,
          differ: total.differ + r.differ,
          noLines: total.noLines + r.noLines,
          failed: total.failed + r.failed,
          remaining: r.remaining,
          noText: r.noText,
        };
        setProgress(total);
        if (r.remaining === 0) {
          setDone(true);
          break;
        }
        // A batch that left as many as before made no progress, and one where more failed than were read
        // means the provider is struggling: the page stops asking, and the next run tries again.
        if ((before !== null && r.remaining >= before) || r.failed > r.read + r.noLines) {
          setError('Die letzten Belege konnten nicht gelesen werden. Ein neuer Lauf, später oder morgen der tägliche, versucht es erneut.');
          break;
        }
        if (stop.current) break;
      }
    } catch {
      setError('Keine Verbindung zum Server. Was schon gelesen wurde, bleibt; ein neuer Lauf macht weiter.');
    } finally {
      setRunning(false);
    }
  };

  const started = progress.remaining !== null;

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium rounded-lg transition-all duration-200 max-sm:min-h-11 max-sm:w-full max-sm:justify-start"
        style={{
          background: open ? 'var(--accent-muted)' : 'var(--surface)',
          color: open ? 'var(--accent)' : 'var(--foreground)',
          border: `1px solid ${open ? 'rgba(226, 163, 72, 0.4)' : 'var(--border)'}`,
        }}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" />
        </svg>
        Positionen lesen
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-2 z-20 w-80 max-w-[calc(100vw-2rem)] rounded-lg p-4 shadow-xl" style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}>
          <p className="text-xs mb-3" style={{ color: 'var(--dt-text-secondary)' }}>
            Liest die einzelnen Positionen der Belege dieser Firma, die noch keine haben, aus ihrem gespeicherten Text. Am Beleg selbst ändert sich nichts. Jeder Beleg wird einmal gelesen; ein Teil läuft auch jeden Tag von selbst.
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => void run()}
              disabled={running}
              className="flex-1 px-3 py-2 text-sm font-medium rounded-lg bg-blue-600 text-white hover:bg-blue-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {running ? 'Liest …' : started ? 'Weiter lesen' : 'Positionen lesen'}
            </button>
            {running && (
              <button type="button" onClick={() => (stop.current = true)} className="ui-btn ui-btn-sm">
                Anhalten
              </button>
            )}
          </div>
          <div aria-live="polite">
            {started && (
              <p className="text-xs mt-3" style={{ color: 'var(--dt-text-secondary)' }}>
                Gelesen: {progress.read} ({progress.addUp} stimmen mit dem Gesamtbetrag, {progress.differ} mit Differenz), ohne Positionen: {progress.noLines}, fehlgeschlagen: {progress.failed}, noch offen: {progress.remaining}.
                {done && ' Alle Belege sind gelesen.'}
              </p>
            )}
            {progress.noText.length > 0 && (
              <div className="text-xs mt-2" style={{ color: 'var(--dt-text-secondary)' }}>
                <p>Ohne gespeicherten Text, daher ohne Positionen ({progress.noText.length}). „Seite neu lesen“ am Beleg liest sie von der Seite:</p>
                <ul className="mt-1 max-h-32 list-disc overflow-y-auto pl-4">
                  {progress.noText.map((r) => (
                    <li key={r.rowId}>{r.name}</li>
                  ))}
                </ul>
              </div>
            )}
            {error && (
              <p className="text-xs mt-2" role="alert" style={{ color: '#f87171' }}>
                {error}
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
