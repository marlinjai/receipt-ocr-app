'use client';

import { observer } from 'mobx-react-lite';
import { memo, useEffect, useId, useRef, useState, useSyncExternalStore, useTransition, type RefObject } from 'react';
import Link from 'next/link';
import ConfirmDialog from '@/components/ui/ConfirmDialog';
import { formatDay } from '@/lib/meals/messages';
import { receiptHref } from '@/lib/receipt-link';
import { uploadForHref } from '@/lib/spending/paths';
import { formatCents } from '@/lib/tax/money';
import { createBrowserDeps, type SaveReceipt } from '@/lib/upload/browser-deps';
import { processReceipt } from '../actions';
import { switchWorkspace } from '../workspace-actions';
import { takeOverMail, takeOverMessage } from './take-over-mail';
import { CHECKS_PAGE, answerTakenBack, answeredNoReceipt, mailSetAside, receiptLinked, type CheckEdit } from './open-checks';
import { browserPushEnvironment, currentSubscription, pushSwitchMessage, switchPushOff, switchPushOn, type PushEnvironment } from './push-device';
import type { BacklogClosed, PaymentCheck } from '@/lib/spending/loop-service';
import type { ChecksRun } from '@/lib/spending/checks';
import { classifySummary } from '@/lib/tax/payments/classify-summary';
import { useRouter } from 'next/navigation';
import type { ChannelSetting } from '@/lib/spending/notify/port';
import { checkKey, type LocalWrite } from '@/stores/ChecksOutbox';
import { ChecksStore } from '@/stores/ChecksStore';
import { useAppStore } from '@/stores/provider';
import {
  checkNow,
  confirmReceipt,
  dismissMail,
  disablePush,
  enablePush,
  pushStateOfDevice,
  findReceiptChoices,
  closeReceiptBacklog,
  getReceiptChecks,
  linkCertain,
  linkChosenReceipt,
  linkTakenOver,
  readNotification,
  saveNotificationSettings,
  sayNoReceipt,
  takeBackNoReceipt,
  type CheckChange,
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

export function backlogNotice({ linked, privately, notFound }: BacklogClosed): string {
  return `Abgeschlossen: ${linked} zugeordnet, ${privately} privat ohne Beleg, ${notFound} nicht auffindbar.`;
}

export function certainNotice(linked: number): string {
  if (linked === 0) return 'Nichts zugeordnet: die Vorschläge sind inzwischen erledigt oder nicht mehr eindeutig.';
  return linked === 1 ? '1 Beleg zugeordnet.' : `${linked} Belege zugeordnet.`;
}

/** The notification setting in a few words, on the closed section: what reaches the owner, without opening it. */
export function settingsSummary(channel: ChannelSetting, pushDevices: number, hasEmail: boolean): string {
  if (channel === 'in_app') return 'nur hier in der App';
  const mail = hasEmail ? 'E-Mail eingetragen' : 'keine E-Mail-Adresse';
  if (channel === 'email') return mail;
  const push = pushDevices === 0 ? 'Push aus' : pushDevices === 1 ? 'Push auf 1 Gerät' : `Push auf ${pushDevices} Geräten`;
  return `${push}, ${mail}`;
}

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
  const classified = classifySummary(checks.classify);
  if (classified) sentences.push(classified);
  const run = checks.loop;
  if (run) {
    const parts = [
      `Geprüft: ${plural(run.notified, 'neue Benachrichtigung', 'neue Benachrichtigungen')}`,
      `${plural(run.open, 'Zahlung wartet', 'Zahlungen warten')} auf einen Beleg`,
    ];
    if (run.deferred > 0) parts.push(`${plural(run.deferred, 'weitere folgt', 'weitere folgen')} beim nächsten Prüfen`);
    sentences.push(`${parts.join(', ')}.`);
    if (run.settledOwnName > 0) sentences.push(`${plural(run.settledOwnName, 'Benachrichtigung', 'Benachrichtigungen')} erledigt: eigenes Konto (Zahlungen an einen der eigenen Namen).`);
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

const noSubscribe = () => () => {};

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
  // Only a browser can say what it supports, and the first paint must match the server's, so that comes after it.
  const painted = useSyncExternalStore(noSubscribe, () => true, () => false);
  const [browser] = useState(() => (environment === undefined ? browserPushEnvironment() : environment));
  const env = painted ? browser : null;
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
 * The rest of the spending page after a change here. The overview, the budgets and what was bought are other tabs,
 * never on screen beside the checks, and a tab is read from the server when it opens, so nothing is read while a
 * person works down the list: one answer must not bring every payment back to the browser. The page is owed one read
 * on leaving, for what that tab's read could not know yet (an answer still on its way) and for the way back, which
 * is served from the router's cache. An answer arriving after that reads at once.
 */
function useReadOnLeaving(): () => void {
  const router = useRouter();
  const latest = useRef(router);
  const owed = useRef(false);
  const left = useRef(false);
  useEffect(() => {
    latest.current = router;
  });
  useEffect(() => {
    left.current = false;
    return () => {
      left.current = true;
      if (owed.current) latest.current.refresh();
      owed.current = false;
    };
  }, []);
  return () => {
    if (left.current) latest.current.refresh();
    else owed.current = true;
  };
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
    return 'Dieser Beleg ist schon durch andere Zahlungen bezahlt. Bitte prüfen, ob es der richtige Beleg ist; eine falsche Verknüpfung lässt sich unter Ausgaben (Zahlungen) oder unter Finanzen, Auswerten, Zahlungen lösen.';
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

/** A refusal in its place. Stays until it is closed, or the same thing is tried again. */
function RefusalNote({ message, onClose, className = 'mt-2' }: { message: string; onClose: () => void; className?: string }) {
  return (
    <div className={`ui-note ui-note-danger flex items-start justify-between gap-2 ${className}`} role="alert">
      <span>{message}</span>
      <button type="button" className="ui-btn ui-btn-sm ui-btn-ghost shrink-0" aria-label="Meldung schließen" onClick={onClose}>
        Schließen
      </button>
    </div>
  );
}

/** What a row asks of the page. Through a ref that always holds the latest ones, so a row's props say only what it shows. */
interface RowActions {
  confirm: (check: PaymentCheck, rowId: string) => void;
  noReceipt: (check: PaymentCheck, reason: string) => void;
  takeOver: (paymentId: string, mailId: string) => void;
  dismiss: (paymentId: string, mailId: string) => void;
  linkByHand: (check: PaymentCheck, rowId: string) => void;
  /** Search this company's receipts for this payment by name, vendor or amount. */
  search: (paymentId: string, text: string) => Promise<ChecksResult<ReceiptChoice[]>>;
  closeError: (paymentId: string) => void;
}

/**
 * Linking a receipt by hand. Reads `dataVersion` on its own: an open list is asked again when the
 * receipts change, and that must not redraw the rows whose list is closed.
 */
const PickReceipt = observer(function PickReceipt({ check, store, busy, actions }: { check: PaymentCheck; store: ChecksStore; busy: boolean; actions: RefObject<RowActions | null> }) {
  const id = useId();
  const { dataVersion } = store;
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
      const result = await (actions.current as RowActions).search(check.paymentId, text);
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
  return (
    <>
      {!picking && (
        <div className="mt-2">
          <button
            ref={pickOpener}
            type="button"
            className="ui-btn ui-btn-sm ui-btn-ghost"
            disabled={busy}
            onClick={() => {
              pickReopened.current = true;
              setPicking(true);
            }}
          >
            Vorhandenen Beleg zuordnen
          </button>
        </div>
      )}
      {picking && (
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
              <select id={`${id}-receipt`} className="ui-input" style={{ width: 'auto', maxWidth: '100%' }} value={chosen} disabled={busy} onChange={(e) => setChosen(e.target.value)}>
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
                disabled={busy || !chosen}
                aria-label={`Zuordnen: gewählten Beleg zu ${check.counterparty || 'dieser Zahlung'}`}
                onClick={() => actions.current?.linkByHand(check, chosen)}
              >
                Zuordnen
              </button>
            </div>
          )}
        </div>
      )}
    </>
  );
});

/**
 * One open payment. Redraws only when its own check or state changes, so an
 * answer about one payment leaves the other rows alone (as `QueueRow` does).
 */
const OpenCheck = memo(function OpenCheck({
  check,
  store,
  focused,
  canWrite,
  busy,
  error,
  takingOver,
  actions,
}: {
  check: PaymentCheck;
  store: ChecksStore;
  focused: boolean;
  canWrite: boolean;
  /** A bulk action is running, or this payment's mail is being taken over. */
  busy: boolean;
  error: string | null;
  /** The mail of this payment being taken over right now, if any. */
  takingOver: string | null;
  actions: RefObject<RowActions | null>;
}) {
  const id = useId();
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
                <button type="button" className="ui-btn ui-btn-sm ui-btn-primary" disabled={busy} onClick={() => actions.current?.confirm(check, c.rowId)} aria-label={`${c.label} als Beleg für diese Zahlung bestätigen`}>
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
                    disabled={busy}
                    aria-busy={takingOver === m.id}
                    onClick={() => actions.current?.takeOver(check.paymentId, m.id)}
                    aria-label={`${m.fileName} ${takingOver === m.id ? 'wird übernommen' : 'als Beleg übernehmen'}`}
                  >
                    {takingOver === m.id ? 'Wird übernommen …' : 'Als Beleg übernehmen'}
                  </button>
                  <button type="button" className="ui-btn ui-btn-sm ui-btn-ghost" disabled={busy} onClick={() => actions.current?.dismiss(check.paymentId, m.id)} aria-label={`${m.fileName} ist nicht die Rechnung`}>
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
      {canWrite && <PickReceipt check={check} store={store} busy={busy} actions={actions} />}
      {canWrite && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Link href={uploadForHref(check.paymentId)} className="ui-btn ui-btn-sm">
            Beleg fotografieren oder hochladen
          </Link>
          {!asking ? (
            <button
              ref={opener}
              type="button"
              className="ui-btn ui-btn-sm ui-btn-ghost"
              disabled={busy}
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
                actions.current?.noReceipt(check, reason);
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
              <button type="submit" className="ui-btn ui-btn-sm" disabled={busy || !reason.trim()} aria-label={`Antwort ohne Beleg für ${check.counterparty || 'diese Zahlung'} speichern`}>
                Speichern
              </button>
              <button type="button" className="ui-btn ui-btn-sm ui-btn-ghost" aria-label="Abbrechen: kein Beleg" onClick={() => setAsking(false)}>
                Abbrechen
              </button>
            </form>
          )}
        </div>
      )}
      {error && <RefusalNote message={error} onClose={() => actions.current?.closeError(check.paymentId)} />}
    </li>
  );
});

