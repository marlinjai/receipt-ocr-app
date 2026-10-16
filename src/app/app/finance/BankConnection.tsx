'use client';

import { useId, useState, useTransition } from 'react';
import { formatDay } from '@/lib/meals/messages';
import { bankMessage, preselectInstitution } from '@/lib/tax/payments/bank/messages';
import type { BankConnectionView } from '@/lib/tax/payments/bank/service';
import type { StatementView } from '@/lib/tax/service';
import type { Result } from './actions';
import type { BankView, Institution } from './bank-actions';

/** The server actions the bank controls use; injected so the screen can be tested without a server. */
export interface BankActions {
  listBankInstitutions: () => Promise<Result<Institution[]>>;
  startBankConsent: (accountId: string, institution: { name: string; country: string }) => Promise<Result<{ url: string }>>;
  chooseBankConnectionAccount: (connectionId: string, uid: string) => Promise<Result<BankView>>;
  syncBankNow: (year: number, connectionId: string) => Promise<Result<{ bank: BankView; view: StatementView; outcome: { status: string; added: number; error?: string } }>>;
  disconnectBank: (connectionId: string) => Promise<Result<{ bank: BankView; closedAtBank: boolean }>>;
}

const dayOf = (iso: string | null) => (iso ? formatDay(iso.slice(0, 10)) : '');

/**
 * The bank state of the payments tab: the view, one action at a time, and the
 * message of the last one (per account, so it shows where it was pressed).
 */
export function useBankFeed(initial: BankView, year: number, actions: BankActions, onStatement: (view: StatementView) => void, go: (url: string) => void) {
  const [bank, setBank] = useState(initial);
  const [message, setMessage] = useState<{ accountId: string; text: string; ok: boolean } | null>(null);
  const [pending, startTransition] = useTransition();

  function act<T>(accountId: string, call: () => Promise<Result<T>>, onOk: (value: T) => string | null) {
    setMessage(null);
    startTransition(async () => {
      let result: Result<T>;
      try {
        result = await call();
      } catch {
        setMessage({ accountId, text: bankMessage('failed'), ok: false });
        return;
      }
      if (!result.ok) {
        setMessage({ accountId, text: bankMessage(result.detail ?? result.error), ok: false });
        return;
      }
      const text = onOk(result.value);
      if (text) setMessage({ accountId, text, ok: true });
    });
  }

  return {
    bank,
    pending,
    message,
    start: (accountId: string, institution: { name: string; country: string }) =>
      act(accountId, () => actions.startBankConsent(accountId, institution), (v) => {
        go(v.url);
        return 'Weiter zur Bank …';
      }),
    choose: (accountId: string, connectionId: string, uid: string) =>
      act(accountId, () => actions.chooseBankConnectionAccount(connectionId, uid), (v) => {
        setBank(v);
        return 'Konto übernommen. „Jetzt abholen“ holt seine Zahlungen.';
      }),
    sync: (accountId: string, connectionId: string) =>
      act(accountId, () => actions.syncBankNow(year, connectionId), (v) => {
        setBank(v.bank);
        onStatement(v.view);
        const o = v.outcome;
        if (o.status === 'synced') return `${o.added} ${o.added === 1 ? 'neue Zahlung' : 'neue Zahlungen'} abgeholt.`;
        if (o.status === 'nothing_new') return 'Abgeholt: nichts Neues.';
        if (o.status === 'not_active') return 'Diese Verbindung ist nicht aktiv.';
        return null; // expired, revoked, rate limited, failed: the status line says it
      }),
    disconnect: (accountId: string, connectionId: string) =>
      act(accountId, () => actions.disconnectBank(connectionId), (v) => {
        setBank(v.bank);
        return v.closedAtBank
          ? 'Verbindung getrennt. Die abgeholten Zahlungen bleiben.'
          : 'Verbindung hier getrennt; die Bank war nicht erreichbar, ihre Freigabe läuft von selbst ab. Die abgeholten Zahlungen bleiben.';
      }),
  };
}

