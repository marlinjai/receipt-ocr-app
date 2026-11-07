'use client';

import type { BooksMirrorView } from '@/lib/tax/books-pull/service';
import { BOOKS_CONFLICT_LABELS, BOOKS_SKIP_LABELS, booksPullFailureMessage } from '@/lib/tax/books-pull/messages';

interface Props {
  /** Null while the state is being read. */
  mirror: BooksMirrorView | null;
  busy: boolean;
  onPull: () => void;
}

/** A moment in the business's time zone, as day and time. */
function formatMoment(iso: string): string {
  return new Intl.DateTimeFormat('de-DE', { timeZone: 'Europe/Berlin', dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso));
}

/**
 * The Books mirror in the "Einnahmen" tab: when the invoices of framer-clone's
 * Books were last pulled (by the schedule or by hand), what landed, every
 * document a person has to settle, or why the last pull failed; and the button
 * that pulls now. A failed or conflicted pull is shown here, never only logged.
 */
export default function BooksMirrorPanel({ mirror, busy, onPull }: Props) {
  const last = mirror?.last ?? null;
  const report = last?.report ?? null;
  const conflicts = last?.ok ? (report?.conflicts ?? []) : [];
  const skipped = last?.ok ? (report?.skipped ?? []) : [];

  return (
    <section className="glass-panel rounded-xl p-4 sm:p-5" aria-label="Rechnungen aus den Books">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-base font-semibold" style={{ color: 'var(--foreground)' }}>Rechnungen aus den Books</h2>
        <button type="button" className="ui-btn" disabled={busy || mirror === null || !mirror.configured} onClick={onPull}>
          Aus den Books abholen
        </button>
      </div>

      {mirror === null && <p className="ui-note mt-3">Stand wird gelesen …</p>}
      {mirror !== null && !mirror.configured && <p className="ui-note mt-3">{booksPullFailureMessage('not_configured')}</p>}
      {mirror !== null && mirror.configured && last === null && (
        <p className="ui-note mt-3">
          Noch nicht aus den Books abgeholt. Rechnungen, die in den Books gestellt werden, kommen regelmäßig von selbst hierher.
        </p>
      )}

      {last !== null && (
        <div className="mt-3 space-y-2 text-sm">
          <p style={{ color: 'var(--muted)' }}>
            Zuletzt {last.trigger === 'manual' ? 'von Hand' : 'automatisch'} abgeholt am {formatMoment(last.at)}
            {last.ok ? '.' : ', ohne Erfolg.'}
          </p>
          {!last.ok && (
            <p className="ui-note ui-note-danger" role="alert">
              {booksPullFailureMessage(last.error ?? '')}
              {last.successAt ? ` Zuletzt gelungen am ${formatMoment(last.successAt)}.` : ' Bisher ist noch kein Abruf gelungen.'}
            </p>
          )}
          {last.ok && report && (
            <p style={{ color: 'var(--foreground)' }}>
              {report.created} neu, {report.attached} einer hier erfassten Rechnung zugeordnet, {report.updated} geändert,{' '}
              {report.unchanged} unverändert
              {report.paymentsMoved > 0 ? `, ${report.paymentsMoved} Zahlungen auf Ersatzrechnungen umgezogen` : ''}.
            </p>
          )}
          {conflicts.length > 0 && (
            <div className="ui-note ui-note-danger" role="alert">
              <p>
                {conflicts.length === 1 ? 'Eine Rechnung wurde' : `${conflicts.length} Rechnungen wurden`} nicht übernommen, weil
                eine Entscheidung von dir nötig ist:
              </p>
              <ul className="mt-1 list-disc pl-5">
                {conflicts.map((c) => (
                  <li key={`${c.number}-${c.reason}`}>
                    Rechnung {c.number}: {BOOKS_CONFLICT_LABELS[c.reason] ?? BOOKS_CONFLICT_LABELS.invalid_document}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {skipped.length > 0 && (
            <details className="text-xs" style={{ color: 'var(--muted)' }}>
              <summary>
                {skipped.length} {skipped.length === 1 ? 'Dokument' : 'Dokumente'} bewusst nicht übernommen
              </summary>
              <ul className="mt-1 list-disc pl-5">
                {skipped.map((s) => (
                  <li key={`${s.number}-${s.reason}`}>
                    Rechnung {s.number}: {BOOKS_SKIP_LABELS[s.reason] ?? s.reason}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}
    </section>
  );
}
