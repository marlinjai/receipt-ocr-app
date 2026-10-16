'use client';

import Link from 'next/link';
import { receiptHref } from '@/lib/receipt-link';
import { useEffect, useId, useRef, useState } from 'react';
import { formatDay } from '@/lib/meals/messages';
import type { MatchStrength } from '@/lib/tax/payments/match';
import type { AccountKind, CounterpartyTreatment, FoundPayment, ImportResult } from '@/lib/tax/payments/service';
import type { RefundStrength } from '@/lib/tax/payments/refunds';
import { PAYMENT_FORMAT_LABELS } from '@/lib/tax/payments/types';
import type { PayLaterMethod } from '@/lib/tax/payments/tax-day';
import type { OpenPayment, PayLaterDayEntry, StatementView } from '@/lib/tax/service';
import type { Result } from './actions';
import { euro, parseEuro } from './amounts';

/** A search for payments to link by hand: one counterparty's, or any whose name, text or amount contains the words. */
export type PaymentQuery = { counterpartyKey: string } | { text: string };

interface Props {
  view: StatementView;
  busy: boolean;
  error: string | null;
  lastImport: ImportResult | null;
  onAddAccount: (input: { label: string; kind: AccountKind }, done: () => void) => void;
  /** With `onlyThisYear` only the payments booked in the year on screen are read. */
  onImport: (accountId: string, text: string, onlyThisYear: boolean, done: () => void) => void;
  onUndoImport: (batchId: string) => void;
  onTreat: (counterparty: string, treatment: CounterpartyTreatment | null) => void;
  onLink: (input: { paymentId: string; rowId?: string; invoiceId?: string; cents?: number }) => void;
  onUnlink: (linkId: string) => void;
  /**
   * Accept proposals for receipts on an estimated amount: the pairs the person
   * sees. The server links those of them it still proposes (with
   * `onlyUnambiguous`, those still unambiguous) and says what it did.
   */
  onAcceptProposals: (pairs: Array<{ paymentId: string; rowId: string }>, onlyUnambiguous: boolean) => void;
  /** Say that a payment is a transfer between own accounts (true), or a payment of its own (false). */
  onTransfer: (paymentId: string, isTransfer: boolean) => void;
  onNotIncome: (payment: OpenPayment) => void;
  /** Re-label one payment (private, refund), or with null put it back to what its file says. */
  onKind: (paymentId: string, kind: 'private' | 'refund' | null) => void;
  /** Say how one pay-later purchase was paid (by card, or at the checkout and paid later), or with null put it back to what the list says. */
  onPayMethod: (paymentId: string, method: 'card' | 'checkout' | null) => void;
  /** Say that a whole account is private (true), or take that back (false). */
  onAccountPrivate: (account: { id: string; label: string }, isPrivate: boolean) => void;
  /** Find payments of the year that still have something to link, whatever was answered about them. Read only. */
  onSearch: (query: PaymentQuery) => Promise<Result<{ payments: FoundPayment[]; total: number }>>;
}

const ACCOUNT_KIND_LABELS: Record<AccountKind, string> = { bank: 'Bankkonto', card: 'Kreditkarte', payment_service: 'Zahlungsdienst' };
const TREATMENT_LABELS: Record<CounterpartyTreatment, string> = { business: 'Betrieblich', private: 'Privat', own_account: 'Eigenes Konto', mixed: 'Teils, teils' };
const STRENGTH_LABELS: Record<MatchStrength | RefundStrength, string> = {
  reference: 'Nummer im Verwendungszweck, Betrag passt',
  reference_amount_differs: 'Nummer im Verwendungszweck, Betrag weicht ab',
  amount_date_vendor: 'Betrag, Datum und Lieferant passen',
  amount_and_date: 'nur Betrag und Datum passen',
  refund_reference: 'Erstattung: dieselbe Bestellnummer wie der Kauf',
  refund_full: 'Erstattung des ganzen Kaufs',
  refund_part: 'Teilerstattung eines Kaufs bei derselben Gegenseite',
};
const SKIP_LABELS: Record<string, string> = {
  not_booked: 'noch nicht gebucht',
  not_completed: 'nicht abgeschlossen',
  other_currency: 'andere Währung',
  memo_line: 'Hinweiszeilen',
  cancelled: 'storniert oder vollständig erstattet',
  zero_amount: 'ohne Betrag',
  duplicate_row: 'doppelt in der Datei',
  other_year: 'außerhalb des gewählten Jahres',
  covered_by_other_source: 'an Tagen, die eine andere Quelle dieses Kontos schon abdeckt',
};
const NOTICE_LABELS: Record<string, string> = {
  part_refunded: 'teilweise erstattet (der Kauf zählt voll; die Erstattung steht auf dem Bankkonto und wird dort dem Beleg zugeordnet)',
  unknown_status: 'mit unbekanntem Status (als Kauf eingelesen; falls storniert oder noch offen, die Zahlung bitte als privat oder Umbuchung kennzeichnen)',
  unknown_method: 'mit unbekannter Zahlungsart (als Kauf auf Rechnung gelesen: er zählt am Tag, an dem der Dienst ihn einzieht; war es die Karte, unter „Tag der Zahlung“ ändern)',
};
const PAY_METHOD_LABELS: Record<PayLaterMethod, string> = {
  card: 'mit der Karte bezahlt',
  financed: 'in Raten finanziert',
  direct_debit: 'per Lastschrift',
  checkout: 'auf Rechnung, später bezahlt',
};
const KIND_LABELS: Record<string, string> = {
  private: 'privat',
  refund: 'Erstattung oder Umbuchung',
  own_transfer: 'Übertrag zwischen eigenen Konten',
  spend: 'eigene Zahlung, kein Übertrag',
  income: 'eigener Geldeingang, kein Übertrag',
};
const SERVICE_LABELS: Record<string, string> = { paypal: 'PayPal', klarna: 'Klarna' };
const monthLabel = (month: string) => `${month.slice(5, 7)}/${month.slice(0, 4)}`;
const LINK_METHOD_LABELS: Record<string, string> = {
  reference: 'über die Rechnungsnummer',
  estimate: 'Vorschlag, von dir übernommen',
};

/**
 * Payments from the owner's accounts: importing export files, saying once how
 * a counterparty is treated, and linking payments to receipts and invoices.
 * A link is only made on a reference or by a person's confirmation.
 */
