'use client';

import { useId, useState, useTransition } from 'react';
import { formatDay } from '@/lib/meals/messages';
import { bankMessage, preselectInstitution } from '@/lib/tax/payments/bank/messages';
import type { BankConnectionView } from '@/lib/tax/payments/bank/service';
import type { StatementView } from '@/lib/tax/service';
import type { Result } from './actions';
import type { BankView, Institution } from './bank-actions';

/** One notice of a connection to clear. */
export type BankNotice = { kind: 'gap'; from: string; to: string } | { kind: 'skipped'; day: string } | { kind: 'unrated'; day: string } | { kind: 'undated'; keys: string[] };

/** The server actions the bank controls use; injected so the screen can be tested without a server. */
export interface BankActions {
  listBankInstitutions: () => Promise<Result<Institution[]>>;
  startBankConsent: (accountId: string, institution: { name: string; country: string }) => Promise<Result<{ url: string }>>;
  chooseBankConnectionAccount: (connectionId: string, uid: string) => Promise<Result<BankView>>;
  syncBankNow: (year: number, connectionId: string) => Promise<Result<{ bank: BankView; view: StatementView; outcome: { status: string; added: number; error?: string } }>>;
  disconnectBank: (connectionId: string) => Promise<Result<{ bank: BankView; closedAtBank: boolean }>>;
  clearBankConnectionNotice: (connectionId: string, notice: BankNotice) => Promise<Result<BankView>>;
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
    clearNotice: (accountId: string, connectionId: string, notice: BankNotice) =>
      act(accountId, () => actions.clearBankConnectionNotice(connectionId, notice), (v) => {
        setBank(v);
        return 'Hinweis erledigt.';
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
          : `Live über die Bankschnittstelle (${connection.aspspName}), noch nicht abgeholt. Tage, die schon eine eingelesene Liste abdeckt, bleiben bei ihr`,
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
      return { text: `${connection.aspspName}: bitte das Konto wählen; bis dahin wird nichts abgeholt`, tone: 'warn' };
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
  // A renewal or a choice elsewhere changes the bound account: the selection follows it.
  const [seenUid, setSeenUid] = useState(connection?.accountUid ?? null);
  if ((connection?.accountUid ?? null) !== seenUid) {
    setSeenUid(connection?.accountUid ?? null);
    setUid(connection?.accountUid ?? '');
  }
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
      {connection && connection.notices.gaps.map((gap) => (
        <p key={`gap-${gap.from}`} className="mt-1 flex flex-wrap items-baseline gap-2" style={{ color: TONE_COLOR.warn }}>
          <span>
            Die Tage vom {formatDay(gap.from)} bis {formatDay(gap.to)} kann die Bank nicht mehr liefern (die Freigabe kam später als 90 Tage).
            Bitte mit dem Datei-Import nachholen.
          </span>
          <button
            type="button"
            className="ui-btn ui-btn-sm"
            disabled={busy}
            aria-label={`Erledigt: Lücke vom ${formatDay(gap.from)} bis ${formatDay(gap.to)}`}
            onClick={() => feed.clearNotice(account.id, connection.id, { kind: 'gap', from: gap.from, to: gap.to })}
          >
            Erledigt
          </button>
        </p>
      ))}
      {connection && connection.notices.skipped.length > 0 && (
        <div className="mt-1" style={{ color: TONE_COLOR.warn }}>
          <p>
            An diesen Tagen beschreibt die Bank eine Buchung zu unvollständig, sie wurde ausgelassen. Der nächste Abruf versucht es
            erneut; sonst bitte mit dem Kontoauszug oder dem Datei-Import prüfen.
          </p>
          <ul className="mt-1 flex flex-wrap gap-2">
            {connection.notices.skipped.map((day) => (
              <li key={day} className="flex items-baseline gap-1">
                {formatDay(day)}
                <button
                  type="button"
                  className="ui-btn ui-btn-sm"
                  disabled={busy}
                  aria-label={`Erledigt: ausgelassene Buchung vom ${formatDay(day)}`}
                  onClick={() => feed.clearNotice(account.id, connection.id, { kind: 'skipped', day })}
                >
                  Erledigt
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {connection && connection.notices.unrated.length > 0 && (
        <div className="mt-1" style={{ color: TONE_COLOR.warn }}>
          <p>
            An diesen Tagen fehlt für eine Zahlung in anderer Währung der Referenzkurs; sie wurde noch nicht übernommen. Jeder
            Abruf versucht es erneut und übernimmt sie, sobald es den Kurs gibt. Gibt es für die Währung keinen Kurs, bringt der
            Import der PayPal-Liste die Zahlung mit dem tatsächlichen Eurobetrag; danach diesen Tag als erledigt markieren.
          </p>
          <ul className="mt-1 flex flex-wrap gap-2">
            {connection.notices.unrated.map((day) => (
              <li key={day} className="flex items-baseline gap-1">
                {formatDay(day)}
                <button
                  type="button"
                  className="ui-btn ui-btn-sm"
                  disabled={busy}
                  aria-label={`Erledigt: fehlender Kurs am ${formatDay(day)}`}
                  onClick={() => feed.clearNotice(account.id, connection.id, { kind: 'unrated', day })}
                >
                  Erledigt
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {connection && connection.notices.undated.length > 0 && (
        <p className="mt-1 flex flex-wrap items-baseline gap-2" style={{ color: TONE_COLOR.warn }}>
          <span>
            {connection.notices.undated.length === 1 ? 'Eine Buchung' : `${connection.notices.undated.length} Buchungen`} ohne lesbares Datum hat die Bank geliefert;
            sie {connection.notices.undated.length === 1 ? 'wurde' : 'wurden'} ausgelassen. Bitte die letzten Tage mit dem Kontoauszug oder dem Datei-Import prüfen.
          </span>
          <button
            type="button"
            className="ui-btn ui-btn-sm"
            disabled={busy}
            aria-label="Erledigt: Buchungen ohne Datum"
            onClick={() => feed.clearNotice(account.id, connection.id, { kind: 'undated', keys: connection.notices.undated })}
          >
            Erledigt
          </button>
        </p>
      )}
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
      {enabled && connection && (connection.status === 'choose_account' || (connection.status === 'active' && connection.candidates.length > 1)) && (
        <form
          className="mt-2 flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (!uid) return;
            const pick = connection.candidates.find((c) => c.uid === uid);
            const other = (connection.boundMask !== null || connection.boundName !== null) && (pick?.mask !== connection.boundMask || pick?.name !== (connection.boundName ?? ''));
            if (
              other &&
              !window.confirm(
                `Das ist nicht das Konto, das bisher gelesen wurde (${[connection.boundName, connection.boundMask].filter(Boolean).join(' ')}). Seine Zahlungen kommen dann in „${account.label}“. Nur übernehmen, wenn es dasselbe Konto ist; für ein anderes Konto bitte ein eigenes Konto anlegen.`,
              )
            )
              return;
            feed.choose(account.id, connection.id, uid);
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
