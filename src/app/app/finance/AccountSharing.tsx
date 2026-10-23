'use client';

import { useId, useState, useTransition } from 'react';
import Link from 'next/link';
import { formatDay } from '@/lib/meals/messages';
import type { Result } from './actions';
import type { ShareEntry, SharingView } from './sharing-actions';

/** The server actions this section calls; injected so tests can stand in for them. */
export interface SharingActions {
  shareAccountWith: (accountId: string, targetWorkspaceId: string) => Promise<Result<SharingView>>;
  endAccountShare: (shareId: string) => Promise<Result<SharingView>>;
}

/** What went wrong, in words a person can act on. */
export function sharingMessage(result: Extract<Result<unknown>, { ok: false }>): string {
  if (result.error === 'unauthorized') return 'Die Anmeldung ist abgelaufen. Bitte die Seite neu laden und neu anmelden.';
  if (result.error === 'forbidden')
    return 'Dafür fehlt die Berechtigung: weitergeben darf nur, wer in beiden Firmen Mitglied ist und dort ändern darf.';
  if (result.detail === 'already_shared') return 'Die privaten Zahlungen dieses Kontos gehen schon an eine Firma. Bitte die Seite neu laden.';
  if (result.detail === 'same_company') return 'Das ist diese Firma selbst. Bitte eine andere Firma wählen.';
  if (result.detail === 'account_not_found') return 'Dieses Konto gibt es in dieser Firma nicht mehr. Bitte die Seite neu laden.';
  if (result.detail === 'share_not_found') return 'Diese Weitergabe ist schon beendet. Bitte die Seite neu laden.';
  return 'Das hat nicht geklappt. Bitte noch einmal versuchen; wenn es wieder scheitert, die Seite neu laden.';
}

const other = (s: ShareEntry) => s.otherName ?? 'eine andere Firma';

