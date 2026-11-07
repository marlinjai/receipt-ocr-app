'use client';

import { useRef, useState } from 'react';
import type { AssignmentRunResult } from '@/lib/assignment/pass';

/** What the runs so far did, summed. */
interface Progress {
  set: number;
  suggested: number;
  failed: number;
  remaining: number | null;
}

const EMPTY: Progress = { set: 0, suggested: 0, failed: 0, remaining: null };

function errorText(status: number): string {
  if (status === 401) return 'Die Anmeldung ist abgelaufen. Bitte die Seite neu laden und neu anmelden.';
  if (status === 403) return 'Für diesen Arbeitsbereich fehlt die Berechtigung zum Ändern.';
  return 'Der Lauf ist fehlgeschlagen. Was schon entschieden ist, bleibt; ein neuer Lauf macht weiter.';
}

/**
 * "Zuordnungen entscheiden" (plan 2026-11-07-learned-assignment): decides who
 * bears each receipt of the active company whose assignment is open, with the
 * model that learns the person, a bounded run per request, until none is left.
 * Confident answers are set and marked as automatic; the rest stay in "Belege
 * prüfen" with the model's suggestion. A second run changes nothing decided.
 */
export default function AssignmentsPanel() {
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
        const response = await fetch('/api/receipts/assignments', { method: 'POST' });
        const body = (await response.json().catch(() => ({}))) as { result?: AssignmentRunResult };
        if (!response.ok || !body.result) {
          setError(errorText(response.status));
          break;
        }
        const r = body.result;
        const before = total.remaining;
        total = { set: total.set + r.set, suggested: total.suggested + r.suggested, failed: total.failed + r.failed, remaining: r.remaining };
        setProgress(total);
        if (r.unavailable) {
          setError('Kein Sprachmodell erreichbar: Es wurde nichts zugeordnet. Ein neuer Lauf macht weiter, sobald es wieder erreichbar ist.');
          break;
        }
        if (r.remaining === 0) {
          setDone(true);
          break;
        }
        // A run that left as many as before made no progress: the page stops asking, the next run tries again.
        if (before !== null && r.remaining >= before) {
          setError('Die letzten Belege konnten gerade nicht entschieden werden. Ein neuer Lauf, später oder morgen der tägliche, versucht es erneut.');
          break;
        }
        if (stop.current) break;
      }
    } catch {
      setError('Keine Verbindung zum Server. Was schon entschieden ist, bleibt; ein neuer Lauf macht weiter.');
    } finally {
      setRunning(false);
    }
  };

  const started = progress.remaining !== null;

  return (
    <div>
      <p className="text-sm mb-3" style={{ color: 'var(--dt-text-secondary)' }}>
        Entscheidet für jeden Beleg dieser Firma ohne Zuordnung, wer ihn trägt: geschäftlich, Universität oder privat. Das Sprachmodell kennt deine Aussagen über dich (unter Regeln), wie du bisher zugeordnet hast und wo du es korrigiert hast. Ist es sicher, wird die Zuordnung gesetzt und am Beleg als „Automatisch zugeordnet“ mit Grund gezeigt, mit einem Klick änderbar. Sonst fragt „Belege prüfen“ weiter, mit dem Vorschlag des Modells. Bewirtungen, Regeln und Entscheidungen unter Finanzen bleiben, wie sie sind. Läuft nach jedem Hochladen von selbst.
      </p>
      <div className="flex gap-2">
        <button type="button" onClick={() => void run()} disabled={running} className="ui-btn ui-btn-primary">
          {running ? 'Entscheidet …' : started ? 'Weiter entscheiden' : 'Zuordnungen entscheiden'}
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
            Automatisch zugeordnet: {progress.set}, mit Vorschlag offen: {progress.suggested}, nicht beantwortet: {progress.failed}, noch offen: {progress.remaining}.
            {done && ' Alle offenen Belege sind angesehen.'}
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
