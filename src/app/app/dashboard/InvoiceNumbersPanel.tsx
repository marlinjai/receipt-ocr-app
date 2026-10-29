'use client';

import { useRef, useState } from 'react';
import type { InvoiceNumberBackfillResult } from '@/lib/review/invoice-number-backfill';

/** What the runs so far did, summed. */
interface Progress {
  looked: number;
  found: number;
  merged: number;
  remaining: number | null;
}

const EMPTY: Progress = { looked: 0, found: 0, merged: 0, remaining: null };

function errorText(status: number): string {
  if (status === 401) return 'Die Anmeldung ist abgelaufen. Bitte die Seite neu laden und neu anmelden.';
  if (status === 403) return 'Für diesen Arbeitsbereich fehlt die Berechtigung zum Ändern.';
  return 'Der Lauf ist fehlgeschlagen. Was schon gelesen wurde, bleibt; ein neuer Lauf macht weiter.';
}

/**
 * "Rechnungsnummern lesen" (plan 2026-10-29-invoice-number-duplicates,
 * decision 12): reads the invoice number of the stored receipts of the active
 * company from their stored text, a batch per request, until none is left,
 * then the app archives what is the same receipt into the more complete one.
 * No model is asked. The receipts are chosen on the server.
 */
export default function InvoiceNumbersPanel({ onMerged }: { /** Reload the table when receipts were archived. */ onMerged?: () => void }) {
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
        const response = await fetch('/api/receipts/invoice-numbers', { method: 'POST' });
        const body = (await response.json().catch(() => ({}))) as { result?: InvoiceNumberBackfillResult };
        if (!response.ok || !body.result) {
          setError(errorText(response.status));
          break;
        }
        const r = body.result;
        const before = total.remaining;
        total = { looked: total.looked + r.looked, found: total.found + r.found, merged: total.merged + r.merged, remaining: r.remaining };
        setProgress(total);
        if (r.remaining === 0) {
          setDone(true);
          break;
        }
        // A run that left as many as before made no progress: the page stops asking, the next run tries again.
        if (before !== null && r.remaining >= before) {
          setError('Die letzten Belege konnten nicht gelesen werden. Ein neuer Lauf, später oder morgen der tägliche, versucht es erneut.');
          break;
        }
        if (stop.current) break;
      }
    } catch {
      setError('Keine Verbindung zum Server. Was schon gelesen wurde, bleibt; ein neuer Lauf macht weiter.');
    } finally {
      setRunning(false);
      if (total.merged > 0) onMerged?.();
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
          <path d="M4 9h16M4 15h16M10 3 8 21M16 3l-2 18" />
        </svg>
        Rechnungsnummern lesen
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-2 z-20 w-80 max-w-[calc(100vw-2rem)] rounded-lg p-4 shadow-xl" style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}>
          <p className="text-xs mb-3" style={{ color: 'var(--dt-text-secondary)' }}>
            Liest die Rechnungsnummer der Belege dieser Firma aus ihrem gespeicherten Text, wo sie noch fehlt. Belege desselben Händlers mit derselben Nummer, oder mit genau derselben Datei, sind ein Beleg: Der vollständigere bleibt, der andere wird archiviert und lässt sich am bleibenden wiederherstellen. Läuft auch jeden Tag von selbst.
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => void run()}
              disabled={running}
              className="flex-1 px-3 py-2 text-sm font-medium rounded-lg bg-blue-600 text-white hover:bg-blue-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {running ? 'Liest …' : started ? 'Weiter lesen' : 'Rechnungsnummern lesen'}
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
                Angesehen: {progress.looked}, davon mit Nummer: {progress.found}, als doppelt archiviert: {progress.merged}, noch offen: {progress.remaining}.
                {done && ' Alle Belege sind angesehen.'}
              </p>
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
