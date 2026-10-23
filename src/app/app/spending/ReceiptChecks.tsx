'use client';

import { useEffect, useId, useRef, useState, useTransition } from 'react';
import Link from 'next/link';
import { formatDay } from '@/lib/meals/messages';
import { receiptHref } from '@/lib/receipt-link';
import { formatCents } from '@/lib/tax/money';
import { createBrowserDeps, type SaveReceipt } from '@/lib/upload/browser-deps';
import { processReceipt } from '../actions';
import { switchWorkspace } from '../workspace-actions';
import { takeOverMail, takeOverMessage } from './take-over-mail';
import { browserPushEnvironment, currentSubscription, pushSwitchMessage, switchPushOff, switchPushOn, type PushEnvironment } from './push-device';
import type { PaymentCheck } from '@/lib/spending/loop-service';
import type { ChecksRun } from '@/lib/spending/checks';
import { useRouter } from 'next/navigation';
import type { ChannelSetting } from '@/lib/spending/notify/port';
import {
  checkNow,
  confirmReceipt,
  dismissMail,
  disablePush,
  enablePush,
  pushStateOfDevice,
  findReceiptChoices,
  getReceiptChecks,
  linkChosenReceipt,
  linkTakenOver,
  readNotification,
  saveNotificationSettings,
  sayNoReceipt,
  takeBackNoReceipt,
  type ChecksResult,
  type ChecksView,
} from './loop-actions';
import type { ReceiptChoice } from '@/lib/spending/loop';

/**
 * The missing-receipt loop on the spending page: payments waiting for a
 * receipt (with a proposed receipt to confirm where one fits), the "no
 * receipt exists" answers, the in-app notifications, and how the owner wants
 * to be told.
 */

function euro(cents: number): string {
  return `${formatCents(cents)} €`;
}

const CHANNEL_LABELS: Record<ChannelSetting, string> = {
  push: 'Push aufs Telefon, sonst E-Mail',
  email: 'Nur E-Mail',
  in_app: 'Nur hier in der App',
};

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** What a run did, in a sentence. */
export function runSummary(checks: ChecksRun): string {
  const sentences: string[] = [];
  const run = checks.loop;
  if (run) {
    const parts = [
      `Geprüft: ${plural(run.notified, 'neue Benachrichtigung', 'neue Benachrichtigungen')}`,
      `${plural(run.open, 'Zahlung wartet', 'Zahlungen warten')} auf einen Beleg`,
    ];
    if (run.deferred > 0) parts.push(`${plural(run.deferred, 'weitere folgt', 'weitere folgen')} beim nächsten Prüfen`);
    sentences.push(`${parts.join(', ')}.`);
    if (run.mailbox.status === 'ok' && run.mailbox.found > 0) sentences.push(`Im Postfach ${plural(run.mailbox.found, 'Rechnung', 'Rechnungen')} gefunden.`);
    if (run.mailbox.status === 'error')
      sentences.push(
        run.mailbox.code === 'auth_failed'
          ? 'Der Zugang zum Ausgaben-Postfach ist abgelaufen und muss auf dem Server neu erteilt werden.'
          : 'Das Ausgaben-Postfach hat gerade nicht geantwortet; beim nächsten Prüfen wird es wieder versucht.',
      );
  } else {
    sentences.push('Die Belege konnten nicht geprüft werden; bitte gleich noch einmal versuchen.');
  }
  if (checks.budgets) {
    const parts: string[] = [];
    if (checks.budgets.sent > 0) parts.push(plural(checks.budgets.sent, 'neue Budgetwarnung', 'neue Budgetwarnungen'));
    if (checks.budgets.deferred > 0) parts.push(`${plural(checks.budgets.deferred, 'weitere folgt', 'weitere folgen')} beim nächsten Prüfen`);
    if (parts.length > 0) sentences.push(`${parts.join(', ')}.`);
  } else {
    sentences.push('Die Budgets konnten nicht geprüft werden; bitte gleich noch einmal versuchen.');
  }
  return sentences.join(' ');
}

/** What the push switch asks of the page; each resolves true when the server took it. */
export interface PushActions {
  enable(subscription: unknown): Promise<boolean>;
  disable(endpoint: string): Promise<boolean>;
  /** What the server holds for this device, or null when it could not be asked. */
  stateOf(endpoint: string): Promise<{ here: boolean; elsewhere: boolean } | null>;
}

/**
 * Push on this device: switch it on (asks for permission straight from the
 * tap, subscribes, and counts as on only once the server stored it) or off.
 * On opening the page with push on, the device renews itself, so a browser
 * that changed its push address keeps getting messages. The browser part is
 * passed in for the tests.
 */
