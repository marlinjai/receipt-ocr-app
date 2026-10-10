'use client';

import { formatDay } from '@/lib/meals/messages';
import type { StatementView, YearBoundaryEntry } from '@/lib/tax/service';
import { euro } from './amounts';

interface Props {
  view: StatementView;
  busy: boolean;
  error: string | null;
  /** Null takes the answer back. */
  onAnswer: (entry: YearBoundaryEntry, belongsToOtherYear: boolean | null) => void;
  /** Every payment without an answer stays in the year it was paid. */
  onDeclineOpen: () => void;
}

/**
 * The ten-day rule at the turn of the year: payments between 22 December and
 * 10 January, each with the question whether it is a regularly recurring one
 * that belongs to the other year. Nothing is moved without an answer.
 */
export default function YearBoundaryTab({ view, busy, error, onAnswer, onDeclineOpen }: Props) {
  const entries = view.yearBoundary;
  const open = entries.filter((e) => e.answer === null && e.inactive === null);
  return (
    <div className="space-y-4">
      <section className="glass-panel rounded-xl p-4 sm:p-5">
        <h2 className="text-base font-semibold" style={{ color: 'var(--foreground)' }}>Zahlungen um den Jahreswechsel</h2>
        <p className="mt-2 text-sm" style={{ color: 'var(--foreground)' }}>
          Eine Ausgabe zählt in dem Jahr, in dem sie bezahlt wurde, eine Erstattung in dem Jahr, in dem sie ankam. Eine
          Ausnahme gilt für regelmäßig wiederkehrende Zahlungen (zum Beispiel Miete, Versicherungsbeiträge,
          Umsatzsteuer-Vorauszahlungen und -Erstattungen), die zwischen dem 22. Dezember und dem 10. Januar fällig
          waren und in dieser Zeit auch geflossen sind: sie zählen für das Jahr, zu dem sie wirtschaftlich gehören.
        </p>
        <p className="mt-1 text-xs" style={{ color: 'var(--muted)' }}>
          Grundlage: § 11 Absatz 1 Satz 2 und Absatz 2 Satz 2 Einkommensteuergesetz; „kurze Zeit“ sind nach ständiger
          Rechtsprechung zehn Tage. Ein einmaliger Kauf in dieser Zeit bleibt in dem Jahr, in dem er bezahlt wurde.
          Ohne Antwort wird nichts verschoben. Für die Umsatzsteuer-Voranmeldung ändert sich nichts: die Vorsteuer
          bleibt in dem Zeitraum, in dem gezahlt wurde.
        </p>
      </section>

      {error && <p className="ui-note ui-note-danger" role="alert">{error}</p>}

      {entries.length === 0 ? (
        <div className="glass-panel rounded-xl p-8 text-center text-sm" style={{ color: 'var(--muted)' }}>
          Für {view.year} gibt es keine Zahlung zwischen dem 22. Dezember und dem 10. Januar.
        </div>
      ) : (
        <section className="glass-panel rounded-xl p-4 sm:p-5" aria-label="Zahlungen im Zehn-Tage-Zeitraum">
          {open.length > 1 && (
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <p className="text-sm" style={{ color: 'var(--foreground)' }}>{open.length} Zahlungen ohne Antwort</p>
              <button type="button" className="ui-btn ui-btn-sm" disabled={busy} onClick={onDeclineOpen}>
                Keine davon ist regelmäßig wiederkehrend
              </button>
            </div>
          )}
          <ul className="space-y-3">
            {entries.map((entry) => {
              const paidYear = Number(entry.cashDay.slice(0, 4));
              return (
                <li key={`${entry.kind}:${entry.subjectId}`} className="rounded-lg border p-3" style={{ borderColor: 'var(--border)' }}>
                  <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                    <span className="text-sm" style={{ color: 'var(--foreground)' }}>
                      {entry.label}
                      <span className="ml-2 text-xs" style={{ color: 'var(--muted)' }}>
                        {entry.dayBasis === 'payment' ? 'gezahlt am' : 'Belegdatum (keine Zahlung zugeordnet)'} {formatDay(entry.cashDay)}
                      </span>
                    </span>
                    <span className="text-sm tabular-nums" style={{ color: 'var(--foreground)' }}>{entry.cents !== null ? euro(entry.cents) : 'ohne Betrag'}</span>
                  </div>
                  <p className="mt-1 text-xs" style={{ color: 'var(--muted)' }} role="status">
                    {entry.inactive
                      ? `Die frühere Antwort (${entry.answer ? `zählt für ${entry.otherYear}` : `bleibt in ${paidYear}`}) wird nicht angewendet: ${entry.inactive === 'meal' ? 'der Beleg ist inzwischen eine Bewirtung und zählt nach dem Bewirtungsverzeichnis' : 'der Beleg gehört inzwischen zu einer Anlage und wird abgeschrieben'}. Sie gilt wieder, sobald das nicht mehr so ist; wer das nicht möchte, nimmt sie zurück.`
                      : entry.answer === true
                      ? `Zählt für ${entry.otherYear} (regelmäßig wiederkehrend).`
                      : entry.answer === false
                        ? `Bleibt in ${paidYear}.`
                        : `Noch nicht beantwortet: zählt bis dahin für ${paidYear}.`}
                  </p>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {entry.inactive === null && (
                      <>
                        <button type="button" className="ui-btn ui-btn-sm" aria-pressed={entry.answer === true} disabled={busy} onClick={() => onAnswer(entry, true)}>
                          Regelmäßig wiederkehrend, gehört zu {entry.otherYear}
                        </button>
                        <button type="button" className="ui-btn ui-btn-sm" aria-pressed={entry.answer === false} disabled={busy} onClick={() => onAnswer(entry, false)}>
                          Bleibt in {paidYear}
                        </button>
                      </>
                    )}
                    {entry.answer !== null && (
                      <button type="button" className="ui-btn ui-btn-sm" disabled={busy} onClick={() => onAnswer(entry, null)}>
                        Antwort zurücknehmen
                      </button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </div>
  );
}