export default function PaymentsTab({ view, busy, error, lastImport, onAddAccount, onImport, onUndoImport, onTreat, onLink, onUnlink, onAcceptProposals, onTransfer, onNotIncome, onKind, onPayMethod, onAccountPrivate, onSearch }: Props) {
  const id = useId();
  const fileInput = useRef<HTMLInputElement>(null);
  const [label, setLabel] = useState('');
  const [kind, setKind] = useState<AccountKind>('bank');
  const [accountId, setAccountId] = useState(view.payments.accounts[0]?.id ?? '');
  const [localError, setLocalError] = useState<string | null>(null);
  const [onlyThisYear, setOnlyThisYear] = useState(false);
  // The payment whose picker for linking by hand is open. One at a time: the
  // picker lists every receipt, and one per open payment made the page draw
  // hundreds of thousands of entries on every action.
  const [manualFor, setManualFor] = useState<string | null>(null);
  // The unanswered counterparty whose payments are shown for linking one by one.
  const [browsing, setBrowsing] = useState<string | null>(null);
  const p = view.payments;
  // True from the press on "accept all" until the answer is in: the button says so and cannot be pressed again.
  const [accepting, setAccepting] = useState(false);
  const [wasBusy, setWasBusy] = useState(busy);
  if (wasBusy !== busy) {
    setWasBusy(busy);
    if (!busy) setAccepting(false);
  }
  const unambiguousPairs = p.estimateProposals.filter((x) => x.unambiguous).map((x) => ({ paymentId: x.paymentId, rowId: x.rowId }));
  const unambiguous = unambiguousPairs.length;
  const shown = localError ?? error;
  const selectedAccount = p.accounts.some((a) => a.id === accountId) ? accountId : (p.accounts[0]?.id ?? '');

  async function readAndImport() {
    const file = fileInput.current?.files?.[0];
    if (!selectedAccount) return setLocalError('Bitte zuerst ein Konto anlegen und auswählen.');
    if (!file) return setLocalError('Bitte eine Exportdatei auswählen.');
    if (file.size > 8 * 1024 * 1024) return setLocalError('Die Datei ist zu groß für einen Kontoexport (mehr als 8 MB).');
    let text: string;
    try {
      text = await file.text();
    } catch {
      return setLocalError('Die Datei konnte nicht gelesen werden.');
    }
    setLocalError(null);
    onImport(selectedAccount, text, onlyThisYear, () => {
      if (fileInput.current) fileInput.current.value = '';
    });
  }

  return (
    <div className="space-y-6">
      <section className="glass-panel rounded-xl p-4 sm:p-5" aria-label="Konten">
        <h2 className="text-base font-semibold" style={{ color: 'var(--foreground)' }}>Konten und Stand</h2>
        {p.accounts.length === 0 ? (
          <p className="ui-note mt-3">
            Noch kein Konto angelegt. Zahlungen geben einem Beleg sein tatsächliches Zahlungsdatum und den Eurobetrag,
            der wirklich abgebucht wurde; ohne sie zählt ein Beleg mit seinem Belegdatum.
          </p>
        ) : (
          <ul className="mt-3 space-y-3">
            {p.accounts.map((account) => (
              <li key={account.id} className="rounded-lg border p-3" style={{ borderColor: 'var(--border)' }}>
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <p className="text-sm font-medium" style={{ color: 'var(--foreground)' }}>
                    {account.label}
                    <span className="ml-2 text-xs font-normal" style={{ color: 'var(--muted)' }}>
                      {ACCOUNT_KIND_LABELS[account.kind as AccountKind] ?? account.kind} · {account.paymentCount} Zahlungen ·{' '}
                      {account.completeThrough ? `vollständig bis ${formatDay(account.completeThrough)}` : 'noch nichts eingelesen'}
                      {account.isPrivate ? ' · privat: nach seinen Zahlungen wird nicht gefragt' : ''}
                    </span>
                  </p>
                  {account.isPrivate ? (
                    <button type="button" className="ui-btn ui-btn-sm" disabled={busy} onClick={() => onAccountPrivate(account, false)}>
                      Wieder prüfen
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="ui-btn ui-btn-sm"
                      disabled={busy}
                      onClick={() => {
                        if (!window.confirm(`Ist „${account.label}“ als Ganzes privat? Nach seinen Zahlungen wird dann nicht mehr gefragt, auch nicht nach Geldeingängen. Einzelne Zahlungen lassen sich weiter von Hand einem Beleg zuordnen, und „Wieder prüfen“ nimmt das zurück.`)) return;
                        onAccountPrivate(account, true);
                      }}
                    >
                      Ganzes Konto ist privat
                    </button>
                  )}
                </div>
                {account.batches.length > 0 && (
                  <ul className="mt-2 space-y-1 text-xs" style={{ color: 'var(--muted)' }}>
                    {account.batches.map((batch) => (
                      <li key={batch.id} className="flex flex-wrap items-baseline justify-between gap-2">
                        <span>
                          {PAYMENT_FORMAT_LABELS[batch.format as keyof typeof PAYMENT_FORMAT_LABELS] ?? batch.format}, eingelesen am{' '}
                          {formatDay(batch.importedAt.slice(0, 10))}: {batch.newCount} neue von {batch.paymentCount} Zahlungen
                          {batch.firstDay && batch.lastDay ? ` (${formatDay(batch.firstDay)} bis ${formatDay(batch.lastDay)})` : ''}
                        </span>
                        <button
                          type="button"
                          className="ui-btn ui-btn-sm ui-btn-danger"
                          disabled={busy}
                          onClick={() => {
                            if (!window.confirm('Diesen Import rückgängig machen? Die dabei neu angelegten Zahlungen und ihre Zuordnungen werden entfernt.')) return;
                            onUndoImport(batch.id);
                          }}
                        >
                          Rückgängig
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        )}
        <form
          className="mt-4 flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (!label.trim()) return setLocalError('Bitte einen Namen für das Konto eingeben.');
            setLocalError(null);
            onAddAccount({ label: label.trim(), kind }, () => setLabel(''));
          }}
        >
          <div>
            <label className="ui-label" htmlFor={`${id}-label`}>Neues Konto</label>
            <input id={`${id}-label`} className="ui-input" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="z. B. Geschäftskonto" maxLength={80} />
          </div>
          <div>
            <label className="ui-label" htmlFor={`${id}-kind`}>Art</label>
            <select id={`${id}-kind`} className="ui-input" value={kind} onChange={(e) => setKind(e.target.value as AccountKind)}>
              {(Object.keys(ACCOUNT_KIND_LABELS) as AccountKind[]).map((k) => (
                <option key={k} value={k}>{ACCOUNT_KIND_LABELS[k]}</option>
              ))}
            </select>
          </div>
          <button type="submit" className="ui-btn" disabled={busy}>Konto anlegen</button>
        </form>
      </section>

      {p.accounts.length > 0 && (
        <section className="glass-panel rounded-xl p-4 sm:p-5" aria-label="Import">
          <h2 className="text-base font-semibold" style={{ color: 'var(--foreground)' }}>Kontoexport einlesen</h2>
          <div className="mt-3 flex flex-wrap items-end gap-2">
            <div>
              <label className="ui-label" htmlFor={`${id}-account`}>Konto</label>
              <select id={`${id}-account`} className="ui-input" value={selectedAccount} onChange={(e) => setAccountId(e.target.value)}>
                {p.accounts.map((a) => (
                  <option key={a.id} value={a.id}>{a.label}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="ui-label" htmlFor={`${id}-file`}>Datei (CSV oder JSON)</label>
              <input id={`${id}-file`} ref={fileInput} type="file" accept=".csv,.json,text/csv,application/json" className="ui-input" />
            </div>
            <label className="flex items-center gap-1.5 text-sm" style={{ color: 'var(--foreground)' }}>
              <input type="checkbox" checked={onlyThisYear} onChange={(e) => setOnlyThisYear(e.target.checked)} />
              Nur Zahlungen aus {view.year}
            </label>
            <button type="button" className="ui-btn ui-btn-primary" disabled={busy} onClick={readAndImport}>{busy ? 'Liest ein …' : 'Einlesen'}</button>
          </div>
          <p className="mt-2 text-xs" style={{ color: 'var(--muted)' }}>
            Unterstützt: Exporte von N26, Tomorrow und PayPal, die Kaufliste von Klarna sowie die Umsatzliste der
            Bankschnittstelle. Eine Datei wird ganz oder gar nicht eingelesen; überlappende Zeiträume legen nichts doppelt
            an. Was ein Zahlungsdienst später vom Bankkonto einzieht, gilt als Umbuchung zwischen eigenen Konten, sobald
            die Liste des Dienstes eingelesen ist. Ein Konto lässt sich aus einer zweiten Quelle fortsetzen (ein
            Bankexport, der mitten im Jahr endet, weiter mit der Umsatzliste der Bankschnittstelle): ein Tag gehört der
            Quelle, die ihn zuerst gebracht hat, die andere Datei liest nur die übrigen Tage. Mit „Nur Zahlungen aus{' '}
            {view.year}“ bleibt der Rest der Datei draußen; er lässt sich später noch einlesen.
          </p>
          {lastImport && (
            <p className="ui-note ui-note-ok mt-3" role="status">
              Eingelesen{lastImport.onlyYear !== null ? ` (nur ${lastImport.onlyYear})` : ''}: {lastImport.added} neue Zahlungen
              {lastImport.alreadyThere > 0 ? `, ${lastImport.alreadyThere} waren schon vorhanden` : ''}
              {lastImport.autoLinked > 0 ? `, ${lastImport.autoLinked} über die Rechnungsnummer einer Rechnung zugeordnet` : ''}
              {lastImport.adopted > 0 ? `, ${lastImport.adopted} schon vorhandene an ihrer neuen Nummer wiedererkannt` : ''}.
              {lastImport.cancelledEarlier > 0 &&
                ` ${lastImport.cancelledEarlier} früher eingelesene ${lastImport.cancelledEarlier === 1 ? 'Kauf ist' : 'Käufe sind'} laut dieser Datei storniert oder vollständig erstattet und ${lastImport.cancelledEarlier === 1 ? 'zählt' : 'zählen'} nicht mehr${
                  lastImport.releasedLinks > 0 ? `; ${lastImport.releasedLinks} ${lastImport.releasedLinks === 1 ? 'Zuordnung wurde' : 'Zuordnungen wurden'} gelöst, siehe „Stornierte Käufe“` : ''
                }.`}
              {Object.keys(lastImport.notices).length > 0 &&
                ` Bitte ansehen${lastImport.onlyYear !== null ? ' (gezählt über die ganze Datei)' : ''}: ${Object.entries(lastImport.notices)
                  .map(([reason, count]) => `${count} ${NOTICE_LABELS[reason] ?? reason}`)
                  .join(', ')}.`}
              {lastImport.unknownStatuses.length > 0 && ` Unbekannte Statusangaben: ${lastImport.unknownStatuses.map((w) => `„${w}“`).join(', ')}.`}
              {lastImport.unknownMethods.length > 0 && ` Unbekannte Zahlungsarten: ${lastImport.unknownMethods.map((w) => `„${w}“`).join(', ')}.`}
              {lastImport.detailFilled > 0 &&
                ` Bei ${lastImport.detailFilled} schon vorhandenen ${lastImport.detailFilled === 1 ? 'Kauf wurde' : 'Käufen wurde'} die Zahlungsart ergänzt; sonst blieb an ihnen alles, wie es war.`}
              {Object.keys(lastImport.skipped).length > 0 &&
                ` Bewusst ausgelassen${lastImport.onlyYear !== null ? ' (gezählt über die ganze Datei)' : ''}: ${Object.entries(lastImport.skipped)
                  .map(([reason, count]) => `${count} ${SKIP_LABELS[reason] ?? reason}`)
                  .join(', ')}.`}
            </p>
          )}
        </section>
      )}

      {shown && <p className="ui-note ui-note-danger" role="alert">{shown}</p>}

      {p.unclassified.length > 0 && (
        <section className="glass-panel rounded-xl p-4 sm:p-5" aria-label="Gegenseiten">
          <h2 className="text-base font-semibold" style={{ color: 'var(--foreground)' }}>Wer ist das? Einmal je Gegenseite</h2>
          <p className="mt-1 text-xs" style={{ color: 'var(--muted)' }}>
            Betriebliche Zahlungen brauchen einen Beleg; private werden für den Betrieb nicht weiter beachtet; eigene
            Konten sind nur Umbuchungen. „Teils, teils“ (ein Versandhändler, ein Supermarkt): nach keiner Zahlung wird
            gefragt, betrieblich ist, was du von Hand einem Beleg zuordnest. Die Antwort gilt für alle Zahlungen dieser
            Gegenseite. Eine einzelne Zahlung lässt sich auch ohne Antwort zuordnen: „Zahlungen ansehen“.
          </p>
          <ul className="mt-3 space-y-2">
            {p.unclassified.map((c) => (
              <li key={c.key} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border px-3 py-2" style={{ borderColor: 'var(--border)' }}>
                <span className="text-sm" style={{ color: 'var(--foreground)' }}>
                  {c.label}
                  <span className="ml-2 text-xs" style={{ color: 'var(--muted)' }}>
                    {c.count} {c.count === 1 ? 'Zahlung' : 'Zahlungen'}
                    {c.outCents > 0 ? ` · bezahlt ${euro(c.outCents)}` : ''}
                    {c.inCents > 0 ? ` · erhalten ${euro(c.inCents)}` : ''}
                  </span>
                </span>
                <span className="flex flex-wrap gap-1.5">
                  {(Object.keys(TREATMENT_LABELS) as CounterpartyTreatment[]).map((t) => (
                    <button key={t} type="button" className="ui-btn ui-btn-sm" disabled={busy} onClick={() => onTreat(c.label, t)}>{TREATMENT_LABELS[t]}</button>
                  ))}
                  <button
                    type="button"
                    className="ui-btn ui-btn-sm"
                    aria-expanded={browsing === c.key}
                    aria-controls={browsing === c.key ? `${id}-browse` : undefined}
                    onClick={() => setBrowsing(browsing === c.key ? null : c.key)}
                  >
                    Zahlungen ansehen
                  </button>
                </span>
                {browsing === c.key && (
                  <PaymentFinder id={`${id}-browse`} query={{ counterpartyKey: c.key }} view={view} busy={busy} onSearch={onSearch} onLink={onLink} />
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {p.estimateProposals.length > 0 && (
        <section className="glass-panel rounded-xl p-4 sm:p-5" aria-label="Vorschläge für geschätzte Belege">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="text-base font-semibold" style={{ color: 'var(--foreground)' }}>Belege mit geschätztem Eurobetrag: passende Zahlung</h2>
            {unambiguous > 0 && (
              <button
                type="button"
                className="ui-btn ui-btn-sm ui-btn-primary"
                disabled={busy || accepting}
                aria-busy={accepting}
                onClick={() => {
                  if (!window.confirm(`${unambiguous} ${unambiguous === 1 ? 'eindeutigen Vorschlag' : 'eindeutige Vorschläge'} übernehmen? Jede Zuordnung lässt sich unter „Zuordnungen und Regeln“ wieder lösen.`)) return;
                  setAccepting(true);
                  onAcceptProposals(unambiguousPairs, true);
                }}
              >
                {accepting
                  ? `Übernimmt ${unambiguous} ${unambiguous === 1 ? 'Vorschlag' : 'Vorschläge'} …`
                  : unambiguous === 1
                    ? 'Den einen eindeutigen Vorschlag übernehmen'
                    : `Alle ${unambiguous} eindeutigen Vorschläge übernehmen`}
              </button>
            )}
          </div>
          <p className="mt-1 text-xs" style={{ color: 'var(--muted)' }}>
            Ein Beleg in fremder Währung zählt mit einem geschätzten Eurobetrag, bis seine Zahlung zugeordnet ist.
            Vorgeschlagen wird eine Zahlung an denselben Lieferanten, gebucht von 3 Tagen vor bis 10 Tage nach dem
            Belegdatum, höchstens 8 % neben der Schätzung. Zugeordnet wird nur, was du übernimmst.
          </p>
          {accepting && (
            <p className="ui-note mt-3" role="status">
              Die Vorschläge werden zugeordnet und die Übersicht neu berechnet. Das dauert einige Sekunden; ein zweiter Klick ist nicht nötig und würde nichts doppelt anlegen.
            </p>
          )}
          <ul className="mt-3 space-y-2">
            {p.estimateProposals.map((proposal) => (
              <li key={`${proposal.rowId}:${proposal.paymentId}`} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border px-3 py-2" style={{ borderColor: 'var(--border)' }}>
                <span className="text-sm" style={{ color: 'var(--foreground)' }}>
                  {formatDay(proposal.receiptDay)}{' '}
                  <Link href={receiptHref(proposal.rowId)} className="hover:underline" title="Beleg in der Tabelle öffnen">
                    {proposal.receiptLabel.slice(0, 60)}
                  </Link>
                  <span className="ml-2 text-xs tabular-nums" style={{ color: 'var(--muted)' }}>
                    geschätzt {euro(proposal.estimateCents)} · bezahlt {euro(proposal.paidCents)} am {formatDay(proposal.bookingDay)}
                    {proposal.counterparty ? ` an ${proposal.counterparty.slice(0, 40)}` : ''} · {proposal.accountLabel}
                    {proposal.severalReceipts
                      ? ' · eine Zahlung für mehrere Belege? Der Betrag passt besser zu diesem und einem weiteren Beleg zusammen. Bitte unter „Zahlungen ohne Beleg“ von Hand mit Teilbetrag zuordnen.'
                      : proposal.unambiguous
                        ? ''
                        : ' · mehrdeutig, bitte einzeln prüfen'}
                  </span>
                </span>
                {!proposal.severalReceipts && (
                  <button type="button" className="ui-btn ui-btn-sm" disabled={busy} onClick={() => onAcceptProposals([{ paymentId: proposal.paymentId, rowId: proposal.rowId }], false)}>
                    Übernehmen
                  </button>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="glass-panel rounded-xl p-4 sm:p-5" aria-label="Offene Zahlungen">
        <h2 className="text-base font-semibold" style={{ color: 'var(--foreground)' }}>
          Zahlungen ohne Beleg oder Rechnung {view.year}
          <span className="ml-2 text-xs font-normal" style={{ color: 'var(--muted)' }}>
            {p.linkedCount} von {p.yearCount} Zahlungen zugeordnet
            {p.transferCount > 0 ? ` · ${p.transferCount} Umbuchungen zwischen eigenen Konten, nach denen nicht gefragt wird` : ''}
          </span>
        </h2>
        {p.open.length === 0 ? (
          <p className="mt-3 text-sm" style={{ color: 'var(--muted)' }}>
            {p.yearCount === 0 ? `Für ${view.year} sind keine Zahlungen eingelesen.` : 'Keine betriebliche Zahlung wartet auf einen Beleg, und kein Geldeingang auf eine Rechnung.'}
          </p>
        ) : (
          <ul className="mt-3 space-y-2">
            {p.open.map((payment) => (
              <li key={payment.id} className="rounded-lg border p-3" style={{ borderColor: 'var(--border)' }}>
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="text-sm" style={{ color: 'var(--foreground)' }}>
                    {payment.counterparty || 'ohne Namen'}
                    <span className="ml-2 text-xs" style={{ color: 'var(--muted)' }}>
                      {formatDay(payment.bookingDay)} · {payment.accountLabel}
                      {payment.reference ? ` · ${payment.reference.slice(0, 80)}` : ''}
                    </span>
                  </span>
                  <span className="text-sm tabular-nums" style={{ color: 'var(--foreground)' }}>
                    {payment.amountCents < 0 ? 'bezahlt' : 'erhalten'} {euro(Math.abs(payment.amountCents))}
                    {payment.freeCents !== Math.abs(payment.amountCents) ? `, davon offen ${euro(payment.freeCents)}` : ''}
                  </span>
                </div>
                <p className="mt-1 text-xs" style={{ color: 'var(--muted)' }}>
                  {payment.check === 'income_without_invoice'
                    ? payment.proposals.some((x) => x.target === 'receipt')
                      ? 'Geldeingang ohne Rechnung: eine Erstattung zu einem Beleg (Vorschlag unten; sie wird dann von seinen Kosten abgezogen), eine Einnahme oder privat?'
                      : 'Geldeingang ohne Rechnung: Einnahme (dann fehlt die Rechnung unter „Einnahmen“) oder privat?'
                    : payment.check === 'refund_without_receipt'
                      ? 'Erstattung: dem Beleg zuordnen, dessen Kauf sie rückgängig macht; sie wird dann von seinen Kosten abgezogen.'
                      : 'Betriebliche Zahlung ohne Beleg: Beleg hochladen und zuordnen.'}
                </p>
                <div className="mt-2 flex flex-wrap gap-2">
                  {payment.proposals.map((proposal) => (
                    <button
                      key={`${proposal.target}:${proposal.targetId}`}
                      type="button"
                      className="ui-btn ui-btn-sm"
                      disabled={busy}
                      onClick={() => onLink(proposal.target === 'invoice' ? { paymentId: payment.id, invoiceId: proposal.targetId } : { paymentId: payment.id, rowId: proposal.targetId })}
                    >
                      Zuordnen: {proposal.label} ({STRENGTH_LABELS[proposal.strength]})
                    </button>
                  ))}
                  {payment.check === 'income_without_invoice' && (
                    <button type="button" className="ui-btn ui-btn-sm" disabled={busy} onClick={() => onNotIncome(payment)}>
                      Keine Einnahme (Erstattung oder Umbuchung)
                    </button>
                  )}
                  {(payment.check === 'income_without_invoice' ? p.invoiceTargets.length + p.receiptTargets.length : p.receiptTargets.length) > 0 && (
                    <button
                      type="button"
                      className="ui-btn ui-btn-sm"
                      aria-expanded={manualFor === payment.id}
                      onClick={() => setManualFor(manualFor === payment.id ? null : payment.id)}
                    >
                      Von Hand zuordnen
                    </button>
                  )}
                  {payment.namesService && (
                    <button type="button" className="ui-btn ui-btn-sm" disabled={busy} onClick={() => onTransfer(payment.id, true)}>
                      Übertrag zwischen eigenen Konten
                    </button>
                  )}
                  {payment.counterparty ? (
                    <button type="button" className="ui-btn ui-btn-sm" disabled={busy} onClick={() => onTreat(payment.counterparty, 'private')}>
                      Gegenseite ist privat
                    </button>
                  ) : (
                    <button type="button" className="ui-btn ui-btn-sm" disabled={busy} onClick={() => onKind(payment.id, 'private')}>
                      Diese Zahlung ist privat
                    </button>
                  )}
                </div>
                {manualFor === payment.id && (
                  <ManualLink
                    payment={payment}
                    // Money in partly on an invoice already stays with invoices: a payment is on one kind of target only.
                    receipts={payment.check === 'income_without_invoice' && payment.freeCents !== Math.abs(payment.amountCents) ? [] : p.receiptTargets}
                    invoices={payment.check === 'income_without_invoice' ? p.invoiceTargets : []}
                    busy={busy}
                    onLink={onLink}
                  />
                )}
              </li>
            ))}
          </ul>
        )}
        {p.yearCount > 0 && <PaymentSearch view={view} busy={busy} onSearch={onSearch} onLink={onLink} />}
      </section>

      {(p.ruleTransfers.length > 0 || p.reconciliations.length > 0) && (
        <section className="glass-panel rounded-xl p-4 sm:p-5" aria-label="Umbuchungen zwischen eigenen Konten">
          <h2 className="text-base font-semibold" style={{ color: 'var(--foreground)' }}>Umbuchungen zwischen eigenen Konten {view.year}</h2>
          <p className="mt-1 text-xs" style={{ color: 'var(--muted)' }}>
            Was ein Zahlungsdienst vom Bankkonto einzieht, ist dasselbe Geld wie die Käufe in seiner eigenen Liste. Solche
            Abbuchungen gelten deshalb als Umbuchung: keine Ausgabe, keine Frage. Das gilt nur für Tage, die die
            eingelesene Liste des Dienstes abdeckt. Hier steht, was so behandelt wird, damit nichts unbemerkt verschwindet.
          </p>
          {p.reconciliations.map((r) => (
            <div key={r.service} className="mt-3">
              <p className={`ui-note ${r.reconciles ? 'ui-note-ok' : 'ui-note-danger'}`} role={r.reconciles ? undefined : 'alert'}>
                {SERVICE_LABELS[r.service] ?? r.service} ({r.accountLabels.join(', ')}): vom Bankkonto eingezogen {euro(r.collectedCents)}, Käufe laut Liste {euro(r.listedCents)},{' '}
                Differenz {euro(Math.abs(r.differenceCents))} {r.differenceCents > 0 ? 'mehr eingezogen als gelistet' : r.differenceCents < 0 ? 'weniger eingezogen als gelistet' : ''}.{' '}
                {r.reconciles
                  ? r.differenceCents < -r.toleranceCents
                    ? 'Das ist bei einem Guthabenkonto üblich: der Rest wurde aus Guthaben oder über eine Karte bezahlt. Nichts wurde eingezogen, das die Liste nicht erklärt.'
                    : 'Das passt zusammen.'
                  : `Das passt nicht zusammen (Toleranz ${euro(r.toleranceCents)}). ${
                      r.differenceCents > 0
                        ? 'Mehr eingezogen heißt: Käufe, die in der Liste fehlen (andere Währung, beim Export noch offen), Gebühren oder Zinsen, oder Käufe aus einem anderen Jahr. Die betreffende Abbuchung unten als eigene Zahlung kennzeichnen.'
                        : 'Weniger eingezogen heißt: Käufe werden erst später eingezogen (Zahlungsziel, Raten), wurden erstattet, oder die Abbuchung liegt in einem anderen Jahr.'
                    }`}
              </p>
              {r.months.length > 0 && (
              <details className="mt-2">
                <summary className="cursor-pointer text-sm" style={{ color: 'var(--foreground)' }}>Abgleich je Monat</summary>
                <table className="mt-2 w-full text-left text-xs tabular-nums" style={{ color: 'var(--foreground)' }}>
                  <thead>
                    <tr style={{ color: 'var(--muted)' }}>
                      <th scope="col" className="py-1 pr-3 font-normal">Monat</th>
                      <th scope="col" className="py-1 pr-3 font-normal">Eingezogen</th>
                      <th scope="col" className="py-1 pr-3 font-normal">Käufe laut Liste</th>
                      <th scope="col" className="py-1 pr-3 font-normal">Differenz</th>
                      <th scope="col" className="py-1 font-normal">Laufend</th>
                    </tr>
                  </thead>
                  <tbody>
                    {r.months.map((m) => (
                      <tr key={m.month}>
                        <td className="py-0.5 pr-3">{monthLabel(m.month)}</td>
                        <td className="py-0.5 pr-3">{euro(m.collectedCents)}</td>
                        <td className="py-0.5 pr-3">{euro(m.listedCents)}</td>
                        <td className="py-0.5 pr-3">{m.differenceCents < 0 ? '-' : ''}{euro(Math.abs(m.differenceCents))}</td>
                        <td className="py-0.5">{m.runningCents < 0 ? '-' : ''}{euro(Math.abs(m.runningCents))}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </details>
              )}
            </div>
          ))}
          {p.ruleTransfers.length > 0 && (
            <details className="mt-3">
              <summary className="cursor-pointer text-sm" style={{ color: 'var(--foreground)' }}>
                {p.ruleTransfers.length} {p.ruleTransfers.length === 1 ? 'Zahlung' : 'Zahlungen'} als Umbuchung behandelt, zusammen {euro(Math.abs(p.ruleTransferCents))}
              </summary>
              <ul className="mt-2 space-y-1.5 text-sm" style={{ color: 'var(--foreground)' }}>
                {p.ruleTransfers.map((transfer) => (
                  <li key={transfer.id} className="flex flex-wrap items-baseline justify-between gap-2">
                    <span>
                      {formatDay(transfer.bookingDay)} {transfer.counterparty || 'ohne Namen'} {transfer.amountCents < 0 ? 'bezahlt' : 'erhalten'} {euro(Math.abs(transfer.amountCents))}
                      <span className="ml-2 text-xs" style={{ color: 'var(--muted)' }}>
                        {transfer.accountLabel}
                        {transfer.reference ? ` · ${transfer.reference.slice(0, 60)}` : ''}
                        {transfer.hasTwin ? ' · der Kauf dazu steht in der Liste des Dienstes' : ''}
                        {transfer.linkedTo.length > 0 ? ` · zugeordnet zu: ${transfer.linkedTo.join(', ')}` : ''}
                      </span>
                    </span>
                    <button type="button" className="ui-btn ui-btn-sm" disabled={busy} onClick={() => onTransfer(transfer.id, false)}>
                      Kein Übertrag, eine eigene Zahlung
                    </button>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </section>
      )}

      {p.cancelled.length > 0 && (
        <section className="glass-panel rounded-xl p-4 sm:p-5" aria-label="Stornierte Käufe">
          <h2 className="text-base font-semibold" style={{ color: 'var(--foreground)' }}>Stornierte Käufe {view.year}</h2>
          <p className="mt-1 text-xs" style={{ color: 'var(--muted)' }}>
            Diese Käufe wurden als bezahlt eingelesen; eine später eingelesene Liste führt sie als storniert oder
            vollständig erstattet. Sie zählen nirgends mehr. Der Import, der das gemeldet hat, lässt sich rückgängig
            machen; dann zählen sie und ihre Zuordnungen wieder.
          </p>
          <ul className="mt-3 space-y-1.5 text-sm" style={{ color: 'var(--foreground)' }}>
            {p.cancelled.map((payment) => (
              <li key={payment.id}>
                {formatDay(payment.bookingDay)} {payment.counterparty || 'ohne Namen'} {euro(Math.abs(payment.amountCents))}
                <span className="ml-2 text-xs" style={{ color: 'var(--muted)' }}>
                  {payment.accountLabel}
                  {payment.releasedFrom.length > 0 ? ` · Zuordnung gelöst von: ${payment.releasedFrom.join(', ')}. Der Beleg zählt wieder mit seinem eigenen Betrag.` : ''}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <PayLaterDays days={p.payLaterDays} year={view.year} busy={busy} onPayMethod={onPayMethod} />

      {p.overridden.length > 0 && (
        <section className="glass-panel rounded-xl p-4 sm:p-5" aria-label="Umgewidmete Zahlungen">
          <h2 className="text-base font-semibold" style={{ color: 'var(--foreground)' }}>Von dir umgewidmete Zahlungen</h2>
          <ul className="mt-3 space-y-1.5 text-sm" style={{ color: 'var(--foreground)' }}>
            {p.overridden.map((payment) => (
              <li key={payment.id} className="flex flex-wrap items-baseline justify-between gap-2">
                <span>
                  {formatDay(payment.bookingDay)} {payment.counterparty || 'ohne Namen'} {euro(Math.abs(payment.amountCents))}:{' '}
                  {KIND_LABELS[payment.kind] ?? payment.kind}
                </span>
                <button type="button" className="ui-btn ui-btn-sm" disabled={busy} onClick={() => onKind(payment.id, null)}>Zurücksetzen</button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {(p.links.length > 0 || p.treatments.length > 0) && (
        <section className="glass-panel rounded-xl p-4 sm:p-5" aria-label="Zuordnungen">
          <h2 className="text-base font-semibold" style={{ color: 'var(--foreground)' }}>Zuordnungen und Regeln</h2>
          {p.links.length > 0 && (
            <ul className="mt-3 space-y-1.5 text-sm" style={{ color: 'var(--foreground)' }}>
              {p.links.map((link) => (
                <li key={link.linkId} className="flex flex-wrap items-baseline justify-between gap-2">
                  <span>
                    {formatDay(link.bookingDay)} {link.counterparty || 'ohne Namen'} {euro(link.cents)} →{' '}
                    {link.rowId ? (
                      <Link href={receiptHref(link.rowId)} className="hover:underline" title="Beleg in der Tabelle öffnen">
                        {link.targetLabel}
                      </Link>
                    ) : (
                      link.targetLabel
                    )}
                    <span className="ml-2 text-xs" style={{ color: 'var(--muted)' }}>
                      {LINK_METHOD_LABELS[link.method] ?? 'von dir bestätigt'}
                      {link.counts ? '' : ' · zählt nicht doppelt: der Kauf, den diese Abbuchung bezahlt, ist demselben Beleg zugeordnet'}
                    </span>
                  </span>
                  <button type="button" className="ui-btn ui-btn-sm" disabled={busy} onClick={() => onUnlink(link.linkId)}>Lösen</button>
                </li>
              ))}
            </ul>
          )}
          {p.treatments.length > 0 && (
            <ul className="mt-4 space-y-1.5 text-sm" style={{ color: 'var(--foreground)' }}>
              {p.treatments.map((rule) => (
                <li key={rule.key} className="flex flex-wrap items-baseline justify-between gap-2">
                  <span>{rule.label}: {TREATMENT_LABELS[rule.treatment]}</span>
                  <button type="button" className="ui-btn ui-btn-sm" disabled={busy} onClick={() => onTreat(rule.label, null)}>Antwort zurücknehmen</button>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </div>
  );
}

/**
 * Which day pay-later purchases count on, where a person should look: a
 * purchase paid later at a shop's checkout counts when the service collects
 * it, a card purchase on its purchase day. Each can be said to be the other.
 */
function PayLaterDays({ days, year, busy, onPayMethod }: { days: StatementView['payments']['payLaterDays']; year: number; busy: boolean; onPayMethod: Props['onPayMethod'] }) {
  if (days.moved.length === 0 && days.unknown.length === 0 && days.relabelled.length === 0 && days.withoutDetail === 0) return null;
  const line = (entry: PayLaterDayEntry, extra: string) => (
    <span>
      {formatDay(entry.bookingDay)} {entry.counterparty || 'ohne Namen'} {euro(Math.abs(entry.amountCents))}
      <span className="ml-2 text-xs" style={{ color: 'var(--muted)' }}>
        {entry.method ? PAY_METHOD_LABELS[entry.method] : 'Zahlungsart unbekannt'}
        {extra}
        {entry.linkedTo.length > 0 ? ` · zugeordnet: ${entry.linkedTo.join(', ')}` : ''}
      </span>
    </span>
  );
  return (
    <section className="glass-panel rounded-xl p-4 sm:p-5" aria-label="Tag der Zahlung bei Käufen über den Später-bezahlen-Dienst">
      <h2 className="text-base font-semibold" style={{ color: 'var(--foreground)' }}>Tag der Zahlung bei Später-bezahlen-Käufen</h2>
      <p className="mt-1 text-xs" style={{ color: 'var(--muted)' }}>
        Ein Kauf mit der Karte des Dienstes oder in Raten zählt an seinem Kauftag. Ein Kauf auf Rechnung, im Shop als
        Zahlungsart gewählt und später bezahlt, zählt erst an dem Tag, an dem der Dienst das Geld vom Konto einzieht. Ist
        ein Kauf falsch erkannt, lässt er sich hier umstellen.
      </p>
      {days.moved.length > 0 && (
        <>
          <h3 className="mt-3 text-sm font-medium" style={{ color: 'var(--foreground)' }}>Gekauft im einen Jahr, eingezogen im nächsten</h3>
          <p className="mt-1 text-xs" style={{ color: 'var(--muted)' }}>
            Diese Käufe zählen im Jahr des Einzugs. Bitte ansehen: war einer davon mit der Karte bezahlt, zählt er im Jahr des Kaufs.
          </p>
          <ul className="mt-2 space-y-1.5 text-sm" style={{ color: 'var(--foreground)' }}>
            {days.moved.map((entry) => (
              <li key={entry.id} className="flex flex-wrap items-baseline justify-between gap-2">
                {line(entry, ` · zählt am ${formatDay(entry.taxDay)}`)}
                {!entry.byPerson && (
                  <button type="button" className="ui-btn ui-btn-sm" disabled={busy} onClick={() => onPayMethod(entry.id, 'card')}>Mit der Karte bezahlt</button>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
      {days.unknown.length > 0 && (
        <>
          <h3 className="mt-3 text-sm font-medium" style={{ color: 'var(--foreground)' }}>Einzugstag unbekannt</h3>
          <p className="mt-1 text-xs" style={{ color: 'var(--muted)' }}>
            Für diese Käufe auf Rechnung fand sich kein Einzug, der ihre Abrechnung bezahlt (Bankkonto nicht eingelesen,
            oder in Teilen bezahlt). Sie zählen bis dahin an ihrem Kauftag ({year}).
          </p>
          <ul className="mt-2 space-y-1.5 text-sm" style={{ color: 'var(--foreground)' }}>
            {days.unknown.map((entry) => (
              <li key={entry.id} className="flex flex-wrap items-baseline justify-between gap-2">
                {line(entry, '')}
                {!entry.byPerson && (
                  <button type="button" className="ui-btn ui-btn-sm" disabled={busy} onClick={() => onPayMethod(entry.id, 'card')}>Mit der Karte bezahlt</button>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
      {days.relabelled.length > 0 && (
        <>
          <h3 className="mt-3 text-sm font-medium" style={{ color: 'var(--foreground)' }}>Von dir umgestellt</h3>
          <ul className="mt-2 space-y-1.5 text-sm" style={{ color: 'var(--foreground)' }}>
            {days.relabelled.map((entry) => (
              <li key={entry.id} className="flex flex-wrap items-baseline justify-between gap-2">
                {line(entry, entry.taxDay !== entry.bookingDay ? ` · zählt am ${formatDay(entry.taxDay)}` : '')}
                <span className="flex flex-wrap gap-2">
                  {entry.method === 'card' ? (
                    <button type="button" className="ui-btn ui-btn-sm" disabled={busy} onClick={() => onPayMethod(entry.id, 'checkout')}>Auf Rechnung bezahlt</button>
                  ) : (
                    <button type="button" className="ui-btn ui-btn-sm" disabled={busy} onClick={() => onPayMethod(entry.id, 'card')}>Mit der Karte bezahlt</button>
                  )}
                  <button type="button" className="ui-btn ui-btn-sm" disabled={busy} onClick={() => onPayMethod(entry.id, null)}>Zurücksetzen</button>
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
      {days.withoutDetail > 0 && (
        <p className="ui-note mt-3 text-xs">
          {days.withoutDetail} {days.withoutDetail === 1 ? 'Kauf wurde' : 'Käufe wurden'} eingelesen, bevor die Zahlungsart
          aufbewahrt wurde, und {days.withoutDetail === 1 ? 'zählt' : 'zählen'} vorerst am Kauftag. Die Liste des Dienstes
          einmal neu einlesen (mit „Nur Zahlungen aus einem Jahr“ oder nach dem Rückgängigmachen des Imports): dann wird die
          Zahlungsart ergänzt, sonst ändert sich nichts.
        </p>
      )}
    </section>
  );
}

/**
 * Linking by hand, for everything no proposal covers: an amount that differs
 * (a fee kept on the way), a receipt of last year paid this year, one payment
 * for two receipts. Drawn only for the payment whose picker was opened.
 */
function ManualLink({
  payment,
  receipts,
  invoices,
  busy,
  onLink,
}: {
  payment: Pick<OpenPayment, 'id' | 'freeCents'>;
  receipts: StatementView['payments']['receiptTargets'];
  invoices: StatementView['payments']['invoiceTargets'];
  busy: boolean;
  onLink: Props['onLink'];
}) {
  const id = useId();
  const [target, setTarget] = useState('');
  const [amount, setAmount] = useState('');
  const [localError, setLocalError] = useState<string | null>(null);
  if (receipts.length === 0 && invoices.length === 0) return null;
  return (
    <form
      className="mt-2 flex flex-wrap items-end gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (!target) return setLocalError('Bitte einen Beleg oder eine Rechnung wählen.');
        const cents = amount.trim() === '' ? undefined : (parseEuro(amount) ?? -1);
        if (cents !== undefined && (cents <= 0 || cents > payment.freeCents)) {
          return setLocalError('Der Betrag muss größer als null sein und darf nicht über dem liegen, was von der Zahlung noch offen ist.');
        }
        setLocalError(null);
        const [kind, targetId] = [target.slice(0, 2), target.slice(2)];
        onLink({ paymentId: payment.id, ...(kind === 'i:' ? { invoiceId: targetId } : { rowId: targetId }), ...(cents !== undefined ? { cents } : {}) });
      }}
    >
      <div>
        <label className="ui-label" htmlFor={`${id}-target`}>
          {invoices.length > 0 && receipts.length > 0 ? 'Rechnung oder Beleg (Erstattung) von Hand wählen' : invoices.length > 0 ? 'Rechnung von Hand wählen' : 'Beleg von Hand wählen'}
        </label>
        <select id={`${id}-target`} className="ui-input" value={target} onChange={(e) => setTarget(e.target.value)}>
          <option value="">Bitte wählen</option>
          {invoices.length > 0 && (
            <optgroup label="Rechnungen">
              {invoices.map((i) => (
                <option key={i.id} value={`i:${i.id}`}>{i.label} (offen {euro(i.openCents)})</option>
              ))}
            </optgroup>
          )}
          {receipts.length > 0 && (
            <optgroup label={invoices.length > 0 ? 'Belege (das Geld ist eine Erstattung)' : 'Belege'}>
              {receipts.map((r) => (
                <option key={r.id} value={`r:${r.id}`}>
                  {formatDay(r.day)} {r.label.slice(0, 60)}{r.amountCents !== null ? ` (${euro(r.amountCents)})` : ''}{r.linkedCents > 0 ? `, schon zugeordnet ${euro(r.linkedCents)}` : ''}
                </option>
              ))}
            </optgroup>
          )}
        </select>
      </div>
      <div>
        <label className="ui-label" htmlFor={`${id}-amount`}>Teilbetrag in € (leer: alles Offene)</label>
        <input id={`${id}-amount`} className="ui-input tabular-nums" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
      </div>
      <button type="submit" className="ui-btn ui-btn-sm" disabled={busy}>Zuordnen</button>
      {localError && <p className="ui-note ui-note-danger w-full" role="alert">{localError}</p>}
    </form>
  );
}

/**
 * Any payment of the year, found by name, text or amount, linked by hand.
 * Reaches what no question lists: a payment of a counterparty nobody answered
 * yet or answered as mixed, and one on an account said to be private (a
 * business expense paid privately).
 */
function PaymentSearch({ view, busy, onSearch, onLink }: { view: StatementView; busy: boolean; onSearch: Props['onSearch']; onLink: Props['onLink'] }) {
  const id = useId();
  const [draft, setDraft] = useState('');
  // Each press on "Suchen" is a new search, also with the same words.
  const [search, setSearch] = useState<{ text: string; round: number } | null>(null);
  const tooShort = draft.trim().length === 1;
  return (
    <div className="mt-4">
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          const text = draft.trim();
          setSearch(text.length >= 2 ? { text, round: (search?.round ?? 0) + 1 } : null);
        }}
      >
        <div>
          <label className="ui-label" htmlFor={`${id}-q`}>Andere Zahlung suchen und von Hand zuordnen</label>
          <input
            id={`${id}-q`}
            className="ui-input"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Name, Verwendungszweck oder Betrag"
            maxLength={80}
            aria-describedby={tooShort ? `${id}-hint` : undefined}
          />
        </div>
        <button type="submit" className="ui-btn ui-btn-sm">Suchen</button>
      </form>
      {tooShort && <p id={`${id}-hint`} className="mt-1 text-xs" style={{ color: 'var(--muted)' }}>Bitte mindestens zwei Zeichen.</p>}
      {search !== null && <PaymentFinder query={{ text: search.text }} round={search.round} view={view} busy={busy} onSearch={onSearch} onLink={onLink} />}
    </div>
  );
}

type Found = { payments: FoundPayment[]; total: number };

/**
 * The payments of a search, each with a picker for linking by hand. Searched
 * again whenever the statement changes, so a payment just linked in full drops
 * out and one partly linked shows what is left. While a new search runs the
 * last results stay on screen, so an open picker and the keyboard focus are
 * not thrown away.
 */
function PaymentFinder({
  id,
  query,
  round = 0,
  view,
  busy,
  onSearch,
  onLink,
}: {
  id?: string;
  query: PaymentQuery;
  round?: number;
  view: StatementView;
  busy: boolean;
  onSearch: Props['onSearch'];
  onLink: Props['onLink'];
}) {
  const [found, setFound] = useState<Found | null>(null);
  const [failed, setFailed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [retry, setRetry] = useState(0);
  const [open, setOpen] = useState<string | null>(null);
  const queryKey = 'counterpartyKey' in query ? `c:${query.counterpartyKey}` : `t:${query.text}`;
  // What the search was last run for: a new query, a new press, a retry or a new statement searches again.
  const runKey = `${queryKey}|${round}|${retry}`;
  const [searched, setSearched] = useState<{ query: string; key: string; view: StatementView } | null>(null);
  if (searched === null || searched.key !== runKey || searched.view !== view) {
    // A different query starts from nothing; the same query keeps its last results and its open picker while it reloads.
    if (searched !== null && searched.query !== queryKey) {
      setFound(null);
      setOpen(null);
    }
    setSearched({ query: queryKey, key: runKey, view });
    setLoading(true);
    setFailed(false);
  }
  useEffect(() => {
    let current = true;
    onSearch(query).then(
      (result) => {
        if (!current) return;
        setLoading(false);
        if (result.ok) setFound(result.value);
        else setFailed(true);
      },
      () => {
        if (!current) return;
        setLoading(false);
        setFailed(true);
      },
    );
    return () => {
      current = false;
    };
    // `query` is described by `runKey`; the statement is in the list on purpose: every change to it searches again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runKey, view]);
  const p = view.payments;
  return (
    <div id={id} className="mt-2 w-full">
      {/* One live region, always there, so a screen reader hears the search start and what it found. */}
      <p className="text-xs" style={{ color: 'var(--muted)' }} role="status">
        {loading ? 'Sucht …' : found !== null && !failed ? (found.total === 1 ? '1 Zahlung gefunden.' : `${found.total} Zahlungen gefunden.`) : ''}
      </p>
      {failed && (
        <p className="ui-note ui-note-danger" role="alert">
          Die Zahlungen konnten nicht geladen werden.{' '}
          <button type="button" className="ui-btn ui-btn-sm" onClick={() => setRetry(retry + 1)}>Erneut versuchen</button>
        </p>
      )}
      {found !== null && !failed && found.payments.length === 0 && !loading && (
        <p className="text-xs" style={{ color: 'var(--muted)' }}>Keine Zahlung aus {view.year} mit offenem Betrag.</p>
      )}
      {found !== null && found.total > found.payments.length && (
        <p className="text-xs" style={{ color: 'var(--muted)' }}>
          {found.total} gefunden, die ersten {found.payments.length} werden gezeigt. Bitte die Suche genauer fassen.
        </p>
      )}
      {found !== null && found.payments.length > 0 && (
        <ul className="mt-1 space-y-1.5" aria-label="Gefundene Zahlungen">
          {found.payments.map((payment) => {
            // Money in goes on an invoice, or on a receipt as money back, unless it is on one of them already.
            const invoices = payment.target === 'invoice' && payment.linkedTo !== 'receipt' ? p.invoiceTargets : [];
            const receipts = payment.target === 'receipt' || payment.linkedTo !== 'invoice' ? p.receiptTargets : [];
            const targets = invoices.length + receipts.length;
            const what = `${formatDay(payment.bookingDay)} ${payment.counterparty || 'ohne Namen'} ${euro(Math.abs(payment.amountCents))}`;
            return (
              <li key={payment.id} className="rounded-lg border px-3 py-2" style={{ borderColor: 'var(--border)' }}>
                <div className="flex flex-wrap items-baseline justify-between gap-2 text-sm" style={{ color: 'var(--foreground)' }}>
                  <span>
                    {formatDay(payment.bookingDay)} {payment.counterparty || 'ohne Namen'}
                    <span className="ml-2 text-xs" style={{ color: 'var(--muted)' }}>
                      {payment.accountLabel}
                      {payment.reference ? ` · ${payment.reference.slice(0, 80)}` : ''}
                      {payment.kind === 'private' ? ' · privat' : payment.kind === 'own_transfer' ? ' · Umbuchung' : ''}
                    </span>
                  </span>
                  <span className="tabular-nums">
                    {payment.amountCents < 0 ? 'bezahlt' : 'erhalten'} {euro(Math.abs(payment.amountCents))}
                    {payment.freeCents !== Math.abs(payment.amountCents) ? `, davon offen ${euro(payment.freeCents)}` : ''}
                    <button
                      type="button"
                      className="ui-btn ui-btn-sm ml-2"
                      aria-expanded={open === payment.id}
                      aria-label={`${payment.target === 'invoice' ? 'Rechnung' : 'Beleg'} wählen für ${what}`}
                      onClick={() => setOpen(open === payment.id ? null : payment.id)}
                    >
                      {payment.target === 'invoice' ? 'Rechnung wählen' : 'Beleg wählen'}
                    </button>
                  </span>
                </div>
                {open === payment.id &&
                  (targets > 0 ? (
                    <ManualLink
                      payment={payment}
                      receipts={receipts}
                      invoices={invoices}
                      busy={busy}
                      onLink={onLink}
                    />
                  ) : (
                    <p className="mt-1 text-xs" style={{ color: 'var(--muted)' }}>
                      {payment.target === 'invoice' ? 'Keine Rechnung mit offenem Betrag.' : 'Kein Beleg aus diesem oder dem Vorjahr vorhanden.'}
                    </p>
                  ))}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