export function PushSwitch({
  publicKey,
  devices,
  channel,
  actions,
  error,
  environment,
}: {
  publicKey: string | null;
  devices: number;
  channel: ChannelSetting;
  actions: PushActions;
  error: string | null;
  environment?: PushEnvironment | null;
}) {
  const id = useId();
  const [env] = useState(() => (environment === undefined ? browserPushEnvironment() : environment));
  const [onHere, setOnHere] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!env || !publicKey) return;
    let active = true;
    void (async () => {
      const current = await currentSubscription(env);
      if (!current) {
        if (active) setOnHere(false);
        return;
      }
      // Renewing is done on every page of the app (PushRenewal in the layout); here only the state is read.
      const state = await actions.stateOf(current.endpoint);
      if (!active) return;
      setOnHere(Boolean(state?.here));
    })();
    return () => {
      active = false;
    };
    // Runs once per page: renewing on every render would be noise.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [env, publicKey]);

  if (!publicKey) {
    return (
      <p className="text-xs" style={{ color: 'var(--muted)' }}>
        Push ist auf dem Server noch nicht eingerichtet; bis dahin kommt eine E-Mail.
      </p>
    );
  }
  if (channel !== 'push') {
    return (
      <p className="text-xs" style={{ color: 'var(--muted)' }}>
        Push wird nur benutzt, wenn oben „{CHANNEL_LABELS.push}“ gewählt und gespeichert ist.
      </p>
    );
  }

  const switchOn = async () => {
    if (!env) return;
    setBusy(true);
    setMessage(null);
    try {
      // First call, no await before it: the permission prompt must belong to the tap.
      const result = await switchPushOn(env, publicKey);
      if (!result.ok) {
        setMessage(pushSwitchMessage(result));
        return;
      }
      if (await actions.enable(result.subscription)) {
        setOnHere(true);
        setMessage(pushSwitchMessage(result));
      } else {
        // The server did not store it: the browser's subscription is taken back unless another company
        // uses it; when the server cannot even say that, it is kept (a later page tidies up).
        const state = await actions.stateOf(result.endpoint);
        if (state) await switchPushOff(env, state.elsewhere);
        setOnHere(false);
      }
    } finally {
      setBusy(false);
    }
  };

  const switchOff = async () => {
    if (!env) return;
    setBusy(true);
    setMessage(null);
    try {
      const current = await currentSubscription(env);
      if (!current) {
        setOnHere(false);
        return;
      }
      const state = await actions.stateOf(current.endpoint);
      if (!state) {
        // Without the server's answer the browser's subscription might be another company's too: nothing is ended.
        setMessage('Push ließ sich nicht ausschalten, der Server antwortet gerade nicht. Bitte noch einmal versuchen.');
        return;
      }
      const endpoint = await switchPushOff(env, state.elsewhere);
      if (endpoint && (await actions.disable(endpoint))) {
        setOnHere(false);
        setMessage('Push ist auf diesem Gerät ausgeschaltet.');
      }
    } catch (e) {
      console.warn('[push] switching off failed', e);
      setMessage('Push ließ sich nicht ausschalten. Bitte noch einmal versuchen.');
    } finally {
      setBusy(false);
    }
  };

  const status = devices === 0 ? 'Auf keinem Gerät eingeschaltet.' : devices === 1 ? 'Auf einem Gerät eingeschaltet.' : `Auf ${devices} Geräten eingeschaltet.`;
  return (
    <fieldset className="space-y-1" aria-labelledby={`${id}-legend`}>
      <legend id={`${id}-legend`} className="ui-label">
        Push auf diesem Gerät
      </legend>
      <p className="text-xs" style={{ color: 'var(--muted)' }}>
        {status}
      </p>
      {!env ? (
        <p className="text-xs" style={{ color: 'var(--muted)' }}>
          {pushSwitchMessage({ ok: false, reason: 'unsupported' })}
        </p>
      ) : onHere ? (
        <button type="button" className="ui-btn ui-btn-sm" disabled={busy} aria-busy={busy} onClick={switchOff}>
          {busy ? 'Wird ausgeschaltet …' : 'Push auf diesem Gerät ausschalten'}
        </button>
      ) : (
        <button type="button" className="ui-btn ui-btn-sm" disabled={busy || onHere === null} aria-busy={busy} onClick={switchOn}>
          {busy ? 'Wird eingeschaltet …' : 'Push auf diesem Gerät einschalten'}
        </button>
      )}
      {/* Always there, so a screen reader announces what is filled in later. */}
      <p className={message ? 'text-xs' : 'sr-only'} role="status">
        {message ?? ''}
      </p>
      {error && (
        <p className="ui-note ui-note-danger" role="alert">
          {error}
        </p>
      )}
    </fieldset>
  );
}

/** One receipt in the list for linking by hand: name, vendor where it says more, day, and what is still open. */
export function choiceLabel(r: ReceiptChoice): string {
  const parts = [r.label];
  if (r.vendor && !r.label.toLowerCase().includes(r.vendor.toLowerCase())) parts.push(r.vendor);
  if (r.day) parts.push(formatDay(r.day));
  if (r.amountCents !== null) {
    const amount = `${r.estimated ? 'ca. ' : ''}${euro(r.amountCents)}`;
    parts.push(r.openCents !== null && r.openCents !== r.amountCents ? `${amount}, noch offen ${r.estimated ? 'ca. ' : ''}${euro(r.openCents)}` : amount);
  }
  return parts.join(', ');
}

