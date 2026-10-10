'use client';

import { useId, useState } from 'react';
import Link from 'next/link';
import { formatDay } from '@/lib/meals/messages';
import type { StatementView } from '@/lib/tax/service';
import type { VatFrequency, VatMethod } from '@/lib/tax/vat';
import { MONTHS, euro, parseEuro } from './amounts';

interface Props {
  view: StatementView;
  busy: boolean;
  error: string | null;
  onStatusChange: (input: { effectiveFrom: string; smallBusiness: boolean }, done: () => void) => void;
  onRemoveStatusChange: (changeId: string) => void;
  onSettings: (input: { frequency: VatFrequency; method: VatMethod }) => void;
  onSettlement: (input: { date: string; cents: number; direction: 'paid' | 'refunded' }, done: () => void) => void;
  onRemoveSettlement: (settlementId: string) => void;
}

const statusLabel = (smallBusiness: boolean) => (smallBusiness ? 'Kleinunternehmerregelung (§ 19)' : 'Regelbesteuerung');

/**
 * The value-added tax status over time, and under regular taxation the
 * advance return periods with the tax charged, the input tax and what is due.
 */
export default function VatTab({ view, busy, error, onStatusChange, onRemoveStatusChange, onSettings, onSettlement, onRemoveSettlement }: Props) {
  const id = useId();
  const [changeDate, setChangeDate] = useState('');
  const [changeTo, setChangeTo] = useState<boolean>(view.smallBusinessAtYearEnd === false);
  const [frequency, setFrequency] = useState<VatFrequency>(view.vat.frequency ?? 'quarterly');
  const [method, setMethod] = useState<VatMethod>(view.vat.method ?? 'issued');
  const [settleDate, setSettleDate] = useState('');
  const [settleAmount, setSettleAmount] = useState('');
  const [settleDirection, setSettleDirection] = useState<'paid' | 'refunded'>('paid');
  const [localError, setLocalError] = useState<string | null>(null);
  const shown = localError ?? error;

  if (view.smallBusiness === null) {
    return (
      <div className="glass-panel rounded-xl p-6 text-sm" style={{ color: 'var(--muted)' }}>
        Zuerst muss die Frage zur Kleinunternehmerregelung beantwortet sein. Sie wird im{' '}
        <Link href="/app/meals" className="underline">Bewirtungsverzeichnis</Link> unter „Verzeichnis“ gestellt; danach
        lassen sich hier spätere Wechsel eintragen.
      </div>
    );
  }

  const year = view.vat.year;
  return (
    <div className="space-y-6">
      <section className="glass-panel rounded-xl p-4 sm:p-5" aria-label="Status">
        <h2 className="text-base font-semibold" style={{ color: 'var(--foreground)' }}>Umsatzsteuerlicher Status</h2>
        <ul className="mt-3 space-y-1.5 text-sm" style={{ color: 'var(--foreground)' }}>
          <li>Von Anfang an: {statusLabel(view.smallBusiness)}</li>
          {view.statusChanges.map((change) => (
            <li key={change.id} className="flex flex-wrap items-baseline justify-between gap-2">
              <span>Ab {formatDay(change.effectiveFrom)}: {statusLabel(change.smallBusiness)}</span>
              <button
                type="button"
                className="ui-btn ui-btn-sm ui-btn-danger"
                disabled={busy}
                onClick={() => {
                  if (!window.confirm(`Den Wechsel zum ${formatDay(change.effectiveFrom)} löschen? Belege ab diesem Tag werden dann wieder nach dem vorherigen Status gerechnet.`)) return;
                  onRemoveStatusChange(change.id);
                }}
              >
                Löschen
              </button>
            </li>
          ))}
        </ul>
        <p className="mt-2 text-xs" style={{ color: 'var(--muted)' }}>
          Ein Beleg, eine Rechnung und eine Anlage werden nach dem Status an ihrem eigenen Datum gerechnet. Ein Wechsel
          verändert deshalb nichts, was vor seinem Datum liegt.
        </p>
        <form
          className="mt-4 flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (!changeDate) return setLocalError('Bitte ein gültiges Datum für die Statusänderung eingeben.');
            setLocalError(null);
            onStatusChange({ effectiveFrom: changeDate, smallBusiness: changeTo }, () => setChangeDate(''));
          }}
        >
          <div>
            <label className="ui-label" htmlFor={`${id}-cd`}>Wechsel ab</label>
            <input id={`${id}-cd`} type="date" className="ui-input" value={changeDate} onChange={(e) => setChangeDate(e.target.value)} />
          </div>
          <div className="ui-seg" role="group" aria-label="Neuer Status">
            <button type="button" aria-pressed={!changeTo} onClick={() => setChangeTo(false)}>Regelbesteuerung</button>
            <button type="button" aria-pressed={changeTo} onClick={() => setChangeTo(true)}>Kleinunternehmerregelung</button>
          </div>
          <button type="submit" className="ui-btn" disabled={busy}>Wechsel eintragen</button>
        </form>
        {view.smallBusinessAtYearEnd === true && view.vat.undeductedInputVatCents > 0 && (
          <p className="ui-note mt-4">
            Unter der Kleinunternehmerregelung nicht abziehbar: {euro(view.vat.undeductedInputVatCents)} Umsatzsteuer
            aus den betrieblichen Anteilen der Belege {view.year}, die einen Nettobetrag ausweisen. Dem steht gegenüber,
            dass bei Regelbesteuerung auf den eigenen Rechnungen Umsatzsteuer auszuweisen wäre und der Verzicht auf die
            Kleinunternehmerregelung fünf Jahre bindet.
          </p>
        )}
      </section>

      {!view.vat.applies && (
        <p className="glass-panel rounded-xl p-6 text-sm" style={{ color: 'var(--muted)' }}>
          {view.year} liegt vollständig unter der Kleinunternehmerregelung: es gibt keine Voranmeldungen.
        </p>
      )}
      {!view.vat.applies && view.vat.settlements.length > 0 && (
        // A settlement dated in a year without regular taxation still counts on the statement, so it must stay visible and removable.
        <section className="glass-panel rounded-xl p-4 sm:p-5" aria-label="Zahlungen an das Finanzamt">
          <h2 className="text-base font-semibold" style={{ color: 'var(--foreground)' }}>Zahlungen an das Finanzamt und Erstattungen</h2>
          <ul className="mt-3 space-y-1.5 text-sm" style={{ color: 'var(--foreground)' }}>
            {view.vat.settlements.map((s) => (
              <li key={s.id} className="flex flex-wrap items-baseline justify-between gap-2">
                <span>{formatDay(s.date)}: {s.direction === 'paid' ? 'gezahlt' : 'erstattet'} {euro(s.cents)}{s.countsOn ? ` (zählt für ${s.countsOn.slice(0, 4)}, Jahreswechsel)` : ''}</span>
                <button type="button" className="ui-btn ui-btn-sm ui-btn-danger" disabled={busy} onClick={() => onRemoveSettlement(s.id)}>Löschen</button>
              </li>
            ))}
          </ul>
        </section>
      )}
      {view.vat.applies && (
        <>
          <section className="glass-panel rounded-xl p-4 sm:p-5" aria-label="Voranmeldungen">
            <h2 className="text-base font-semibold" style={{ color: 'var(--foreground)' }}>Umsatzsteuer-Voranmeldungen {view.year}</h2>
            <form
              className="mt-3 flex flex-wrap items-end gap-3"
              onSubmit={(e) => {
                e.preventDefault();
                setLocalError(null);
                onSettings({ frequency, method });
              }}
            >
              <div>
                <span className="ui-label" id={`${id}-freq`}>Abgabe</span>
                <div className="ui-seg" role="group" aria-labelledby={`${id}-freq`}>
                  <button type="button" aria-pressed={frequency === 'quarterly'} onClick={() => setFrequency('quarterly')}>Vierteljährlich</button>
                  <button type="button" aria-pressed={frequency === 'monthly'} onClick={() => setFrequency('monthly')}>Monatlich</button>
                </div>
              </div>
              <div>
                <span className="ui-label" id={`${id}-method`}>Steuer entsteht</span>
                <div className="ui-seg" role="group" aria-labelledby={`${id}-method`}>
                  <button type="button" aria-pressed={method === 'issued'} onClick={() => setMethod('issued')}>mit der Rechnung</button>
                  <button type="button" aria-pressed={method === 'received'} onClick={() => setMethod('received')}>mit dem Zahlungseingang</button>
                </div>
              </div>
              <button type="submit" className="ui-btn" disabled={busy}>{view.vat.frequency ? 'Ändern' : 'Festlegen'}</button>
            </form>
            <p className="mt-2 text-xs" style={{ color: 'var(--muted)' }}>
              Den Zeitraum legt das Finanzamt fest. Die Besteuerung nach Zahlungseingang muss beim Finanzamt beantragt
              sein. Ohne diese beiden Angaben wird kein Zeitraum gerechnet.
            </p>
            {year === null ? (
              <p className="ui-note ui-note-warn mt-3">Bitte Abgabezeitraum und Besteuerungsart festlegen; vorher gibt es hier keine Zahlen.</p>
            ) : (
              <table className="mt-3 w-full text-sm tabular-nums" style={{ color: 'var(--foreground)' }}>
                <caption className="sr-only">Voranmeldungszeiträume {view.year}</caption>
                <thead>
                  <tr className="text-left text-xs" style={{ color: 'var(--muted)' }}>
                    <th scope="col" className="py-1 font-medium">Zeitraum</th>
                    <th scope="col" className="py-1 text-right font-medium">Umsatzsteuer</th>
                    <th scope="col" className="py-1 text-right font-medium">Vorsteuer</th>
                    <th scope="col" className="py-1 text-right font-medium">Zahllast</th>
                  </tr>
                </thead>
                <tbody>
                  {year.periods.map((period) => (
                    <tr key={period.index} className="border-t" style={{ borderColor: 'var(--border)' }}>
                      <th scope="row" className="py-1 text-left font-normal">
                        {year.periods.length === 12 ? MONTHS[period.index - 1] : `${period.index}. Quartal`}
                        <span className="ml-2 text-xs" style={{ color: 'var(--muted)' }}>
                          {period.output.length + period.input.length > 0 ? `${period.output.length} Rechnungen, ${period.input.length} Belege` : ''}
                        </span>
                      </th>
                      <td className="py-1 text-right">{euro(period.outputVatCents)}</td>
                      <td className="py-1 text-right">{euro(period.inputVatCents)}</td>
                      <td className="py-1 text-right">{period.dueCents < 0 ? `Erstattung ${euro(-period.dueCents)}` : euro(period.dueCents)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="border-t font-semibold" style={{ borderColor: 'var(--border)' }}>
                    <th scope="row" className="py-1 text-left">Jahr</th>
                    <td className="py-1 text-right">{euro(year.outputVatCents)}</td>
                    <td className="py-1 text-right">{euro(year.inputVatCents)}</td>
                    <td className="py-1 text-right">{year.dueCents < 0 ? `Erstattung ${euro(-year.dueCents)}` : euro(year.dueCents)}</td>
                  </tr>
                </tfoot>
              </table>
            )}
            <p className="mt-3 text-xs" style={{ color: 'var(--muted)' }}>
              Nicht enthalten: Umsatzsteuer, die du als Leistungsempfänger für Leistungen aus dem Ausland schuldest
              (§ 13b Umsatzsteuergesetz). Solche Belege bitte mit einem Steuerberater klären.
            </p>
          </section>

          <section className="glass-panel rounded-xl p-4 sm:p-5" aria-label="Zahlungen an das Finanzamt">
            <h2 className="text-base font-semibold" style={{ color: 'var(--foreground)' }}>Zahlungen an das Finanzamt und Erstattungen</h2>
            <p className="mt-1 text-xs" style={{ color: 'var(--muted)' }}>
              In der Einnahmenüberschussrechnung ist gezahlte Umsatzsteuer eine Ausgabe und erstattete eine Einnahme, jeweils im Jahr der Zahlung.
            </p>
            {view.vat.settlements.length > 0 && (
              <ul className="mt-3 space-y-1.5 text-sm" style={{ color: 'var(--foreground)' }}>
                {view.vat.settlements.map((s) => (
                  <li key={s.id} className="flex flex-wrap items-baseline justify-between gap-2">
                    <span>{formatDay(s.date)}: {s.direction === 'paid' ? 'gezahlt' : 'erstattet'} {euro(s.cents)}{s.countsOn ? ` (zählt für ${s.countsOn.slice(0, 4)}, Jahreswechsel)` : ''}</span>
                    <button type="button" className="ui-btn ui-btn-sm ui-btn-danger" disabled={busy} onClick={() => onRemoveSettlement(s.id)}>Löschen</button>
                  </li>
                ))}
              </ul>
            )}
            <form
              className="mt-3 flex flex-wrap items-end gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                const cents = parseEuro(settleAmount);
                if (!settleDate || cents === null || cents <= 0) return setLocalError('Bitte Datum und Betrag der Zahlung prüfen.');
                setLocalError(null);
                onSettlement({ date: settleDate, cents, direction: settleDirection }, () => {
                  setSettleDate('');
                  setSettleAmount('');
                });
              }}
            >
              <div>
                <label className="ui-label" htmlFor={`${id}-sd`}>Datum</label>
                <input id={`${id}-sd`} type="date" className="ui-input" value={settleDate} onChange={(e) => setSettleDate(e.target.value)} />
              </div>
              <div>
                <label className="ui-label" htmlFor={`${id}-sa`}>Betrag in €</label>
                <input id={`${id}-sa`} className="ui-input tabular-nums" inputMode="decimal" value={settleAmount} onChange={(e) => setSettleAmount(e.target.value)} />
              </div>
              <div className="ui-seg" role="group" aria-label="Richtung">
                <button type="button" aria-pressed={settleDirection === 'paid'} onClick={() => setSettleDirection('paid')}>Gezahlt</button>
                <button type="button" aria-pressed={settleDirection === 'refunded'} onClick={() => setSettleDirection('refunded')}>Erstattet</button>
              </div>
              <button type="submit" className="ui-btn" disabled={busy}>Eintragen</button>
            </form>
          </section>
        </>
      )}
      {shown && <p className="ui-note ui-note-danger" role="alert">{shown}</p>}
    </div>
  );
}
