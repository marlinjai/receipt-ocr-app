'use client';

import { useId, useRef, useState } from 'react';
import { formatDay } from '@/lib/meals/messages';
import type { MatchStrength } from '@/lib/tax/payments/match';
import type { AccountKind, CounterpartyTreatment, ImportResult } from '@/lib/tax/payments/service';
import { PAYMENT_FORMAT_LABELS } from '@/lib/tax/payments/types';
import type { OpenPayment, StatementView } from '@/lib/tax/service';
import { euro } from './amounts';

interface Props {
  view: StatementView;
  busy: boolean;
  error: string | null;
  lastImport: ImportResult | null;
  onAddAccount: (input: { label: string; kind: AccountKind }, done: () => void) => void;
  onImport: (accountId: string, text: string, done: () => void) => void;
  onUndoImport: (batchId: string) => void;
  onTreat: (counterparty: string, treatment: CounterpartyTreatment | null) => void;
  onLink: (input: { paymentId: string; rowId?: string; invoiceId?: string }) => void;
  onUnlink: (linkId: string) => void;
  onNotIncome: (payment: OpenPayment) => void;
}

const ACCOUNT_KIND_LABELS: Record<AccountKind, string> = { bank: 'Bankkonto', card: 'Kreditkarte', payment_service: 'Zahlungsdienst' };
const TREATMENT_LABELS: Record<CounterpartyTreatment, string> = { business: 'Betrieblich', private: 'Privat', own_account: 'Eigenes Konto' };
const STRENGTH_LABELS: Record<MatchStrength, string> = {
  reference: 'Nummer im Verwendungszweck, Betrag passt',
  reference_amount_differs: 'Nummer im Verwendungszweck, Betrag weicht ab',
  amount_and_date: 'nur Betrag und Datum passen',
};
const SKIP_LABELS: Record<string, string> = {
  not_booked: 'noch nicht gebucht',
  not_completed: 'nicht abgeschlossen',
  other_currency: 'andere Währung',
  memo_line: 'Hinweiszeilen',
};

/**
 * Payments from the owner's accounts: importing export files, saying once how
 * a counterparty is treated, and linking payments to receipts and invoices.
 * A link is only made on a reference or by a person's confirmation.
 */
export default function PaymentsTab({ view, busy, error, lastImport, onAddAccount, onImport, onUndoImport, onTreat, onLink, onUnlink, onNotIncome }: Props) {
  const id = useId();
  const fileInput = useRef<HTMLInputElement>(null);
  const [label, setLabel] = useState('');
  const [kind, setKind] = useState<AccountKind>('bank');
  const [accountId, setAccountId] = useState(view.payments.accounts[0]?.id ?? '');
  const [localError, setLocalError] = useState<string | null>(null);
  const p = view.payments;
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
    onImport(selectedAccount, text, () => {
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
                <p className="text-sm font-medium" style={{ color: 'var(--foreground)' }}>
                  {account.label}
                  <span className="ml-2 text-xs font-normal" style={{ color: 'var(--muted)' }}>
                    {ACCOUNT_KIND_LABELS[account.kind as AccountKind] ?? account.kind} · {account.paymentCount} Zahlungen ·{' '}
                    {account.completeThrough ? `vollständig bis ${formatDay(account.completeThrough)}` : 'noch nichts eingelesen'}
                  </span>
                </p>
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
            <button type="button" className="ui-btn ui-btn-primary" disabled={busy} onClick={readAndImport}>{busy ? 'Liest ein …' : 'Einlesen'}</button>
          </div>
          <p className="mt-2 text-xs" style={{ color: 'var(--muted)' }}>
            Unterstützt: Exporte von N26, Tomorrow und PayPal sowie die Umsatzliste der Bankschnittstelle. Eine Datei wird
            ganz oder gar nicht eingelesen; überlappende Zeiträume legen nichts doppelt an.
          </p>
          {lastImport && (
            <p className="ui-note ui-note-ok mt-3" role="status">
              Eingelesen: {lastImport.added} neue Zahlungen
              {lastImport.alreadyThere > 0 ? `, ${lastImport.alreadyThere} waren schon vorhanden` : ''}
              {lastImport.autoLinked > 0 ? `, ${lastImport.autoLinked} über die Rechnungsnummer einer Rechnung zugeordnet` : ''}.
              {Object.keys(lastImport.skipped).length > 0 &&
                ` Bewusst ausgelassen: ${Object.entries(lastImport.skipped)
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
            Konten sind nur Umbuchungen. Die Antwort gilt für alle Zahlungen dieser Gegenseite.
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
                <span className="flex gap-1.5">
                  {(Object.keys(TREATMENT_LABELS) as CounterpartyTreatment[]).map((t) => (
                    <button key={t} type="button" className="ui-btn ui-btn-sm" disabled={busy} onClick={() => onTreat(c.label, t)}>{TREATMENT_LABELS[t]}</button>
                  ))}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="glass-panel rounded-xl p-4 sm:p-5" aria-label="Offene Zahlungen">
        <h2 className="text-base font-semibold" style={{ color: 'var(--foreground)' }}>
          Zahlungen ohne Beleg oder Rechnung {view.year}
          <span className="ml-2 text-xs font-normal" style={{ color: 'var(--muted)' }}>{p.linkedCount} von {p.yearCount} Zahlungen zugeordnet</span>
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
                    ? 'Geldeingang ohne Rechnung: Einnahme (dann fehlt die Rechnung unter „Einnahmen“) oder privat?'
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
                  {payment.counterparty && (
                    <button type="button" className="ui-btn ui-btn-sm" disabled={busy} onClick={() => onTreat(payment.counterparty, 'private')}>
                      Gegenseite ist privat
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {(p.links.length > 0 || p.treatments.length > 0) && (
        <section className="glass-panel rounded-xl p-4 sm:p-5" aria-label="Zuordnungen">
          <h2 className="text-base font-semibold" style={{ color: 'var(--foreground)' }}>Zuordnungen und Regeln</h2>
          {p.links.length > 0 && (
            <ul className="mt-3 space-y-1.5 text-sm" style={{ color: 'var(--foreground)' }}>
              {p.links.map((link) => (
                <li key={link.linkId} className="flex flex-wrap items-baseline justify-between gap-2">
                  <span>
                    {formatDay(link.bookingDay)} {link.counterparty || 'ohne Namen'} {euro(link.cents)} → {link.targetLabel}
                    <span className="ml-2 text-xs" style={{ color: 'var(--muted)' }}>{link.method === 'reference' ? 'über die Rechnungsnummer' : 'von dir bestätigt'}</span>
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