const ReceiptChecks = observer(function ReceiptChecks({
  initial,
  focusPaymentId,
  forCompany = null,
  openSettings = false,
}: {
  initial: ChecksView;
  focusPaymentId: string | null;
  /** The company a notification was about (`firma` in its link); the page offers to switch when another one is active. */
  forCompany?: string | null;
  /** The address asks for the notification settings (the phone's "Mehr" sheet links here). */
  openSettings?: boolean;
}) {
  const id = useId();
  // One store per visit and company (`page.tsx` keys this panel by company); the tab's count follows it.
  const app = useAppStore();
  const [store] = useState(() => new ChecksStore(initial, app.checkOutbox));
  useEffect(() => app.openChecks(store), [app, store]);
  // The page reads the checks afresh after a change elsewhere on it (a receipt taken back in the payment list): take
  // that over, keeping the summary of the last "Jetzt prüfen" (the page's own read carries none; the next action of
  // this panel ends it, as a notice belongs to the action that set it). (Another company remounts the panel: page.tsx.)
  useEffect(() => store.pageRead(initial), [store, initial]);
  const [pending, startTransition] = useTransition();
  const [channel, setChannel] = useState<ChannelSetting>(initial.settings.channel);
  const [email, setEmail] = useState(initial.settings.notifyEmail ?? '');
  const { open, years, proposedCount, backlogCount, canWrite, notifications, lastRun, counts, backlogBefore } = store;
  const certainCount = store.certainCount;
  const { lost, answered } = store.answers;
  const [yearChoice, setYearChoice] = useState<string | null>(null);
  const [onlyProposed, setOnlyProposed] = useState(false);
  const [limit, setLimit] = useState(CHECKS_PAGE);
  const [settingsShown, setSettingsShown] = useState(openSettings);
  const [askCertain, setAskCertain] = useState(false);
  const [askBacklog, setAskBacklog] = useState(false);
  const [answeredLimit, setAnsweredLimit] = useState(CHECKS_PAGE);
  const [lostLimit, setLostLimit] = useState(CHECKS_PAGE);
  // A chosen year that no longer has open payments counts as "all years", so the list never filters on an option the select no longer offers.
  const activeYear = yearChoice !== null && years.some((y) => String(y.year) === yearChoice) ? yearChoice : null;
  const { shown, matching } = store.filtered({ year: activeYear, onlyProposed, limit }, focusPaymentId);

  // The address asked for the settings: open them, also when the panel is on screen already.
  const [settingsAsked, setSettingsAsked] = useState(false);
  if (settingsAsked !== openSettings) {
    setSettingsAsked(openSettings);
    if (openSettings) setSettingsShown(true);
  }
  useEffect(() => {
    if (openSettings) document.getElementById(`${id}-settings`)?.scrollIntoView({ block: 'start' });
  }, [openSettings, id]);

  // A notification links here with the payment: bring it into view and give it the focus.
  useEffect(() => {
    if (!focusPaymentId) return;
    const item = document.getElementById(`pruefen-${focusPaymentId}`);
    item?.scrollIntoView({ block: 'center' });
    item?.focus();
  }, [focusPaymentId]);
  const otherCompany = forCompany !== null && forCompany !== store.workspaceId;
  const focusSettled = !otherCompany && focusPaymentId !== null && !open.some((c) => c.paymentId === focusPaymentId);

  const router = useRouter();
  const pageChanged = useReadOnLeaving();
  const focusHeading = () => document.getElementById(`${id}-title`)?.focus();
  /** A payment as a message names it where its row is not there to say which. */
  const nameOf = (paymentId: string) => {
    const c = store.find(paymentId);
    return c ? `${c.counterparty || c.reference || 'Zahlung ohne Namen'}, ${formatDay(c.bookingDay)}, ${euro(c.cents)}` : 'Zahlung';
  };
  /** A bulk action: everything is read anew. `changes`: it changed payments or links, not only how the owner is told. */
  const run = <T extends ChecksView>(at: string, action: () => Promise<ChecksResult<T>>, success?: (next: T) => string, changes = true) => {
    store.clearError(at);
    // A notice belongs to the action that set it: the next one starts without it.
    setPageNotice(null);
    startTransition(async () => {
      const result = await action();
      if (result.ok) {
        store.replaced(result.value);
        if (changes) pageChanged();
        if (success) {
          setPageNotice(success(result.value));
          focusHeading();
        }
      } else store.say(at, null, checksActionMessage(result));
    });
  };

  /** The server's word on a write already on screen. A refusal, or no answer at all, takes that one write back. */
  const settle = async (write: LocalWrite, action: () => Promise<ChecksResult<CheckChange>>): Promise<ChecksResult<CheckChange>> => {
    const result = await action().catch((): ChecksResult<CheckChange> => ({ ok: false, error: 'failed' }));
    if (result.ok) {
      store.confirm(write, result.value);
      pageChanged();
    } else store.refuse(write);
    return result;
  };

  /**
   * An answer about one payment: on screen at once, the server's word follows. Other rows stay usable meanwhile.
   * A refusal goes to the outbox, not to this panel: the person may have left it by then, believing it went through.
   */
  const answer = (paymentId: string, edit: CheckEdit, action: () => Promise<ChecksResult<CheckChange>>, linked: { rowId: string; notice: string } | null = null) => {
    const key = checkKey(paymentId);
    const who = nameOf(paymentId);
    store.clearError(key);
    setPageNotice(null);
    const write = store.begin(paymentId, edit, linked?.rowId ?? null);
    // The payment left the list with its buttons: the focus goes to the list's heading.
    focusHeading();
    void settle(write, action).then((result) => {
      if (!result.ok) store.say(key, who, checksActionMessage(result));
      else if (linked) setPageNotice(linked.notice);
    });
  };

  const errorAt = (at: string) => store.errorAt(at);
  const closeError = (at: string) => store.clearError(at);

  /** The push switch's calls to the server; each says whether the server took it, and a refusal shows at the switch. */
  const pushActions: PushActions = {
    enable: async (subscription) => {
      const result = await enablePush(subscription);
      if (result.ok) store.replaced(result.value);
      else store.say('push', null, checksActionMessage(result));
      return result.ok;
    },
    disable: async (endpoint) => {
      const result = await disablePush(endpoint);
      if (result.ok) store.replaced(result.value);
      else store.say('push', null, checksActionMessage(result));
      return result.ok;
    },
    stateOf: async (endpoint) => {
      const result = await pushStateOfDevice(endpoint);
      return result.ok ? result.value : null;
    },
  };
  const [takingOver, setTakingOver] = useState<ReadonlySet<string>>(new Set());
  const [pageNotice, setPageNotice] = useState<string | null>(null);

  /**
   * A found mail attachment goes through the normal upload path, then the receipt is linked. The upload takes its time
   * and can fail for reasons of its own, so the row stays and says what it is doing; the link is what shows at once.
   */
  const takeOver = async (paymentId: string, mailId: string) => {
    const key = checkKey(paymentId);
    const who = nameOf(paymentId);
    store.clearError(key);
    setPageNotice(null);
    setTakingOver((current) => new Set(current).add(mailId));
    try {
      const save: SaveReceipt = (file, ocr, options) =>
        processReceipt({ id: file.id, originalName: file.originalName, fileType: file.fileType }, ocr, options);
      const outcome = await takeOverMail(mailId, { fetchImpl: fetch, pipeline: createBrowserDeps(save, store.workspaceId) });
      if (outcome.kind === 'failed') {
        store.say(key, who, takeOverMessage(outcome));
        return;
      }
      const write = store.begin(paymentId, receiptLinked, outcome.rowId);
      // The row is gone with its button: the focus goes to the list's heading.
      focusHeading();
      // The owner chose this mail for this payment: the receipt is linked to it right away.
      const linked = await settle(write, () => linkTakenOver(paymentId, outcome.rowId));
      if (linked.ok) {
        setPageNotice(takeOverMessage(outcome, true));
        return;
      }
      // The only word that a receipt was made and is not linked: it stays until closed, at the row or, when the
      // payment left the list (answered, moved, its import undone) or the panel closed, in the shell.
      store.say(key, who, `${takeOverMessage(outcome, false)} ${checksActionMessage(linked)}`);
      const fresh = await getReceiptChecks().catch(() => null);
      if (fresh?.ok) (app.checks ?? store).pageRead(fresh.value);
    } catch {
      store.say(key, who, checksActionMessage({ ok: false, error: 'failed' }));
    } finally {
      setTakingOver((current) => {
        const left = new Set(current);
        left.delete(mailId);
        return left;
      });
    }
  };

  const rowActions = useRef<RowActions>(null);
  useEffect(() => {
    rowActions.current = {
      confirm: (c, rowId) => answer(c.paymentId, receiptLinked, () => confirmReceipt(c.paymentId, rowId), { rowId, notice: `Beleg zugeordnet: ${c.counterparty || 'Zahlung ohne Namen'}.` }),
      noReceipt: (c, reason) => answer(c.paymentId, answeredNoReceipt(reason), () => sayNoReceipt(c.paymentId, reason)),
      takeOver: (paymentId, mailId) => void takeOver(paymentId, mailId),
      dismiss: (paymentId, mailId) => answer(paymentId, mailSetAside(mailId), () => dismissMail(mailId)),
      linkByHand: (c, rowId) => answer(c.paymentId, receiptLinked, () => linkChosenReceipt(c.paymentId, rowId), { rowId, notice: `Beleg zugeordnet: ${c.counterparty || 'Zahlung ohne Namen'}.` }),
      search: (paymentId, text) => findReceiptChoices(paymentId, text),
      closeError: (paymentId) => closeError(checkKey(paymentId)),
    };
  });

  const markRead = async (noteId: string, who: string) => {
    const key = `note:${noteId}`;
    store.clearError(key);
    setPageNotice(null);
    store.markRead(noteId);
    const result = await readNotification(noteId).catch((): ChecksResult<{ at: number }> => ({ ok: false, error: 'failed' }));
    if (result.ok) store.readConfirmed(noteId, result.value.at);
    else {
      store.readRefused(noteId);
      store.say(key, who, checksActionMessage(result));
    }
  };

  const answeredItem = (c: PaymentCheck) => (
              <li key={c.paymentId} className="py-2 text-sm">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span>
                    {c.counterparty || c.reference || 'ohne Namen'}, {formatDay(c.bookingDay)}, {euro(c.cents)}
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
                    canWrite && (
                      <button type="button" className="ui-btn ui-btn-sm" disabled={pending} onClick={() => answer(c.paymentId, answerTakenBack, () => takeBackNoReceipt(c.paymentId))} aria-label={`Antwort für ${c.counterparty || 'diese Zahlung'} zurücknehmen`}>
                        Zurücknehmen
                      </button>
                    )
                  )}
                </div>
                {errorAt(checkKey(c.paymentId)) && <RefusalNote message={errorAt(checkKey(c.paymentId)) as string} onClose={() => closeError(checkKey(c.paymentId))} />}
              </li>
  );

  return (
    <section className="glass-panel mt-4 rounded-xl p-4" aria-labelledby={`${id}-title`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id={`${id}-title`} tabIndex={-1} className="text-sm font-semibold" style={{ color: 'var(--foreground)' }}>
          Belege prüfen ({open.length} offen)
        </h2>
        {canWrite && (
          <button type="button" className="ui-btn ui-btn-sm" disabled={pending} onClick={() => run('run', checkNow)}>
            Jetzt prüfen
          </button>
        )}
      </div>
      <p className="mt-1 text-xs" style={{ color: 'var(--muted)' }}>
        {counts.hasReceipt} mit Beleg, {counts.inMailbox} mit Rechnung im Postfach, {counts.notNeeded} brauchen keinen (Umbuchungen, Einnahmen, Erstattungen, Gebühren, Raten, Bargeld, Geld an Personen),{' '}
        {answered.length} ohne Beleg beantwortet{lost.length > 0 ? `, ${lost.length} nicht auffindbar` : ''}. Zahlungen vor 2025 werden nicht mehr geprüft.
      </p>
      {store.mailbox !== 'other_company' && (
        <p className="mt-1 text-xs" style={{ color: 'var(--muted)' }}>
          {store.mailbox === 'on'
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
                else store.say('run', null, 'Der Wechsel hat nicht geklappt; vielleicht fehlt der Zugang zu dieser Firma.');
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
      <p className={lastRun ? 'ui-note ui-note-ok mt-2' : 'sr-only'} role="status">
        {lastRun ? runSummary(lastRun) : ''}
      </p>
      {errorAt('run') && <RefusalNote message={errorAt('run') as string} onClose={() => closeError('run')} />}

      {canWrite && (
        <details id={`${id}-settings`} className="ui-disclosure mt-3 scroll-mt-4" open={settingsShown} onToggle={(e) => setSettingsShown(e.currentTarget.open)}>
          <summary className="cursor-pointer text-xs font-semibold">
            <svg className="ui-disclosure-chevron" viewBox="0 0 16 16" aria-hidden="true" focusable="false"> <path d="M6 3.5 10.5 8 6 12.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /> </svg>
            <span>
              Wie benachrichtigt wird
              <span className="block font-normal" style={{ color: 'var(--muted)' }}>
                {settingsSummary(store.settings.channel, store.pushDevices, store.settings.notifyEmail !== null)}
              </span>
            </span>
          </summary>
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
              publicKey={store.pushPublicKey}
              devices={store.pushDevices}
              channel={store.settings.channel}
              actions={pushActions}
              error={errorAt('push')}
            />
            {errorAt('settings') && <RefusalNote message={errorAt('settings') as string} onClose={() => closeError('settings')} className="" />}
          </form>
        </details>
      )}
      {canWrite && notifications.length > 0 && (
        <details className="ui-disclosure mt-3">
          <summary className="cursor-pointer text-xs font-semibold">
            <svg className="ui-disclosure-chevron" viewBox="0 0 16 16" aria-hidden="true" focusable="false"> <path d="M6 3.5 10.5 8 6 12.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /> </svg>
            Benachrichtigungen ({notifications.length})
          </summary>
          <ul className="mt-1 divide-y">
            {notifications.map((n) => (
              <li key={n.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
                <span>
                  <Link href={n.path} className="underline">
                    {n.title}
                  </Link>
                  <span className="ml-2 text-xs" style={{ color: n.failed ? 'var(--danger, var(--foreground))' : 'var(--muted)' }}>
                    {n.channel === 'push' ? 'aufs Telefon geschickt' : n.channel === 'email' ? 'per E-Mail geschickt' : n.failed ? 'Zustellung fehlgeschlagen, nur hier' : 'nur hier'}
                  </span>
                </span>
                {canWrite && (
                  <button type="button" className="ui-btn ui-btn-sm ui-btn-ghost" disabled={pending} onClick={() => void markRead(n.id, n.title)} aria-label={`${n.title} als gelesen markieren`}>
                    Gelesen
                  </button>
                )}
                {errorAt(`note:${n.id}`) && <RefusalNote message={errorAt(`note:${n.id}`) as string} onClose={() => closeError(`note:${n.id}`)} className="w-full" />}
              </li>
            ))}
          </ul>
        </details>
      )}

      {open.length === 0 ? (
        <p className="mt-3 text-sm" style={{ color: 'var(--muted)' }}>
          Für jede Zahlung, die einen Beleg braucht, ist einer da oder gesagt, warum es keinen gibt.
        </p>
      ) : (
        <>
          <div className="mt-3 flex flex-wrap items-center gap-2" role="group" aria-label="Offene Zahlungen eingrenzen">
            <label className="sr-only" htmlFor={`${id}-check-year`}>
              Jahr der Zahlung
            </label>
            <select
              id={`${id}-check-year`}
              className="ui-input"
              style={{ width: 'auto' }}
              value={activeYear ?? ''}
              onChange={(e) => {
                setYearChoice(e.target.value || null);
                setLimit(CHECKS_PAGE);
              }}
            >
              <option value="">Alle Jahre ({open.length})</option>
              {years.map((y) => (
                <option key={y.year} value={y.year}>
                  {y.year} ({y.count})
                </option>
              ))}
            </select>
            {(proposedCount > 0 || onlyProposed) && (
              <button
                type="button"
                className="ui-btn ui-btn-sm"
                aria-pressed={onlyProposed}
                onClick={() => {
                  setOnlyProposed((v) => !v);
                  setLimit(CHECKS_PAGE);
                }}
              >
                Mit Vorschlag ({proposedCount})
              </button>
            )}
            {canWrite && certainCount > 0 && (
              <button type="button" className="ui-btn ui-btn-sm ui-btn-primary" disabled={pending} onClick={() => setAskCertain(true)}>
                {certainCount} sichere Belege zuordnen
              </button>
            )}
            {canWrite && backlogCount > 0 && (
              <button type="button" className="ui-btn ui-btn-sm" disabled={pending} onClick={() => setAskBacklog(true)}>
                Alles vor {formatDay(backlogBefore)} abschließen ({backlogCount})
              </button>
            )}
          </div>
          <ConfirmDialog
            open={askCertain}
            title={`${certainCount} sichere Belege zuordnen?`}
            confirmLabel="Zuordnen"
            busy={pending}
            onConfirm={() => {
              setAskCertain(false);
              const before = open.length;
              run('run', linkCertain, (next) => certainNotice(before - next.loop.open.length));
            }}
            onCancel={() => setAskCertain(false)}
          >
            Bei diesen Zahlungen stimmt der Betrag genau, der Anbieter ist genannt, und es passt nur dieser eine Beleg. Jede Zuordnung lässt sich unter Finanzen wieder lösen.
          </ConfirmDialog>
          <ConfirmDialog
            open={askBacklog}
            title={`${backlogCount} Zahlungen abschließen?`}
            confirmLabel="Abschließen"
            busy={pending}
            onConfirm={() => {
              setAskBacklog(false);
              run('run', closeReceiptBacklog, (next) => backlogNotice(next.closed));
            }}
            onCancel={() => setAskBacklog(false)}
          >
            Passende Belege werden zugeordnet. Der Rest gilt als privat ohne Beleg oder, wenn es geschäftlich sein kann, als nicht auffindbar und bleibt rot in der Liste darunter. Offen bleibt nur, was im Postfach liegt. Jede Antwort lässt sich einzeln zurücknehmen.
          </ConfirmDialog>
          {matching === 0 && (
            <p className="mt-3 text-sm" style={{ color: 'var(--muted)' }}>
              In dieser Auswahl ist keine Zahlung offen.
            </p>
          )}
          <ul className="mt-3 divide-y">
            {shown.map((c) => {
              const mail = c.state.state === 'in_mailbox' ? (c.state.mails.find((m) => takingOver.has(m.id))?.id ?? null) : null;
              return (
                <OpenCheck
                  key={c.paymentId}
                  check={c}
                  store={store}
                  focused={c.paymentId === focusPaymentId}
                  canWrite={canWrite}
                  busy={pending || mail !== null}
                  error={errorAt(checkKey(c.paymentId))}
                  takingOver={mail}
                  actions={rowActions}
                />
              );
            })}
          </ul>
          {matching > limit && (
            <button type="button" className="ui-btn mt-3 w-full" onClick={() => setLimit((n) => n + CHECKS_PAGE)}>
              Weitere {Math.min(CHECKS_PAGE, matching - limit)} zeigen (noch {matching - limit})
            </button>
          )}
        </>
      )}

      {lost.length > 0 && (
        <details className="ui-disclosure mt-3">
          <summary className="cursor-pointer text-xs font-semibold" style={{ color: 'var(--danger, #f87171)' }}>
            Nicht auffindbar ({lost.length})
          </summary>
          <p className="mt-1 text-xs" style={{ color: 'var(--muted)' }}>
            Könnte geschäftlich sein, und kein Beleg wurde gefunden. Taucht einer auf, die Antwort zurücknehmen und zuordnen.
          </p>
          <ul className="mt-2 divide-y">{lost.slice(0, lostLimit).map(answeredItem)}</ul>
          {lost.length > lostLimit && (
            <button type="button" className="ui-btn mt-2 w-full" onClick={() => setLostLimit((n) => n + CHECKS_PAGE)}>
              Weitere zeigen (noch {lost.length - lostLimit})
            </button>
          )}
        </details>
      )}

      {answered.length > 0 && (
        <details className="ui-disclosure mt-3">
          <summary className="cursor-pointer text-xs font-semibold">Ohne Beleg beantwortet ({answered.length})</summary>
          <ul className="mt-2 divide-y">{answered.slice(0, answeredLimit).map(answeredItem)}</ul>
          {answered.length > answeredLimit && (
            <button type="button" className="ui-btn mt-2 w-full" onClick={() => setAnsweredLimit((n) => n + CHECKS_PAGE)}>
              Weitere zeigen (noch {answered.length - answeredLimit})
            </button>
          )}
        </details>
      )}

    </section>
  );
});

export default ReceiptChecks;