function AccountRow({
  account,
  share,
  view,
  pending,
  onShare,
  onEnd,
}: {
  account: { id: string; label: string };
  share: ShareEntry | undefined;
  view: SharingView;
  pending: boolean;
  onShare: (targetWorkspaceId: string, targetLabel: string) => void;
  onEnd: (share: ShareEntry) => void;
}) {
  const id = useId();
  const [target, setTarget] = useState('');
  if (share) {
    return (
      <li className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
        <span style={{ color: 'var(--foreground)' }}>
          {account.label}: private Zahlungen gehen an {other(share)}
          <span className="ml-2 text-xs" style={{ color: 'var(--muted)' }}>
            seit {formatDay(share.createdAt.slice(0, 10))}
          </span>
        </span>
        {view.canWrite && (
          <button type="button" className="ui-btn ui-btn-sm" disabled={pending} onClick={() => onEnd(share)} aria-label={`Weitergabe beenden: ${account.label} an ${other(share)}`}>
            Weitergabe beenden
          </button>
        )}
      </li>
    );
  }
  if (!view.canWrite || view.targets.length === 0) return null;
  const chosen = view.targets.find((t) => t.workspaceId === target);
  return (
    <li className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
      <span style={{ color: 'var(--foreground)' }}>{account.label}</span>
      <span className="flex flex-wrap items-center gap-2">
        <label className="sr-only" htmlFor={`${id}-target`}>
          Firma für die privaten Zahlungen von {account.label}
        </label>
        <select id={`${id}-target`} className="ui-input" style={{ width: 'auto' }} value={target} disabled={pending} onChange={(e) => setTarget(e.target.value)}>
          <option value="">Firma wählen</option>
          {view.targets.map((t) => (
            <option key={t.workspaceId} value={t.workspaceId}>
              {t.label}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="ui-btn ui-btn-sm"
          disabled={pending || !chosen}
          aria-label={`Private Zahlungen weitergeben: ${account.label}`}
          onClick={() => chosen && onShare(chosen.workspaceId, chosen.label)}
        >
          Private Zahlungen weitergeben
        </button>
      </span>
    </li>
  );
}

/**
 * The payments tab's section for an account whose private payments belong in
 * another company of the same person (plan 2026-10-22, payments across
 * companies). The account stays here, connected once; what its answers here
 * call private shows in the other company's spending overview, budgets and
 * missing receipts. Nothing is copied, and ending it brings everything back.
 */
export default function AccountSharing({ initial, accounts, actions }: { initial: SharingView; accounts: ReadonlyArray<{ id: string; label: string }>; actions: SharingActions }) {
  const headingId = useId();
  const [view, setView] = useState(initial);
  // Fresh data from the server (a reload of the page's data) replaces what this section holds.
  const [shown, setShown] = useState(initial);
  if (shown !== initial) {
    setShown(initial);
    setView(initial);
  }
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const run = (action: () => Promise<Result<SharingView>>, message: string) => {
    setError(null);
    setDone(null);
    startTransition(async () => {
      try {
        const result = await action();
        if (result.ok) {
          setView(result.value);
          setDone(message);
        } else setError(sharingMessage(result));
      } catch {
        setError(sharingMessage({ ok: false, error: 'failed' }));
      }
    });
  };

  const byAccount = new Map(view.outgoing.map((s) => [s.accountId, s]));
  const offerable = accounts.some((a) => byAccount.has(a.id)) || (view.canWrite && view.targets.length > 0 && accounts.length > 0);
  if (!offerable && view.incoming.length === 0) return null;

  const share = (account: { id: string; label: string }, targetWorkspaceId: string, targetLabel: string) => {
    if (
      !window.confirm(
        `Private Zahlungen von „${account.label}“ an ${targetLabel} weitergeben? Das Konto bleibt hier, mit seiner Bankverbindung und allen Fragen. Was hier als privat beantwortet ist (auch Zahlungen einer Gegenseite „Teils, teils“ und eines ganz privaten Kontos, solange hier kein Beleg daran hängt), erscheint dann in ${targetLabel} unter Ausgaben, mit Budgets und fehlenden Belegen, und zählt hier unter Ausgaben nicht mehr mit. Geschäftliche und noch nicht beantwortete Zahlungen, Umbuchungen und hier verknüpfte Zahlungen bleiben hier. Beenden bringt alles zurück.`,
      )
    )
      return;
    run(() => actions.shareAccountWith(account.id, targetWorkspaceId), `${account.label}: private Zahlungen gehen jetzt an ${targetLabel}.`);
  };
  const end = (s: ShareEntry, label: string) => {
    if (!window.confirm(`Die Weitergabe von „${label}“ beenden? Die privaten Zahlungen erscheinen dann wieder nur in der Firma, die das Konto führt. Dort verknüpfte private Belege bleiben gespeichert und gelten wieder, wenn erneut weitergegeben wird.`)) return;
    run(() => actions.endAccountShare(s.id), `${label}: Weitergabe beendet.`);
  };

  return (
    <section className="glass-panel rounded-xl p-4 sm:p-5" aria-labelledby={headingId}>
      <h2 id={headingId} className="text-base font-semibold" style={{ color: 'var(--foreground)' }}>
        Private Zahlungen in einer anderen Firma
      </h2>
      <p className="mt-1 text-xs" style={{ color: 'var(--muted)' }}>
        Ein Konto wird nur einmal eingelesen und verbunden. Was hier als privat beantwortet ist (Gegenseite privat, Zahlung privat, ein
        ganz privates Konto, und Zahlungen einer Gegenseite „Teils, teils“, solange hier kein Beleg daran hängt), erscheint in der
        gewählten Firma unter{' '}
        <Link href="/app/spending" className="underline">
          Ausgaben
        </Link>
        . Geschäftliche und noch nicht beantwortete Zahlungen, Umbuchungen und hier verknüpfte Zahlungen bleiben hier; eine geänderte
        Antwort gilt sofort.
      </p>
      {offerable && (
        <ul className="mt-2 divide-y">
          {accounts.map((a) => (
            <AccountRow
              key={a.id}
              account={a}
              share={byAccount.get(a.id)}
              view={view}
              pending={pending}
              onShare={(targetWorkspaceId, targetLabel) => share(a, targetWorkspaceId, targetLabel)}
              onEnd={(s) => end(s, a.label)}
            />
          ))}
        </ul>
      )}
      {view.incoming.length > 0 && (
        <>
          <h3 className="mt-3 text-sm font-medium" style={{ color: 'var(--foreground)' }}>
            Aus anderen Firmen
          </h3>
          <ul className="mt-1 divide-y">
            {view.incoming.map((s) => (
              <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
                <span style={{ color: 'var(--foreground)' }}>
                  {s.accountLabel}, geführt von {other(s)}: die privaten Zahlungen erscheinen hier unter Ausgaben.
                </span>
                {view.canWrite && (
                  <button type="button" className="ui-btn ui-btn-sm" disabled={pending} onClick={() => end(s, s.accountLabel)} aria-label={`Weitergabe beenden: ${s.accountLabel}`}>
                    Weitergabe beenden
                  </button>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
      <div aria-live="polite">
        {error && (
          <p className="ui-note ui-note-danger mt-3" role="alert">
            {error}
          </p>
        )}
        {done && !error && (
          <p className="ui-note mt-3" role="status">
            {done}
          </p>
        )}
      </div>
    </section>
  );
}
