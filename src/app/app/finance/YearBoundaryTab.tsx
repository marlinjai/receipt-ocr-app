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
 * 10 January, each with the answer that applies and why (a filed year, a rule
 * worked out from the payment data, or a person's answer; `year-boundary.ts`).
 * Only what nothing answers is open and asked; a person can override a rule.
 */
export default function YearBoundaryTab({ view, busy, error, onAnswer, onDeclineOpen }: Props) {
  const entries = view.yearBoundary;
  const open = entries.filter((e) => e.source === null && e.inactive === null);
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
          Rechtsprechung zehn Tage. Für die Umsatzsteuer-Voranmeldung ändert sich nichts: die Vorsteuer bleibt in dem
          Zeitraum, in dem gezahlt wurde.
        </p>
        <p className="mt-1 text-xs" style={{ color: 'var(--muted)' }}>
          Die meisten Zahlungen beantworten sich selbst. Ist die Erklärung eines der beiden Jahre abgegeben, bleibt die
          Zahlung so, wie sie erklärt wurde. Sonst gilt: eine Umsatzsteuer-Zahlung vom 1. bis 10. Januar gehört zum Jahr
          davor, eine vom 22. bis 31. Dezember bleibt; ein Abo wird zu Beginn des Zeitraums berechnet, den es bezahlt, und
          bleibt; ein einmaliger Kauf bleibt in dem Jahr, in dem er bezahlt wurde. Eine eigene Antwort geht jeder Regel vor.
          Gefragt wird nur, was keine Regel klärt.
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
              const answerable = entry.inactive === null && entry.filedYear === null;
              // A person's answer on a filed year is part of the return; only one that departs from it can be taken back.
              const takeBack = entry.storedAnswer !== null && (entry.filedYear === null || entry.departsFromFiled !== null || entry.inactive !== null);
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
                      ? `Die frühere Antwort (${entry.storedAnswer ? `zählt für ${entry.otherYear}` : `bleibt in ${paidYear}`}) wird nicht angewendet: ${entry.inactive === 'meal' ? 'der Beleg ist inzwischen eine Bewirtung und zählt nach dem Bewirtungsverzeichnis' : 'der Beleg gehört inzwischen zu einer Anlage und wird abgeschrieben'}. Sie gilt wieder, sobald das nicht mehr so ist; wer das nicht möchte, nimmt sie zurück.`
                      : entry.departsFromFiled !== null
                        ? `Bleibt in ${paidYear}. ${entry.reason}: die Antwort „zählt für ${entry.otherYear}“ wurde nach der Abgabe gegeben und wird nicht angewendet. Wer sie nicht mehr braucht, nimmt sie zurück.`
                        : `${entry.answer === true ? `Zählt für ${entry.otherYear}.` : entry.answer === false ? `Bleibt in ${paidYear}.` : `Noch offen: zählt bis dahin für ${paidYear}.`} ${entry.source === 'person' ? entry.reason : entry.source === null ? entry.reason : `Grund: ${entry.reason}`}.`}
                  </p>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {answerable && (
                      <>
                        <button type="button" className="ui-btn ui-btn-sm" aria-pressed={entry.storedAnswer === true} disabled={busy} onClick={() => onAnswer(entry, true)}>
                          Regelmäßig wiederkehrend, gehört zu {entry.otherYear}
                        </button>
                        <button type="button" className="ui-btn ui-btn-sm" aria-pressed={entry.storedAnswer === false} disabled={busy} onClick={() => onAnswer(entry, false)}>
                          Bleibt in {paidYear}
                        </button>
                      </>
                    )}
                    {takeBack && (
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
