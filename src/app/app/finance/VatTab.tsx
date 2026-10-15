'use client';

import { Fragment, useId, useState } from 'react';
import Link from 'next/link';
import { formatDay } from '@/lib/meals/messages';
import type { StatementView } from '@/lib/tax/service';
import type { RateTotal, VatFrequency, VatMethod } from '@/lib/tax/vat';
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

/** The turnover and tax per rate, as the advance return asks for them. */
function rateLine(totals: readonly RateTotal[]): string {
  return totals
    .map((t) => `zu ${(t.rateBp / 100).toLocaleString('de-DE')} %: Umsatz ${euro(t.netCents)}, Steuer ${euro(t.vatCents)}`)
    .join(' · ');
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
  const settlementsSection = (
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
  );
  const withReverseCharge = year !== null && (year.reverseChargeVatCents !== 0 || year.reverseChargeInputVatCents !== 0);
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

      {!view.vat.applies && view.vat.reverseChargeYear === null && (
        <p className="glass-panel rounded-xl p-6 text-sm" style={{ color: 'var(--muted)' }}>
          {view.vat.reverseChargePendingItems > 0
            ? `${view.year} liegt vollständig unter der Kleinunternehmerregelung. Für Steuer nach § 13b können Voranmeldungen und eine Jahreserklärung fällig werden, sobald die offenen Belege geklärt sind.`
            : `${view.year} liegt vollständig unter der Kleinunternehmerregelung: es gibt keine Voranmeldungen, auch keine für Steuer nach § 13b.`}
          <ReverseChargePending count={view.vat.reverseChargePendingItems} />
        </p>
      )}
      {!view.vat.applies && view.vat.reverseChargeYear !== null && (
        <section className="glass-panel rounded-xl p-4 sm:p-5" aria-label="Steuer nach § 13b">
          <h2 className="text-base font-semibold" style={{ color: 'var(--foreground)' }}>Steuer als Leistungsempfänger (§ 13b) {view.year}</h2>
          <p className="mt-1 text-xs" style={{ color: 'var(--muted)' }}>
            Auch unter der Kleinunternehmerregelung schuldet der Betrieb als Unternehmer die Steuer für sonstige Leistungen
            aus dem Ausland selbst (§ 13b Absatz 5 Satz 1 Umsatzsteuergesetz) und kann sie nicht als Vorsteuer abziehen.
            Für jeden Zeitraum mit einem Betrag ist eine Voranmeldung abzugeben, und für das Jahr eine
            Umsatzsteuererklärung (§ 18 Absatz 4a, den § 19 Absatz 1 Satz 2 ausdrücklich unberührt lässt). Die Zahlung an das
            Finanzamt ist im Jahr der Zahlung eine Betriebsausgabe, soweit sie auf betriebliche Anteile entfällt, und wird
            unten unter „Zahlungen an das Finanzamt“ eingetragen.
            {view.vat.reverseChargeFrequencyAssumed ? ' Gerechnet in Kalendervierteljahren, dem gesetzlichen Regelfall (§ 18 Absatz 2), solange kein anderer Zeitraum festgelegt ist.' : ''}
          </p>
          <table className="mt-3 w-full text-sm tabular-nums" style={{ color: 'var(--foreground)' }}>
            <caption className="sr-only">Steuer nach § 13b je Zeitraum {view.year}</caption>
            <thead>
              <tr className="text-left text-xs" style={{ color: 'var(--muted)' }}>
                <th scope="col" className="py-1 font-medium">Zeitraum</th>
                <th scope="col" className="py-1 text-right font-medium">Geschuldet</th>
              </tr>
            </thead>
            <tbody>
              {view.vat.reverseChargeYear.periods
                .filter((p) => p.reverseChargeVatCents !== 0)
                .map((period) => (
                  <tr key={period.index} className="border-t" style={{ borderColor: 'var(--border)' }}>
                    <th scope="row" className="py-1 text-left font-normal">
                      {view.vat.reverseChargeYear?.periods.length === 12 ? MONTHS[period.index - 1] : `${period.index}. Quartal`}
                      <span className="ml-2 text-xs" style={{ color: 'var(--muted)' }}>
                        {period.reverseCharge.length === 1 ? '1 Beleg' : `${period.reverseCharge.length} Belege`}
                      </span>
                    </th>
                    <td className="py-1 text-right">{euro(period.dueCents)}</td>
                  </tr>
                ))}
            </tbody>
            <tfoot>
              <tr className="border-t font-semibold" style={{ borderColor: 'var(--border)' }}>
                <th scope="row" className="py-1 text-left">Jahr</th>
                <td className="py-1 text-right">{euro(view.vat.reverseChargeYear.dueCents)}</td>
              </tr>
            </tfoot>
          </table>
          <ReverseChargeNotes view={view} />
        </section>
      )}
      {!view.vat.applies && (view.vat.reverseChargeYear !== null || view.vat.reverseChargePendingItems > 0) && settlementsSection}
      {!view.vat.applies && view.vat.reverseChargeYear === null && view.vat.reverseChargePendingItems === 0 && view.vat.settlements.length > 0 && (
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
                    {withReverseCharge && <th scope="col" className="py-1 text-right font-medium">§ 13b geschuldet</th>}
                    {withReverseCharge && <th scope="col" className="py-1 text-right font-medium">§ 13b abziehbar</th>}
                    <th scope="col" className="py-1 text-right font-medium">Zahllast</th>
                  </tr>
                </thead>
                <tbody>
                  {year.periods.map((period) => (
                    <Fragment key={period.index}>
                    <tr className="border-t" style={{ borderColor: 'var(--border)' }}>
                      <th scope="row" className="py-1 text-left font-normal">
                        {year.periods.length === 12 ? MONTHS[period.index - 1] : `${period.index}. Quartal`}
                        <span className="ml-2 text-xs" style={{ color: 'var(--muted)' }}>
                          {period.output.length + period.input.length + period.reverseCharge.length > 0
                            ? countText(new Set(period.output.map((e) => e.id)).size, new Set([...period.input, ...period.reverseCharge].map((e) => e.id)).size)
                            : ''}
                        </span>
                      </th>
                      <td className="py-1 text-right">{euro(period.outputVatCents)}</td>
                      <td className="py-1 text-right">{euro(period.inputVatCents)}</td>
                      {withReverseCharge && <td className="py-1 text-right">{euro(period.reverseChargeVatCents)}</td>}
                      {withReverseCharge && <td className="py-1 text-right">{euro(period.reverseChargeInputVatCents)}</td>}
                      <td className="py-1 text-right">{period.dueCents < 0 ? `Erstattung ${euro(-period.dueCents)}` : euro(period.dueCents)}</td>
                    </tr>
                    {period.outputByRate.length > 0 && (
                      <tr>
                        <td colSpan={4} className="pb-1 text-xs" style={{ color: 'var(--muted)' }}>
                          {rateLine(period.outputByRate)}
                        </td>
                      </tr>
                    )}
                    </Fragment>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="border-t font-semibold" style={{ borderColor: 'var(--border)' }}>
                    <th scope="row" className="py-1 text-left">Jahr</th>
                    <td className="py-1 text-right">{euro(year.outputVatCents)}</td>
                    <td className="py-1 text-right">{euro(year.inputVatCents)}</td>
                    {withReverseCharge && <td className="py-1 text-right">{euro(year.reverseChargeVatCents)}</td>}
                    {withReverseCharge && <td className="py-1 text-right">{euro(year.reverseChargeInputVatCents)}</td>}
                    <td className="py-1 text-right">{year.dueCents < 0 ? `Erstattung ${euro(-year.dueCents)}` : euro(year.dueCents)}</td>
                  </tr>
                  {year.outputByRate.length > 0 && (
                    <tr>
                      <td colSpan={4} className="pb-1 text-xs font-normal" style={{ color: 'var(--muted)' }}>
                        {rateLine(year.outputByRate)}
                      </td>
                    </tr>
                  )}
                </tfoot>
              </table>
            )}
            <p className="mt-3 text-xs" style={{ color: 'var(--muted)' }}>
              Enthalten ist auch die Steuer, die der Betrieb als Leistungsempfänger für Leistungen aus dem Ausland schuldet
              (§ 13b Umsatzsteuergesetz), für Belege, die am Beleg oder für ihren Lieferanten so markiert sind. Unter der
              Regelbesteuerung ist sie für den betrieblichen Anteil zugleich als Vorsteuer abziehbar (§ 15 Absatz 1 Satz 1
              Nummer 4). Die App ordnet sie dem Belegdatum zu, bei Zahlung vor der Leistung dem Zahltag; das ist eine
              Näherung: rechtlich entsteht sie mit Ablauf des Zeitraums der Leistung (§ 13b Absatz 1) oder mit der Rechnung,
              spätestens mit Ablauf des Folgemonats (§ 13b Absatz 2), bei Anzahlung im Zeitraum der Zahlung (§ 13b Absatz 4).
            </p>
            <ReverseChargeNotes view={view} />
          </section>

          {settlementsSection}
        </>
      )}
      {shown && <p className="ui-note ui-note-danger" role="alert">{shown}</p>}
    </div>
  );
}