export type BankFeed = ReturnType<typeof useBankFeed>;

function statusLine(connection: BankConnectionView | undefined): { text: string; tone: 'muted' | 'warn' | 'danger' } {
  if (!connection) return { text: 'Datei-Import', tone: 'muted' };
  switch (connection.status) {
    case 'active':
      return {
        text: connection.lastSyncedAt
          ? `Live über die Bankschnittstelle (${connection.aspspName}), zuletzt abgeholt am ${dayOf(connection.lastSyncedAt)}`
          : `Live über die Bankschnittstelle (${connection.aspspName}), noch nicht abgeholt`,
        tone: 'muted',
      };
    case 'expired':
    case 'revoked':
      return {
        text: `Verbindung ${connection.status === 'revoked' ? 'beendet' : 'abgelaufen'}${connection.validUntil && connection.status === 'expired' ? ` am ${dayOf(connection.validUntil)}` : ''}, bitte erneuern${
          connection.lastBookedThrough ? `. Vollständig bis ${formatDay(connection.lastBookedThrough)}` : ''
        }`,
        tone: 'warn',
      };
    case 'choose_account':
      return { text: `${connection.aspspName}: bitte das Konto wählen`, tone: 'warn' };
    case 'pending':
      return { text: `Freigabe bei ${connection.pendingAspspName ?? connection.aspspName} nicht abgeschlossen`, tone: 'warn' };
    case 'error':
    default:
      return { text: `Fehler: ${bankMessage(connection.lastError)}`, tone: 'danger' };
  }
}

const TONE_COLOR = { muted: 'var(--muted)', warn: 'var(--accent)', danger: 'var(--danger)' } as const;

