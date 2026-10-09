'use client';

import { useId, useState } from 'react';
import { formatDay } from '@/lib/meals/messages';
import type { LimitOutlook } from '@/lib/tax/forecast';
import { INVOICE_CHECK_LABELS, INVOICE_TREATMENT_LABELS } from '@/lib/tax/messages';
import { formatCents } from '@/lib/tax/money';
import type { InvoiceView, StatementView } from '@/lib/tax/service';
import type { InvoiceTreatment } from '@/lib/tax/types';
import { MONTHS, euro, parseEuro } from './amounts';

export interface InvoiceDraft {
  number: string;
  issueDate: string | null;
  grossCents: number;
  vatCents: number;
  treatment: InvoiceTreatment;
  declaredInYear: number | null;
  payments: Array<{ date: string; cents: number }>;
}

interface Props {
  view: StatementView;
  busy: boolean;
  error: string | null;
  onSave: (invoiceId: string | null, draft: InvoiceDraft, done: () => void) => void;
  onDelete: (invoice: InvoiceView) => void;
  onExpectation: (cents: number | null) => void;
}

/** One sentence per limit: what the forecast says and what follows from it. */
function outlookText(outlook: LimitOutlook, limit: string, consequence: string): { text: string; warn: boolean } {
  switch (outlook.state) {
    case 'crossed':
      return { text: `Die Grenze von ${limit} ist seit ${MONTHS[outlook.month - 1]} überschritten. ${consequence}`, warn: true };
    case 'expected':
      return {
        text: `Mit den bereits gestellten Rechnungen wird die Grenze von ${limit} voraussichtlich im ${MONTHS[outlook.monthFrom - 1]}${outlook.monthTo !== outlook.monthFrom ? ` bis ${MONTHS[outlook.monthTo - 1]}` : ''} überschritten. ${consequence}`,
        warn: true,
      };
    case 'possible':
      return { text: `Läuft das Geschäft so weiter, wird die Grenze von ${limit} im ${MONTHS[outlook.month - 1]} überschritten. ${consequence}`, warn: true };
    default:
      return { text: `Die Grenze von ${limit} wird nach heutigem Stand nicht erreicht.`, warn: false };
  }
}

/**
 * Revenue of the year from issued invoices, counted on the days their money
 * arrived, and where the year is heading against the small-business limits.
 */