/** Receipts marked for section 13b whose tax cannot be computed yet. */
function ReverseChargePending({ count }: { count: number }) {
  if (count === 0) return null;
  return (
    <span className="ui-note ui-note-warn mt-3 block">
      {count === 1 ? 'Ein Beleg' : `${count} Belege`} mit § 13b {count === 1 ? 'ist' : 'sind'} noch nicht in diesen Zahlen: offen
      (siehe „Offen“) oder Teil einer Anlage. Die Steuer darauf ist trotzdem geschuldet.
    </span>
  );
}

/** The section 13b facts a person must know beside the figures: pending receipts, the share outside the business, other currencies. */
function ReverseChargeNotes({ view }: { view: StatementView }) {
  const { reverseChargePendingItems: pending, reverseChargeNonBusinessCents: nonBusiness, reverseChargeForeignCurrencyItems: foreign } = view.vat;
  return (
    <>
      <ReverseChargePending count={pending} />
      {nonBusiness > 0 && (
        <p className="ui-note mt-3">
          Davon entfallen {euro(nonBusiness)} auf private oder andere nicht betriebliche Anteile. Diese Steuer ist ebenfalls
          geschuldet (§ 13b Absatz 5 Satz 7), aber weder abziehbar noch eine Betriebsausgabe: beim Eintragen der Zahlung an
          das Finanzamt bitte nur den betrieblichen Teil als Ausgabe ansetzen.
        </p>
      )}
      {foreign > 0 && (
        <p className="ui-note ui-note-warn mt-3">
          {foreign === 1 ? 'Ein Beleg' : `${foreign} Belege`} mit § 13b {foreign === 1 ? 'lautet' : 'lauten'} auf eine fremde
          Währung. Gerechnet wird mit dem gebuchten Euro-Betrag; das Gesetz verlangt den monatlichen Durchschnittskurs des
          Bundesfinanzministeriums, sofern das Finanzamt nicht den Tageskurs gestattet hat (§ 16 Absatz 6). Den Betrag vor
          der Voranmeldung bitte damit prüfen.
        </p>
      )}
    </>
  );
}

/** "1 Rechnung, 2 Belege": the number of invoices and receipts behind a period, in the right number. */
function countText(invoices: number, receipts: number): string {
  return `${invoices} ${invoices === 1 ? 'Rechnung' : 'Rechnungen'}, ${receipts} ${receipts === 1 ? 'Beleg' : 'Belege'}`;
}
