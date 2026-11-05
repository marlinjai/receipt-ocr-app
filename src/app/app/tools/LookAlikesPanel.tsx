'use client';

import { useRef, useState } from 'react';
import type { LookAlikeResult } from '@/lib/review/look-alikes';

/** What the runs so far did, summed. */
interface Progress {
  numbersFound: number;
  merged: number;
  keptApart: number;
  unsure: number;
  remaining: number | null;
}

const EMPTY: Progress = { numbersFound: 0, merged: 0, keptApart: 0, unsure: 0, remaining: null };

function errorText(status: number): string {
  if (status === 401) return 'Die Anmeldung ist abgelaufen. Bitte die Seite neu laden und neu anmelden.';
  if (status === 403) return 'Für diesen Arbeitsbereich fehlt die Berechtigung zum Ändern.';
  return 'Der Lauf ist fehlgeschlagen. Was schon geklärt ist, bleibt; ein neuer Lauf macht weiter.';
}

/**
 * "Duplikate klären" (plan 2026-11-05-duplicates-without-asking): settles the
 * look-alike pairs of the active company that "Belege prüfen" would ask about,
 * a bounded run per request, until none is left. The missing invoice numbers
 * are read again first; where no number decides, the language model compares
 * both pages. The pairs are chosen on the server; the same pass runs daily.
 */
export default function LookAlikesPanel() {
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
        const response = await fetch('/api/receipts/look-alikes', { method: 'POST' });
        const body = (await response.json().catch(() => ({}))) as { result?: LookAlikeResult };
        if (!response.ok || !body.result) {
          setError(errorText(response.status));
          break;
        }
        const r = body.result;
        const before = total.remaining;
        total = {
          numbersFound: total.numbersFound + r.numbersFound,
          merged: total.merged + r.mergedByNumber + r.mergedByModel,
          keptApart: total.keptApart + r.keptApartByNumber + r.keptApartByModel,
          unsure: total.unsure + r.unsure,
          remaining: r.remaining,
        };
        setProgress(total);
        if (r.unavailable) {
          setError('Kein Sprachmodell erreichbar: Die Nummern aus Text und Dateiname sind gelesen, der Rest wartet auf den nächsten Lauf.');
          break;
        }
        if (r.remaining === 0) {
          setDone(true);
          break;
        }
        // A run that left as many as before made no progress: the page stops asking, the next run tries again.
        if (before !== null && r.remaining >= before) {
          setError('Die letzten Paare konnten gerade nicht geklärt werden. Ein neuer Lauf, später oder morgen der tägliche, versucht es erneut.');
          break;
        }
        if (stop.current) break;
      }
    } catch {
      setError('Keine Verbindung zum Server. Was schon geklärt ist, bleibt; ein neuer Lauf macht weiter.');
    } finally {
      setRunning(false);
    }
  };

  const started = progress.remaining !== null;

  return (
    <div>
      <p className="text-sm mb-3" style={{ color: 'var(--dt-text-secondary)' }}>
        Klärt die möglichen Duplikate dieser Firma, die „Belege prüfen“ sonst fragt: Fehlende Rechnungsnummern werden aus Text, Dateiname und Seite nachgelesen; wo keine Nummer entscheidet, vergleicht das Sprachmodell beide Seiten. Derselbe Kauf wird zusammengeführt (am bleibenden Beleg wiederherstellbar), zwei Käufe bleiben beide. Was offen bleibt, steht mit Grund in „Belege prüfen“. Läuft auch jeden Tag und nach jedem Hochladen von selbst.
      </p>
      <div className="flex gap-2">
        <button type="button" onClick={() => void run()} disabled={running} className="ui-btn ui-btn-primary">
          {running ? 'Klärt …' : started ? 'Weiter klären' : 'Duplikate klären'}
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
            Nummern nachgelesen: {progress.numbersFound}, zusammengeführt: {progress.merged}, als zwei Käufe behalten: {progress.keptApart}, nicht geklärt: {progress.unsure}, noch offen: {progress.remaining}.
            {done && ' Alle Paare sind angesehen.'}
          </p>
        )}
        {error && (
          <p className="text-xs mt-2" role="alert" style={{ color: '#f87171' }}>
            {error}
          </p>
        )}
      </div>
    </div>
  );
}