export default function RevenueTab({ view, busy, error, onSave, onDelete, onExpectation }: Props) {
  const id = useId();
  const [editing, setEditing] = useState<string | 'new' | null>(null);
  const [expectation, setExpectation] = useState(view.expectedMonthlyRevenueCents !== null ? formatCents(view.expectedMonthlyRevenueCents) : '');
  const [expectationError, setExpectationError] = useState<string | null>(null);
  const f = view.forecast;
  const next = outlookText(
    f.nextYear,
    euro(view.limits.previousYearLimitCents),
    `Dann endet die Kleinunternehmerregelung zum 1. Januar ${view.year + 1}.`,
  );
  const current = outlookText(
    f.currentYear,
    euro(view.limits.currentYearLimitCents),
    'Dann endet die Kleinunternehmerregelung sofort, mit dem Umsatz, der die Grenze überschreitet.',
  );
  const prepare = view.smallBusinessAtYearEnd === true && (next.warn || current.warn);

  return (
    <div className="space-y-6">
      <section className="glass-panel rounded-xl p-4 sm:p-5" aria-label="Umsatz und Grenzen">
        <h2 className="text-base font-semibold" style={{ color: 'var(--foreground)' }}>
          Umsatz {view.year} und die Grenzen der Kleinunternehmerregelung
        </h2>
        {!view.revenue.recorded ? (
          <p className="ui-note mt-3">
            Noch keine Rechnung erfasst. Solange das so ist, weist die App weder Einnahmen noch einen Gewinn oder
            Verlust aus (und zeigt dafür auch keine Null).
          </p>
        ) : (
          <>
            <dl className="mt-3 grid gap-3 sm:grid-cols-3">
              <div>
                <dt className="ui-label">Eingegangen {view.year}</dt>
                <dd className="text-xl font-semibold tabular-nums" style={{ color: 'var(--foreground)' }}>{euro(f.receivedCents)}</dd>
              </div>
              <div>
                <dt className="ui-label">Gestellt, noch nicht bezahlt</dt>
                <dd className="text-xl font-semibold tabular-nums" style={{ color: 'var(--foreground)' }}>{euro(f.outstandingCents)}</dd>
              </div>
              <div>
                <dt className="ui-label">Bis Jahresende voraussichtlich</dt>
                <dd className="text-xl font-semibold tabular-nums" style={{ color: 'var(--foreground)' }}>
                  {f.lowCents === f.highCents ? euro(f.lowCents) : `${euro(f.lowCents)} bis ${euro(f.highCents)}`}
                </dd>
              </div>
            </dl>
            <p className="mt-2 text-xs" style={{ color: 'var(--muted)' }}>
              Gezählt wird, was eingegangen ist, ohne enthaltene Umsatzsteuer.{' '}
              {f.rateBasis === 'stated' && `Hochrechnung mit dem von dir erwarteten Monatsumsatz von ${euro(f.monthlyRateCents)}.`}
              {f.rateBasis === 'run_rate' &&
                `Hochrechnung mit dem Durchschnitt der ${f.basisMonths} abgeschlossenen Monate (${euro(f.monthlyRateCents)} im Monat).${f.thinBasis ? ' Das sind weniger als drei Monate: die Hochrechnung ist entsprechend unsicher.' : ''}`}
              {f.rateBasis === 'none' && 'Für eine Hochrechnung fehlt noch ein abgeschlossener Monat; gezeigt wird, was feststeht.'}
            </p>
            <div className="mt-3 space-y-2">
              <p className={`ui-note ${next.warn ? 'ui-note-warn' : ''}`}>{next.text}</p>
              <p className={`ui-note ${current.warn ? 'ui-note-warn' : ''}`}>{current.text}</p>
              {f.previousYearWithinLimit === false && view.smallBusinessAtYearEnd === true && (
                <p className="ui-note ui-note-danger" role="alert">
                  Der Umsatz {view.year - 1} lag über {euro(view.limits.previousYearLimitCents)}. Damit gilt die
                  Kleinunternehmerregelung {view.year} nicht mehr, hier ist aber noch kein Wechsel eingetragen. Bitte
                  unter „Umsatzsteuer“ den Wechsel zum 1. Januar {view.year} erfassen.
                </p>
              )}
              {f.previousYearWithinLimit === null && (
                <p className="ui-note">Der Umsatz {view.year - 1} ist hier nicht erfasst; ob er unter der Grenze lag, kann die App nicht prüfen.</p>
              )}
            </div>
            {prepare && (
              <div className="ui-note ui-note-warn mt-3">
                <p className="font-medium" style={{ color: 'var(--foreground)' }}>Vorbereitung auf die Regelbesteuerung</p>
                <ul className="mt-1 list-disc space-y-1 pl-5">
                  <li>Ab dem Wechsel müssen Rechnungen die Umsatzsteuer ausweisen.</li>
                  <li>Laufende Angebote und Preise prüfen: sind sie brutto oder netto vereinbart?</li>
                  <li>Das Finanzamt erwartet dann Umsatzsteuer-Voranmeldungen; den Zeitraum (monatlich oder vierteljährlich) legt es fest.</li>
                  <li>Aus Einkäufen wird die Umsatzsteuer als Vorsteuer abziehbar; dafür muss auf den Belegen der Nettobetrag stehen.</li>
                  <li>Den Wechsel mit seinem Datum unter „Umsatzsteuer“ eintragen, sobald er feststeht. Die App ändert den Status nie von selbst.</li>
                </ul>
              </div>
            )}
          </>
        )}
        <form
          className="mt-4 flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            const cents = expectation.trim() === '' ? null : parseEuro(expectation);
            if (expectation.trim() !== '' && cents === null) return setExpectationError('Bitte den erwarteten Monatsumsatz als Betrag eingeben.');
            setExpectationError(null);
            onExpectation(cents);
          }}
        >
          <div>
            <label className="ui-label" htmlFor={`${id}-expect`}>Erwarteter Umsatz pro Monat ab jetzt, in € (leer: Durchschnitt)</label>
            <input id={`${id}-expect`} className="ui-input tabular-nums" inputMode="decimal" value={expectation} onChange={(e) => setExpectation(e.target.value)} />
          </div>
          <button type="submit" className="ui-btn" disabled={busy}>Übernehmen</button>
          {expectationError && <p className="ui-note ui-note-danger w-full" role="alert">{expectationError}</p>}
        </form>
        <p className="mt-3 text-xs" style={{ color: 'var(--muted)' }}>
          Grenzen nach: {view.limits.source.citation}, abgeglichen am {formatDay(view.limits.source.checkedOn)}. Die
          Hochrechnung ist eine Rechnung aus den eigenen Zahlen und keine steuerliche Beratung.
        </p>
      </section>

      <section aria-label="Rechnungen">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-base font-semibold" style={{ color: 'var(--foreground)' }}>Gestellte Rechnungen</h2>
          {editing !== 'new' && (
            <button type="button" className="ui-btn ui-btn-primary" onClick={() => setEditing('new')}>Neue Rechnung</button>
          )}
        </div>
        {editing === 'new' && (
          <div className="glass-panel mt-3 rounded-xl p-4">
            <InvoiceForm view={view} invoice={null} busy={busy} error={error} onCancel={() => setEditing(null)} onSubmit={(d) => onSave(null, d, () => setEditing(null))} />
          </div>
        )}
        {view.revenue.invoices.length === 0 && editing !== 'new' ? (
          <p className="glass-panel mt-3 rounded-xl p-8 text-center text-sm" style={{ color: 'var(--muted)' }}>
            Für {view.year} ist keine Rechnung erfasst. Eine Rechnung zählt als Einnahme an dem Tag, an dem ihr Geld
            eingeht; bis dahin steht sie hier als offen.
          </p>
        ) : (
          <ul className="mt-3 space-y-2">
            {view.revenue.invoices.map((invoice) => (
              <li key={invoice.id} className="glass-panel rounded-xl p-4">
                <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                  <div>
                    <h3 className="text-sm font-semibold" style={{ color: 'var(--foreground)' }}>Rechnung {invoice.number}</h3>
                    <p className="mt-0.5 text-xs" style={{ color: 'var(--muted)' }}>
                      {formatDay(invoice.issueDate)} · {INVOICE_TREATMENT_LABELS[invoice.treatment]}
                      {invoice.payments.length > 0
                        ? ` · bezahlt ${invoice.payments.map((p) => `${formatDay(p.date)} ${euro(p.cents)}`).join(', ')}`
                        : ' · noch nicht bezahlt'}
                      {invoice.declaredInYear !== null ? ` · bereits ${invoice.declaredInYear} erklärt` : ''}
                    </p>
                  </div>
                  <dl className="flex gap-5 text-right text-xs" style={{ color: 'var(--muted)' }}>
                    <div>
                      <dt>Betrag</dt>
                      <dd className="text-sm tabular-nums" style={{ color: 'var(--foreground)' }}>{euro(invoice.grossCents)}</dd>
                    </div>
                    <div>
                      <dt>Eingang {view.year}</dt>
                      <dd className="text-sm tabular-nums" style={{ color: 'var(--foreground)' }}>{euro(invoice.receivedCents)}</dd>
                    </div>
                    <div>
                      <dt>Offen</dt>
                      <dd className="text-sm tabular-nums" style={{ color: 'var(--foreground)' }}>{euro(invoice.outstandingCents)}</dd>
                    </div>
                  </dl>
                </div>
                {invoice.excludedCents > 0 && (
                  <p className="ui-note mt-2">
                    {euro(invoice.excludedCents)} davon zählen nicht noch einmal als Einnahme, weil die Rechnung bereits{' '}
                    {invoice.declaredInYear} erklärt wurde. Für die Umsatzgrenzen zählt der Eingang trotzdem.
                  </p>
                )}
                {invoice.checks.length > 0 && (
                  <p className="ui-note ui-note-warn mt-2" role="status">{invoice.checks.map((c) => INVOICE_CHECK_LABELS[c]).join('; ')}.</p>
                )}
                <div className="mt-3 flex gap-2">
                  <button type="button" className="ui-btn ui-btn-sm" aria-expanded={editing === invoice.id} onClick={() => setEditing(editing === invoice.id ? null : invoice.id)}>
                    {editing === invoice.id ? 'Schließen' : 'Ändern'}
                  </button>
                  <button
                    type="button"
                    className="ui-btn ui-btn-sm ui-btn-danger"
                    disabled={busy}
                    onClick={() => {
                      if (!window.confirm(`Rechnung ${invoice.number} mit ihren Zahlungseingängen löschen?`)) return;
                      onDelete(invoice);
                    }}
                  >
                    Löschen
                  </button>
                </div>
                {editing === invoice.id && (
                  <div className="mt-3 rounded-lg border p-3" style={{ borderColor: 'var(--border)' }}>
                    <InvoiceForm view={view} invoice={invoice} busy={busy} error={error} onCancel={() => setEditing(null)} onSubmit={(d) => onSave(invoice.id, d, () => setEditing(null))} />
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function InvoiceForm({
  view,
  invoice,
  busy,
  error,
  onCancel,
  onSubmit,
}: {
  view: StatementView;
  invoice: InvoiceView | null;
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onSubmit: (draft: InvoiceDraft) => void;
}) {
  const id = useId();
  const [number, setNumber] = useState(invoice?.number ?? '');
  const [date, setDate] = useState(invoice?.issueDate ?? '');
  const [gross, setGross] = useState(invoice ? formatCents(invoice.grossCents) : '');
  const [treatment, setTreatment] = useState<InvoiceTreatment>(invoice?.treatment ?? (view.smallBusinessAtYearEnd === false ? 'standard' : 'small_business'));
  const [vat, setVat] = useState(invoice && invoice.vatCents > 0 ? formatCents(invoice.vatCents) : '');
  const [declared, setDeclared] = useState(invoice?.declaredInYear ? String(invoice.declaredInYear) : '');
  const [payments, setPayments] = useState<Array<{ date: string; amount: string }>>(
    () => invoice?.payments.map((p) => ({ date: p.date, amount: formatCents(p.cents) })) ?? [],
  );
  const [localError, setLocalError] = useState<string | null>(null);
  const taxed = treatment === 'standard' || treatment === 'reduced';

  function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!number.trim()) return setLocalError('Bitte die Rechnungsnummer eingeben.');
    const grossCents = parseEuro(gross);
    if (grossCents === null || grossCents <= 0) return setLocalError('Bitte den Rechnungsbetrag als Betrag größer als null eingeben.');
    let vatCents = 0;
    if (taxed) {
      const parsed = parseEuro(vat);
      if (parsed === null || parsed <= 0 || parsed >= grossCents) {
        return setLocalError('Bitte die enthaltene Umsatzsteuer eingeben: größer als null und kleiner als der Rechnungsbetrag.');
      }
      vatCents = parsed;
    }
    const declaredYear = declared.trim() === '' ? null : Number(declared);
    if (declaredYear !== null && (!Number.isInteger(declaredYear) || declaredYear < 1990 || declaredYear > 2100)) {
      return setLocalError('Bitte das Jahr prüfen, in dem die Rechnung bereits erklärt wurde.');
    }
    const parsedPayments: InvoiceDraft['payments'] = [];
    for (const p of payments) {
      // A row left completely empty is not a payment.
      if (!p.date && !p.amount.trim()) continue;
      const cents = parseEuro(p.amount);
      if (!p.date || cents === null || cents <= 0) return setLocalError('Bitte Datum und Betrag jedes Zahlungseingangs prüfen.');
      parsedPayments.push({ date: p.date, cents });
    }
    setLocalError(null);
    onSubmit({ number: number.trim(), issueDate: date || null, grossCents, vatCents, treatment, declaredInYear: declaredYear, payments: parsedPayments });
  }

  const shown = localError ?? error;
  return (
    <form onSubmit={submit} className="space-y-4" noValidate>
      <div className="grid gap-3 sm:grid-cols-3">
        <div>
          <label className="ui-label" htmlFor={`${id}-number`}>Rechnungsnummer</label>
          <input id={`${id}-number`} className="ui-input" value={number} onChange={(e) => setNumber(e.target.value)} maxLength={60} />
        </div>
        <div>
          <label className="ui-label" htmlFor={`${id}-date`}>Rechnungsdatum</label>
          <input id={`${id}-date`} type="date" className="ui-input" value={date} onChange={(e) => setDate(e.target.value)} />
        </div>
        <div>
          <label className="ui-label" htmlFor={`${id}-gross`}>Rechnungsbetrag in €</label>
          <input id={`${id}-gross`} className="ui-input tabular-nums" inputMode="decimal" value={gross} onChange={(e) => setGross(e.target.value)} />
        </div>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label className="ui-label" htmlFor={`${id}-treatment`}>Umsatzsteuer auf der Rechnung</label>
          <select id={`${id}-treatment`} className="ui-input" value={treatment} onChange={(e) => setTreatment(e.target.value as InvoiceTreatment)}>
            {(Object.keys(INVOICE_TREATMENT_LABELS) as InvoiceTreatment[]).map((t) => (
              <option key={t} value={t}>{INVOICE_TREATMENT_LABELS[t]}</option>
            ))}
          </select>
        </div>
        {taxed && (
          <div>
            <label className="ui-label" htmlFor={`${id}-vat`}>Enthaltene Umsatzsteuer in €</label>
            <input id={`${id}-vat`} className="ui-input tabular-nums" inputMode="decimal" value={vat} onChange={(e) => setVat(e.target.value)} />
          </div>
        )}
      </div>
      <fieldset>
        <legend className="ui-label">Zahlungseingänge</legend>
        {payments.length === 0 && <p className="text-sm" style={{ color: 'var(--muted)' }}>Noch kein Eingang: die Rechnung steht als offen.</p>}
        <ul className="space-y-2">
          {payments.map((p, index) => (
            <li key={index} className="flex flex-wrap items-end gap-2">
              <div>
                <label className="ui-label" htmlFor={`${id}-pd-${index}`}>Eingang am</label>
                <input id={`${id}-pd-${index}`} type="date" className="ui-input" value={p.date} onChange={(e) => setPayments((list) => list.map((x, i) => (i === index ? { ...x, date: e.target.value } : x)))} />
              </div>
              <div>
                <label className="ui-label" htmlFor={`${id}-pa-${index}`}>Betrag in €</label>
                <input id={`${id}-pa-${index}`} className="ui-input tabular-nums" inputMode="decimal" value={p.amount} onChange={(e) => setPayments((list) => list.map((x, i) => (i === index ? { ...x, amount: e.target.value } : x)))} />
              </div>
              <button type="button" className="ui-btn ui-btn-sm" onClick={() => setPayments((list) => list.filter((_, i) => i !== index))}>Entfernen</button>
            </li>
          ))}
        </ul>
        <button
          type="button"
          className="ui-btn ui-btn-sm mt-2"
          onClick={() => {
            // The usual case is one payment of the whole amount: offer what is still open.
            const grossCents = parseEuro(gross) ?? 0;
            const paid = payments.reduce((s, p) => s + (parseEuro(p.amount) ?? 0), 0);
            setPayments((list) => [...list, { date: '', amount: grossCents > paid ? formatCents(grossCents - paid) : '' }]);
          }}
        >
          Zahlungseingang hinzufügen
        </button>
      </fieldset>
      <div className="max-w-xs">
        <label className="ui-label" htmlFor={`${id}-declared`}>Bereits erklärt im Jahr (nur wenn zutreffend)</label>
        <input id={`${id}-declared`} className="ui-input tabular-nums" inputMode="numeric" value={declared} onChange={(e) => setDeclared(e.target.value)} placeholder="leer lassen" />
        <p className="mt-1 text-xs" style={{ color: 'var(--muted)' }}>
          Für Rechnungen, die eine frühere Erklärung schon nach Rechnungsdatum erfasst hat: ihr Geldeingang zählt dann
          nicht ein zweites Mal als Einnahme.
        </p>
      </div>
      {shown && <p className="ui-note ui-note-danger" role="alert">{shown}</p>}
      <div className="flex gap-2">
        <button type="submit" className="ui-btn ui-btn-primary" disabled={busy}>{busy ? 'Speichert …' : 'Rechnung speichern'}</button>
        <button type="button" className="ui-btn" onClick={onCancel}>Abbrechen</button>
      </div>
    </form>
  );
}