/**
 * Is the row an error belongs to still listed in this view? An error about a payment, an answer or a
 * notification goes with its row; one about the page as a whole (a check run, the settings, push) stays.
 */
export function errorRowListed(at: string, view: ChecksView): boolean {
  const colon = at.indexOf(':');
  // A key without a row (`run`, `push`, `settings`) belongs to the page as a whole.
  if (colon < 0) return true;
  const [kind, key] = [at.slice(0, colon), at.slice(colon + 1)];
  if (kind === 'check') return view.loop.open.some((c) => c.paymentId === key);
  if (kind === 'answered') return view.loop.answered.some((c) => c.paymentId === key);
  if (kind === 'note') return view.notifications.some((n) => n.id === key);
  return true;
}

/** What went wrong, in words a person can act on. */
export function checksActionMessage(result: Extract<ChecksResult<unknown>, { ok: false }>): string {
  if (result.error === 'unauthorized') return 'Die Anmeldung ist abgelaufen. Bitte die Seite neu laden und neu anmelden.';
  if (result.error === 'forbidden') return 'Für diesen Arbeitsbereich fehlt die Berechtigung zum Ändern.';
  if (result.detail === 'reason_required') return 'Bitte kurz sagen, warum es keinen Beleg gibt.';
  if (result.detail === 'already_has_receipt') return 'An dieser Zahlung hängt inzwischen schon ein Beleg. Bitte die Seite neu laden.';
  if (result.detail === 'payment_not_open') return 'Diese Zahlung wartet auf keinen Beleg mehr (sie wurde inzwischen beantwortet). Bitte die Seite neu laden.';
  if (result.detail === 'target_not_found') return 'Dieser Beleg ist nicht mehr da oder gehört nicht zu dieser Firma. Bitte die Seite neu laden.';
  if (result.detail === 'not_a_candidate') return 'Dieser Beleg passt nicht mehr zu der Zahlung (er wurde inzwischen verknüpft oder geändert). Bitte die Seite neu laden.';
  if (result.detail?.startsWith('receipt_already_paid'))
    return 'Dieser Beleg ist schon durch andere Zahlungen bezahlt. Bitte prüfen, ob es der richtige Beleg ist; eine falsche Verknüpfung lässt sich unter Ausgaben (Zahlungen) oder unter Finanzen, Zahlungen lösen.';
  if (result.detail === 'answered_by_holder') return 'Diese Antwort wurde in der Firma gegeben, die das Konto führt, und lässt sich nur dort zurücknehmen.';
  if (result.detail === 'invalid_email') return 'Diese E-Mail-Adresse sieht nicht gültig aus.';
  if (result.detail === 'invalid_channel') return 'Bitte einen der angebotenen Wege wählen.';
  if (result.detail === 'candidate_not_found') return 'Diese Mail wird nicht mehr angeboten. Bitte die Seite neu laden.';
  if (result.detail === 'invalid_subscription') return 'Das Gerät hat keine gültige Push-Anmeldung geliefert. Bitte Push noch einmal einschalten.';
  if (result.detail === 'payment_not_found')
    return 'Diese Zahlung gibt es hier nicht mehr: ihr Import wurde vielleicht zurückgenommen, oder sie steht inzwischen in einer anderen Firma. Bitte die Seite neu laden.';
  if (result.error === 'not_found') return 'Das gibt es nicht mehr (die Zahlung wurde vielleicht mit ihrem Import zurückgenommen). Bitte die Seite neu laden.';
  return 'Das hat nicht geklappt. Bitte noch einmal versuchen; wenn es wieder scheitert, die Seite neu laden.';
}