/** The bank status and buttons of one account in the payments tab. */
export function BankAccountStatus({
  account,
  feed,
  actions,
  enabled,
}: {
  account: { id: string; label: string };
  feed: BankFeed;
  actions: Pick<BankActions, 'listBankInstitutions'>;
  enabled: boolean;
}) {
  const id = useId();
  const connection = feed.bank.connections.find((c) => c.accountId === account.id);
  const [picking, setPicking] = useState(false);
  const [institutions, setInstitutions] = useState<Institution[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [chosen, setChosen] = useState('');
  const [uid, setUid] = useState(connection?.accountUid ?? '');
  const busy = feed.pending;
  const line = statusLine(connection);
  const message = feed.message?.accountId === account.id ? feed.message : null;

  async function openPicker() {
    setPicking(true);
    setLoadError(null);
    if (institutions) return;
    try {
      const result = await actions.listBankInstitutions();
      if (!result.ok) return setLoadError(bankMessage(result.detail ?? result.error));
      setInstitutions(result.value);
      const guess = preselectInstitution(account.label, result.value) ?? (connection ? result.value.find((i) => i.name === connection.aspspName) ?? null : null);
      if (guess) {
        setChosen(guess.name);
        setSearch(guess.name);
      }
    } catch {
      setLoadError(bankMessage('network'));
    }
  }

  const filtered = (institutions ?? []).filter((i) => i.name.toLowerCase().includes(search.trim().toLowerCase())).slice(0, 50);
  const live = connection && connection.status !== 'pending' && connection.status !== 'error';

  return (
    <div className="mt-2 text-xs" aria-label={`Bankverbindung ${account.label}`}>
      <p style={{ color: TONE_COLOR[line.tone] }}>
        {line.text}
        {connection?.status === 'active' && connection.lastError && ` · letzter Abruf: ${bankMessage(connection.lastError)}`}
      </p>
      {connection?.status === 'active' && connection.renewSoon && connection.validUntil && (
        <p className="mt-1" style={{ color: TONE_COLOR.warn }}>
          Die Freigabe läuft am {dayOf(connection.validUntil)} ab. Bitte rechtzeitig erneuern.
        </p>
      )}
      {!enabled ? (
        connection ? <p className="mt-1" style={{ color: 'var(--muted)' }}>{bankMessage('feature_off')}</p> : null
      ) : (
        <div className="mt-2 flex flex-wrap gap-2">
          {connection?.status === 'active' && (
            <button type="button" className="ui-btn ui-btn-sm" disabled={busy} onClick={() => feed.sync(account.id, connection.id)}>
              Jetzt abholen
            </button>
          )}
          {!picking && (
            <button type="button" className="ui-btn ui-btn-sm" disabled={busy} onClick={openPicker}>
              {!connection ? 'Live mit der Bank verbinden' : live ? 'Freigabe erneuern' : 'Neu starten'}
            </button>
          )}
          {connection && (
            <button
              type="button"
              className="ui-btn ui-btn-sm ui-btn-danger"
              disabled={busy}
              onClick={() => {
                if (!window.confirm(`Die Bankverbindung von „${account.label}“ trennen? Die bisher abgeholten Zahlungen bleiben; das Konto wird danach wieder aus Dateien eingelesen.`)) return;
                feed.disconnect(account.id, connection.id);
              }}
            >
              Trennen
            </button>
          )}
        </div>
      )}
      {enabled && connection && connection.candidates.length > 1 && (connection.status === 'choose_account' || connection.status === 'active') && (
        <form
          className="mt-2 flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (uid) feed.choose(account.id, connection.id, uid);
          }}
        >
          <div>
            <label className="ui-label" htmlFor={`${id}-uid`}>
              {connection.status === 'choose_account' ? 'Welches Konto der Bank ist dieses?' : 'Konto der Bank'}
            </label>
            <select id={`${id}-uid`} className="ui-input" value={uid} onChange={(e) => setUid(e.target.value)}>
              <option value="">Bitte wählen</option>
              {connection.candidates.map((c) => (
                <option key={c.uid} value={c.uid}>
                  {[c.name || 'Konto', c.mask, c.currency].filter(Boolean).join(' · ')}
                </option>
              ))}
            </select>
          </div>
          <button type="submit" className="ui-btn ui-btn-sm" disabled={busy || !uid || uid === connection.accountUid}>
            Übernehmen
          </button>
        </form>
      )}
      {enabled && picking && (
        <form
          className="mt-2 flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            const pick = (institutions ?? []).find((i) => i.name === chosen);
            if (pick) feed.start(account.id, { name: pick.name, country: pick.country });
          }}
        >
          <div>
            <label className="ui-label" htmlFor={`${id}-search`}>Bank suchen</label>
            <input id={`${id}-search`} className="ui-input" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="z. B. N26" disabled={!institutions} />
          </div>
          <div>
            <label className="ui-label" htmlFor={`${id}-aspsp`}>Bank</label>
            <select id={`${id}-aspsp`} className="ui-input" value={chosen} onChange={(e) => setChosen(e.target.value)} disabled={!institutions}>
              <option value="">{institutions ? `Bitte wählen (${filtered.length} Treffer)` : 'Liste wird geladen …'}</option>
              {filtered.map((i) => (
                <option key={`${i.country}-${i.name}`} value={i.name}>
                  {i.name}
                  {i.beta ? ' (Testbetrieb)' : ''}
                </option>
              ))}
            </select>
          </div>
          <button type="submit" className="ui-btn ui-btn-sm ui-btn-primary" disabled={busy || !chosen}>
            Weiter zur Bank
          </button>
          <button type="button" className="ui-btn ui-btn-sm" onClick={() => setPicking(false)}>
            Abbrechen
          </button>
          {institutions && filtered.length === 0 && (
            <p className="w-full" style={{ color: 'var(--muted)' }}>
              Keine Bank mit diesem Namen über die Bankschnittstelle. Das Konto bleibt beim Datei-Import.
            </p>
          )}
        </form>
      )}
      {loadError && (
        <p className="mt-1" role="alert" style={{ color: TONE_COLOR.danger }}>
          {loadError}
        </p>
      )}
      <p role="status" aria-live="polite" className="mt-1 min-h-4" style={{ color: message && !message.ok ? TONE_COLOR.danger : 'var(--muted)' }}>
        {message?.text}
      </p>
    </div>
  );
}