function OpenCheck({
  check,
  focused,
  canWrite,
  pending,
  error,
  onConfirm,
  onNoReceipt,
  onTakeOver,
  onDismiss,
  takingOver,
  onLinkByHand,
  onSearchReceipts,
  dataVersion,
}: {
  check: PaymentCheck;
  focused: boolean;
  canWrite: boolean;
  pending: boolean;
  error: string | null;
  onConfirm: (rowId: string) => void;
  onNoReceipt: (reason: string) => void;
  onTakeOver: (mailId: string) => void;
  onDismiss: (mailId: string) => void;
  /** The mail being taken over right now, if any. */
  takingOver: string | null;
  onLinkByHand: (rowId: string) => void;
  /** Search this company's receipts for this payment by name, vendor or amount. */
  onSearchReceipts: (text: string) => Promise<ChecksResult<ReceiptChoice[]>>;
  /** Counts the fresh views of the page's payments: an open list is asked again when it changes. */
  dataVersion: number;
}) {
  const id = useId();
  // Linking by hand opens on request: the receipts are asked from the server only for the payment a person works on.
  const [picking, setPicking] = useState(false);
  const [chosen, setChosen] = useState('');
  const [search, setSearch] = useState('');
  const [found, setFound] = useState<{ choices: ReceiptChoice[]; searched: boolean } | null>(null);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [searching, setSearching] = useState(false);
  const pickOpener = useRef<HTMLButtonElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const pickReopened = useRef(false);
  // Every request gets a number; an answer that is not the newest one's is dropped, so a slow answer never
  // overwrites a list asked for later (after a fresh view, or a second search).
  const request = useRef(0);
  // The search the shown list answers; a fresh view asks it again, so what was typed and chosen stays.
  const lastQuery = useRef('');
  const [loadedVersion, setLoadedVersion] = useState<number | null>(null);
  /** `quiet`: asked again only because the page read afresh; the list and its status stay as they are meanwhile. */
  const loadChoices = async (text: string, quiet = false) => {
    const mine = ++request.current;
    const version = dataVersion;
    lastQuery.current = text;
    if (!quiet) setSearching(true);
    setSearchError(null);
    try {
      const result = await onSearchReceipts(text);
      if (mine !== request.current) return;
      if (result.ok) {
        setFound({ choices: result.value, searched: text.trim() !== '' });
        setLoadedVersion(version);
        // A choice that is no longer offered (linked meanwhile) is let go; one still offered stays chosen.
        setChosen((current) => (result.value.some((c) => c.rowId === current) ? current : ''));
      } else setSearchError(checksActionMessage(result));
    } catch {
      if (mine === request.current) setSearchError(checksActionMessage({ ok: false, error: 'failed' }));
    } finally {
      if (mine === request.current) setSearching(false);
    }
  };
  const closePicker = () => {
    // Whatever is still on its way is dropped; reopening asks afresh, unfiltered.
    request.current += 1;
    lastQuery.current = '';
    setPicking(false);
    setFound(null);
    setLoadedVersion(null);
    setChosen('');
    setSearch('');
    setSearchError(null);
    setSearching(false);
  };
  // Opened: the closest receipts are loaded, and the focus goes to the search field; closed: back to the opener.
  useEffect(() => {
    if (picking) searchInput.current?.focus();
    else if (pickReopened.current) pickOpener.current?.focus();
  }, [picking]);
  // Opening, or a fresh view of the payments while open, asks once with the last search; the list on screen
  // stays until the answer is in, so nothing a person is working with disappears under the focus.
  useEffect(() => {
    if (picking && loadedVersion !== dataVersion) void loadChoices(lastQuery.current, found !== null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [picking, dataVersion]);
  const choices = found?.choices ?? [];
  const pickStatus = searching
    ? 'Belege werden gesucht …'
    : found === null
      ? ''
      : found.choices.length === 0
        ? found.searched
          ? 'Kein offener Beleg passt zu dieser Suche.'
          : 'Kein offener Beleg in dieser Firma, der zu dieser Zahlung passen kann. Bitte zuerst einen Beleg hochladen.'
        : found.searched
          ? `${found.choices.length} ${found.choices.length === 1 ? 'Beleg' : 'Belege'} gefunden.`
          : found.choices.length === 1
            ? '1 Beleg zur Auswahl.'
            : `${found.choices.length} Belege zur Auswahl, die nächstliegenden zuerst.`;
  const [asking, setAsking] = useState(false);
  const [reason, setReason] = useState('');
  const opener = useRef<HTMLButtonElement>(null);
  const reopened = useRef(false);
  // "Abbrechen" gives the focus back to the button that opened the form.
  useEffect(() => {
    if (!asking && reopened.current) opener.current?.focus();
  }, [asking]);
  return (
    <li
      id={`pruefen-${check.paymentId}`}
      tabIndex={focused ? -1 : undefined}
      aria-current={focused ? 'true' : undefined}
      className="py-3 text-sm"
      style={focused ? { outline: '2px solid var(--accent)', outlineOffset: 4, borderRadius: 6 } : undefined}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span style={{ color: 'var(--foreground)' }}>
          {check.counterparty || 'ohne Namen'}
          <span className="ml-2 text-xs" style={{ color: 'var(--muted)' }}>
            {formatDay(check.bookingDay)}
            {check.reference ? `, ${check.reference}` : ''}
          </span>
        </span>
        <span className="tabular-nums">{euro(check.cents)}</span>
      </div>
      {check.state.state === 'proposed' && (
        <ul className="mt-2 space-y-1">
          {check.state.candidates.map((c) => (
            <li key={c.rowId} className="flex flex-wrap items-center justify-between gap-2 text-xs">
              <span>
                Passender Beleg:{' '}
                <Link href={receiptHref(c.rowId)} className="underline">
                  {c.label}
                </Link>{' '}
                vom {formatDay(c.day)}, {euro(c.amountCents)}
                {c.estimated ? ' (umgerechnet)' : ''}
              </span>
              {canWrite && (
                <button type="button" className="ui-btn ui-btn-sm ui-btn-primary" disabled={pending} onClick={() => onConfirm(c.rowId)} aria-label={`${c.label} als Beleg für diese Zahlung bestätigen`}>
                  Das ist der Beleg
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {check.state.state === 'in_mailbox' && (
        <ul className="mt-2 space-y-1">
          {check.state.mails.map((m) => (
            <li key={m.id} className="flex flex-wrap items-center justify-between gap-2 text-xs">
              <span>
                Im Postfach: {m.fileName}, „{m.subject || 'ohne Betreff'}“ von {m.sender || 'unbekannt'}, {formatDay(m.receivedDay)}
              </span>
              {canWrite && (
                <span className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    className="ui-btn ui-btn-sm ui-btn-primary"
                    disabled={pending}
                    aria-busy={takingOver === m.id}
                    onClick={() => onTakeOver(m.id)}
                    aria-label={`${m.fileName} ${takingOver === m.id ? 'wird übernommen' : 'als Beleg übernehmen'}`}
                  >
                    {takingOver === m.id ? 'Wird übernommen …' : 'Als Beleg übernehmen'}
                  </button>
                  <button type="button" className="ui-btn ui-btn-sm ui-btn-ghost" disabled={pending} onClick={() => onDismiss(m.id)} aria-label={`${m.fileName} ist nicht die Rechnung`}>
                    Nicht die Rechnung
                  </button>
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      {check.state.state === 'missing' && (
        <p className="mt-1 text-xs" style={{ color: 'var(--muted)' }}>
          Kein Beleg gefunden.
        </p>
      )}
      {canWrite && !picking && (
        <div className="mt-2">
          <button
            ref={pickOpener}
            type="button"
            className="ui-btn ui-btn-sm ui-btn-ghost"
            disabled={pending}
            onClick={() => {
              pickReopened.current = true;
              setPicking(true);
            }}
          >
            Vorhandenen Beleg zuordnen
          </button>
        </div>
      )}
      {canWrite && picking && (
        <div className="mt-2 space-y-2">
          <form
            className="flex flex-wrap items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void loadChoices(search);
            }}
          >
            <label className="sr-only" htmlFor={`${id}-search`}>
              Belege durchsuchen (Name, Lieferant oder Betrag)
            </label>
            <input
              ref={searchInput}
              id={`${id}-search`}
              className="ui-input"
              style={{ width: 'auto', minWidth: 200 }}
              placeholder="Name, Lieferant oder Betrag"
              value={search}
              maxLength={80}
              onChange={(e) => setSearch(e.target.value)}
            />
            {/* A new search may start while one runs: only the newest answer is kept. */}
            <button type="submit" className="ui-btn ui-btn-sm" aria-busy={searching}>
              Suchen
            </button>
            <button type="button" className="ui-btn ui-btn-sm ui-btn-ghost" aria-label="Abbrechen: Beleg zuordnen" onClick={closePicker}>
              Abbrechen
            </button>
          </form>
          <p className="text-xs" style={{ color: 'var(--muted)' }} role="status" aria-live="polite">
            {pickStatus}
          </p>
          {searchError && (
            <p className="ui-note ui-note-danger" role="alert">
              {searchError}
            </p>
          )}
          {choices.length > 0 && (
            <div className="flex flex-wrap items-center gap-2">
              <label className="sr-only" htmlFor={`${id}-receipt`}>
                Vorhandenen Beleg für {check.counterparty || 'diese Zahlung'} wählen
              </label>
              <select id={`${id}-receipt`} className="ui-input" style={{ width: 'auto', maxWidth: '100%' }} value={chosen} disabled={pending} onChange={(e) => setChosen(e.target.value)}>
                <option value="">Beleg wählen</option>
                {choices.map((r) => (
                  <option key={r.rowId} value={r.rowId}>
                    {choiceLabel(r)}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="ui-btn ui-btn-sm"
                disabled={pending || !chosen}
                aria-label={`Zuordnen: gewählten Beleg zu ${check.counterparty || 'dieser Zahlung'}`}
                onClick={() => onLinkByHand(chosen)}
              >
                Zuordnen
              </button>
            </div>
          )}
        </div>
      )}
      {canWrite && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Link href="/app" className="ui-btn ui-btn-sm">
            Beleg fotografieren oder hochladen
          </Link>
          {!asking ? (
            <button
              ref={opener}
              type="button"
              className="ui-btn ui-btn-sm ui-btn-ghost"
              disabled={pending}
              onClick={() => {
                reopened.current = true;
                setAsking(true);
              }}
            >
              Es gibt keinen Beleg
            </button>
          ) : (
            <form
              className="flex flex-wrap items-center gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                onNoReceipt(reason);
              }}
            >
              <label className="sr-only" htmlFor={`${id}-reason`}>
                Warum es keinen Beleg gibt
              </label>
              <input
                id={`${id}-reason`}
                className="ui-input"
                style={{ width: 'auto', minWidth: 220 }}
                placeholder="Warum? z. B. Parkautomat"
                value={reason}
                maxLength={500}
                autoFocus
                onChange={(e) => setReason(e.target.value)}
              />
              <button type="submit" className="ui-btn ui-btn-sm" disabled={pending || !reason.trim()} aria-label={`Antwort ohne Beleg für ${check.counterparty || 'diese Zahlung'} speichern`}>
                Speichern
              </button>
              <button type="button" className="ui-btn ui-btn-sm ui-btn-ghost" aria-label="Abbrechen: kein Beleg" onClick={() => setAsking(false)}>
                Abbrechen
              </button>
            </form>
          )}
        </div>
      )}
      {error && (
        <p className="ui-note ui-note-danger mt-2" role="alert">
          {error}
        </p>
      )}
    </li>
  );
}

export default function ReceiptChecks({
  initial,
  focusPaymentId,
  forCompany = null,
}: {
  initial: ChecksView;
  focusPaymentId: string | null;
  /** The company a notification was about (`firma` in its link); the page offers to switch when another one is active. */
  forCompany?: string | null;
}) {
  const id = useId();
  const [view, setView] = useState(initial);
  const [error, setError] = useState<{ at: string; message: string } | null>(null);
  // Counts the fresh views of the payments, so an open list for linking by hand is asked again once.
  const [dataVersion, setDataVersion] = useState(0);
  // The page reads the checks afresh after a change elsewhere on it (a receipt taken back in the payment list): take
  // that over, keeping the summary of the last "Jetzt prüfen" (the page's own read carries none; the next action of
  // this panel ends it, as a notice belongs to the action that set it). An error stays while its payment is still
  // open here; one about a payment that left the list goes with it. (Another company remounts the panel: page.tsx.)
  const [shownInitial, setShownInitial] = useState(initial);
  if (shownInitial !== initial) {
    setShownInitial(initial);
    setView((current) => ({ ...initial, lastRun: current.lastRun }));
    setError((current) => (current && !errorRowListed(current.at, initial) ? null : current));
    setDataVersion((n) => n + 1);
  }
  const [pending, startTransition] = useTransition();
  const [channel, setChannel] = useState<ChannelSetting>(initial.settings.channel);
  const [email, setEmail] = useState(initial.settings.notifyEmail ?? '');
  const { loop } = view;

  // A notification links here with the payment: bring it into view and give it the focus.
  useEffect(() => {
    if (!focusPaymentId) return;
    const item = document.getElementById(`pruefen-${focusPaymentId}`);
    item?.scrollIntoView({ block: 'center' });
    item?.focus();
  }, [focusPaymentId]);
  const otherCompany = forCompany !== null && forCompany !== view.workspaceId;
  const focusSettled = !otherCompany && focusPaymentId !== null && !loop.open.some((c) => c.paymentId === focusPaymentId);

  const router = useRouter();
  /** `refresh`: the action changed payments or links, so the rest of the page reads them afresh. */
  const run = (at: string, action: () => Promise<ChecksResult<ChecksView>>, success?: string, refresh = true) => {
    setError(null);
    // A notice belongs to the action that set it: the next one starts without it.
    setPageNotice(null);
    startTransition(async () => {
      const result = await action();
      if (result.ok) {
        setView(result.value);
        // A link, an answer or a check changes the payment list, the overview and the budgets too: the page reads them afresh.
        if (refresh) router.refresh();
        if (success) {
          // The payment left the list with its buttons: say what happened, and give the focus to the list's heading.
          setPageNotice(success);
          document.getElementById(`${id}-title`)?.focus();
        }
      } else setError({ at, message: checksActionMessage(result) });
    });
  };

  const errorAt = (at: string) => (error?.at === at ? error.message : null);

  /** The push switch's calls to the server; each says whether the server took it, and a refusal shows at the switch. */
  const pushActions: PushActions = {
    enable: async (subscription) => {
      const result = await enablePush(subscription);
      if (result.ok) setView(result.value);
      else setError({ at: 'push', message: checksActionMessage(result) });
      return result.ok;
    },
    disable: async (endpoint) => {
      const result = await disablePush(endpoint);
      if (result.ok) setView(result.value);
      else setError({ at: 'push', message: checksActionMessage(result) });
      return result.ok;
    },
    stateOf: async (endpoint) => {
      const result = await pushStateOfDevice(endpoint);
      return result.ok ? result.value : null;
    },
  };
  const [takingOver, setTakingOver] = useState<string | null>(null);
  const [pageNotice, setPageNotice] = useState<string | null>(null);

  /** A found mail attachment goes through the normal upload path, then the checks are read afresh. */
  const takeOver = (paymentId: string, mailId: string) => {
    setError(null);
    setPageNotice(null);
    setTakingOver(mailId);
    startTransition(async () => {
      try {
        const save: SaveReceipt = (file, ocr, options) =>
          processReceipt({ id: file.id, originalName: file.originalName, fileType: file.fileType }, ocr, options);
        const outcome = await takeOverMail(mailId, { fetchImpl: fetch, pipeline: createBrowserDeps(save, view.workspaceId) });
        if (outcome.kind === 'failed') {
          setError({ at: `check:${paymentId}`, message: takeOverMessage(outcome) });
          return;
        }
        // The owner chose this mail for this payment: the receipt is linked to it right away.
        const linked = await linkTakenOver(paymentId, outcome.rowId);
        if (linked.ok) {
          setView(linked.value);
          setPageNotice(takeOverMessage(outcome, true));
          // The row is gone with its button: the focus goes to the list's heading.
          document.getElementById(`${id}-title`)?.focus();
        } else {
          const message = `${takeOverMessage(outcome, false)} ${checksActionMessage(linked)}`;
          const fresh = await getReceiptChecks();
          if (fresh.ok) setView(fresh.value);
          // The payment may have left the list (answered, moved, its import undone): then the message is said at the page,
          // as it is the only word that a receipt was made and is not linked.
          const stillOpen = !fresh.ok || fresh.value.loop.open.some((c) => c.paymentId === paymentId);
          setError({ at: stillOpen ? `check:${paymentId}` : 'run', message });
          // No link was made: nothing else on the page changed, and a fresh read would only hide this message.
          return;
        }
        router.refresh();
      } finally {
        setTakingOver(null);
      }
    });
  };
  const notNeeded = Object.values(loop.counts.notNeeded).reduce((s, n) => s + n, 0);

  return (
    <section className="glass-panel mt-4 rounded-xl p-4" aria-labelledby={`${id}-title`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id={`${id}-title`} tabIndex={-1} className="text-sm font-semibold" style={{ color: 'var(--foreground)' }}>
          Belege prüfen ({loop.open.length} offen)
        </h2>
        {view.canWrite && (
          <button type="button" className="ui-btn ui-btn-sm" disabled={pending} onClick={() => run('run', checkNow)}>
            Jetzt prüfen
          </button>
        )}
      </div>
      <p className="mt-1 text-xs" style={{ color: 'var(--muted)' }}>
        {loop.counts.hasReceipt} mit Beleg, {loop.counts.in_mailbox} mit Rechnung im Postfach, {notNeeded} brauchen keinen (Umbuchungen, Einnahmen, Erstattungen, Gebühren, Raten, Bargeld, Geld an Personen),{' '}
        {loop.answered.length} ohne Beleg beantwortet.
      </p>
      {view.mailbox !== 'other_company' && (
        <p className="mt-1 text-xs" style={{ color: 'var(--muted)' }}>
          {view.mailbox === 'on'
            ? 'Fehlende Rechnungen werden zuerst im Ausgaben-Postfach gesucht.'
            : 'Das Ausgaben-Postfach ist noch nicht verbunden; fehlende Rechnungen werden dort noch nicht gesucht.'}
        </p>
      )}
      {/* The outcome of a take-over: here, because a payment that got its receipt leaves the list below. */}
      <p className={pageNotice ? 'ui-note ui-note-ok mt-2' : 'sr-only'} role="status">
        {pageNotice ?? ''}
      </p>
      {otherCompany && (
        <div className="ui-note ui-note-warn mt-2 flex flex-wrap items-center justify-between gap-2">
          <span>Die Benachrichtigung gehört zu einer anderen Firma als der gerade gewählten.</span>
          <button
            type="button"
            className="ui-btn ui-btn-sm"
            disabled={pending}
            onClick={() =>
              startTransition(async () => {
                const switched = await switchWorkspace(forCompany as string).catch(() => ({ ok: false }));
                if (switched.ok) router.refresh();
                else setError({ at: 'run', message: 'Der Wechsel hat nicht geklappt; vielleicht fehlt der Zugang zu dieser Firma.' });
              })
            }
          >
            Zu dieser Firma wechseln
          </button>
        </div>
      )}
      {focusSettled && (
        <p className="ui-note mt-2">Die Zahlung aus der Benachrichtigung ist inzwischen erledigt: sie hat einen Beleg, braucht keinen oder wurde beantwortet.</p>
      )}
      {/* Always rendered, so a screen reader announces what is filled in later. */}
      <p className={view.lastRun ? 'ui-note ui-note-ok mt-2' : 'sr-only'} role="status">
        {view.lastRun ? runSummary(view.lastRun) : ''}
      </p>
      {errorAt('run') && (
        <p className="ui-note ui-note-danger mt-2" role="alert">
          {errorAt('run')}
        </p>
      )}

      {view.canWrite && view.notifications.length > 0 && (
        <div className="mt-3">
          <h3 className="text-xs font-semibold" style={{ color: 'var(--foreground)' }}>
            Benachrichtigungen
          </h3>
          <ul className="mt-1 divide-y">
            {view.notifications.map((n) => (
              <li key={n.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
                <span>
                  <Link href={n.path} className="underline">
                    {n.title}
                  </Link>
                  <span className="ml-2 text-xs" style={{ color: n.failed ? 'var(--danger, var(--foreground))' : 'var(--muted)' }}>
                    {n.channel === 'push' ? 'aufs Telefon geschickt' : n.channel === 'email' ? 'per E-Mail geschickt' : n.failed ? 'Zustellung fehlgeschlagen, nur hier' : 'nur hier'}
                  </span>
                </span>
                {view.canWrite && (
                  <button type="button" className="ui-btn ui-btn-sm ui-btn-ghost" disabled={pending} onClick={() => run(`note:${n.id}`, () => readNotification(n.id), undefined, false)} aria-label={`${n.title} als gelesen markieren`}>
                    Gelesen
                  </button>
                )}
                {errorAt(`note:${n.id}`) && (
                  <p className="ui-note ui-note-danger w-full" role="alert">
                    {errorAt(`note:${n.id}`)}
                  </p>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {loop.open.length === 0 ? (
        <p className="mt-3 text-sm" style={{ color: 'var(--muted)' }}>
          Für jede Zahlung, die einen Beleg braucht, ist einer da oder gesagt, warum es keinen gibt.
        </p>
      ) : (
        <ul className="mt-3 divide-y">
          {loop.open.map((c) => (
            <OpenCheck
              key={c.paymentId}
              check={c}
              focused={c.paymentId === focusPaymentId}
              canWrite={view.canWrite}
              pending={pending}
              error={errorAt(`check:${c.paymentId}`)}
              dataVersion={dataVersion}
              onConfirm={(rowId) => run(`check:${c.paymentId}`, () => confirmReceipt(c.paymentId, rowId), `Beleg zugeordnet: ${c.counterparty || 'Zahlung ohne Namen'}.`)}
              onNoReceipt={(reason) => run(`check:${c.paymentId}`, () => sayNoReceipt(c.paymentId, reason))}
              onTakeOver={(mailId) => takeOver(c.paymentId, mailId)}
              onDismiss={(mailId) => run(`check:${c.paymentId}`, () => dismissMail(mailId))}
              takingOver={takingOver}
              onLinkByHand={(rowId) => run(`check:${c.paymentId}`, () => linkChosenReceipt(c.paymentId, rowId), `Beleg zugeordnet: ${c.counterparty || 'Zahlung ohne Namen'}.`)}
              onSearchReceipts={(text) => findReceiptChoices(c.paymentId, text)}
            />
          ))}
        </ul>
      )}

      {loop.answered.length > 0 && (
        <details className="ui-disclosure mt-3">
          <summary className="cursor-pointer text-xs font-semibold">Ohne Beleg beantwortet ({loop.answered.length})</summary>
          <ul className="mt-2 divide-y">
            {loop.answered.map((c) => (
              <li key={c.paymentId} className="py-2 text-sm">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span>
                    {c.counterparty || 'ohne Namen'}, {formatDay(c.bookingDay)}, {euro(c.cents)}
                    {c.state.state === 'no_receipt' && (
                      <span className="ml-2 text-xs" style={{ color: 'var(--muted)' }}>
                        {c.state.reason}
                        {c.state.movedAway && ' (die Zahlung steht jetzt in der Firma, an die die privaten Zahlungen dieses Kontos gehen)'}
                      </span>
                    )}
                  </span>
                  {c.state.state === 'no_receipt' && c.state.fromHolder ? (
                    <span className="text-xs" style={{ color: 'var(--muted)' }}>
                      beantwortet in der Firma, die das Konto führt; dort zurücknehmen
                    </span>
                  ) : (
                    view.canWrite && (
                      <button type="button" className="ui-btn ui-btn-sm" disabled={pending} onClick={() => run(`answered:${c.paymentId}`, () => takeBackNoReceipt(c.paymentId))} aria-label={`Antwort für ${c.counterparty || 'diese Zahlung'} zurücknehmen`}>
                        Zurücknehmen
                      </button>
                    )
                  )}
                </div>
                {errorAt(`answered:${c.paymentId}`) && (
                  <p className="ui-note ui-note-danger mt-2" role="alert">
                    {errorAt(`answered:${c.paymentId}`)}
                  </p>
                )}
              </li>
            ))}
          </ul>
        </details>
      )}

      {view.canWrite && (
        <details className="ui-disclosure mt-3">
          <summary className="cursor-pointer text-xs font-semibold">Wie benachrichtigt wird</summary>
          <form
            className="mt-2 space-y-2 text-sm"
            onSubmit={(e) => {
              e.preventDefault();
              run('settings', () => saveNotificationSettings({ channel, notifyEmail: email }), undefined, false);
            }}
          >
            <fieldset>
              <legend className="sr-only">Weg der Benachrichtigung</legend>
              {(Object.keys(CHANNEL_LABELS) as ChannelSetting[]).map((c) => (
                <label key={c} className="mr-4 inline-flex items-center gap-1">
                  <input type="radio" name={`${id}-channel`} value={c} checked={channel === c} onChange={() => setChannel(c)} />
                  {CHANNEL_LABELS[c]}
                </label>
              ))}
            </fieldset>
            <label className="block">
              <span className="ui-label">E-Mail-Adresse für Benachrichtigungen</span>
              <input type="email" className="ui-input" value={email} maxLength={254} onChange={(e) => setEmail(e.target.value)} />
            </label>
            <p className="text-xs" style={{ color: 'var(--muted)' }}>
              Alles erscheint immer auch hier. Push kommt auf jedes Gerät, auf dem es unten eingeschaltet ist; geht das nicht, kommt eine E-Mail, sobald eine
              Adresse eingetragen und der Versand auf dem Server eingerichtet ist.
            </p>
            <button type="submit" className="ui-btn ui-btn-sm" disabled={pending} aria-label="Einstellung speichern">
              Speichern
            </button>
            <PushSwitch
              publicKey={view.pushPublicKey}
              devices={view.pushDevices}
              channel={view.settings.channel}
              actions={pushActions}
              error={errorAt('push')}
            />
            {errorAt('settings') && (
              <p className="ui-note ui-note-danger" role="alert">
                {errorAt('settings')}
              </p>
            )}
          </form>
        </details>
      )}
    </section>
  );
}
