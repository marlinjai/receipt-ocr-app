'use client';

import { useEffect, useId, useMemo, useRef, useState, useTransition, type KeyboardEvent } from 'react';
import Link from 'next/link';
import { receiptHref } from '@/lib/receipt-link';
import { useRouter } from 'next/navigation';
import { formatDay } from '@/lib/meals/messages';
import { CHECK_LABELS, ORIGIN_LABELS, PURPOSE_LABELS, financeActionMessage } from '@/lib/tax/messages';
import { formatCents } from '@/lib/tax/money';
import type { AssetView, StatementItem, StatementView } from '@/lib/tax/service';
import type { OpenCheckKind } from '@/lib/tax/types';
import {
  acceptPaymentProposals,
  markAccountPrivate,
  markPaymentTransfer,
  getStatement,
  removeAccount,
  addAccount,
  decideLine,
  removeLines,
  saveLines,
  confirmPaymentLink,
  correctPaymentKind,
  decideItem,
  disposeAsset,
  importPaymentFile,
  importPaymentPdf,
  classifyCounterpartiesNow,
  recordStatusChange,
  recordVatSettlement,
  removeAsset,
  removeIssuedInvoice,
  removePaymentLink,
  removeStatusChange,
  removeVatSettlement,
  removeReverseChargeVendor,
  removeVendorRule,
  resetItem,
  resetReverseCharge,
  setReverseCharge,
  saveAsset,
  saveIssuedInvoice,
  searchPayments,
  setRevenueExpectation,
  setVatSettings,
  treatCounterparty,
  undoImport,
  type Result,
} from './actions';
import LinesForm, { type LineDraft } from './LinesForm';
import PaymentsTab from './PaymentsTab';
import { useBankFeed, type BankActions } from './BankConnection';
import { chooseBankConnectionAccount, clearBankConnectionNotice, disconnectBank, listBankInstitutions, startBankConsent, syncBankNow, type BankView } from './bank-actions';
import AccountSharing, { type SharingActions } from './AccountSharing';
import { endAccountShare, shareAccountWith, type SharingView } from './sharing-actions';
import { returnMessage } from '@/lib/tax/payments/bank/messages';
import type { ImportResult } from '@/lib/tax/payments/service';
import RevenueTab from './RevenueTab';
import OverdueInvoices from './OverdueInvoices';
import VatTab from './VatTab';
import ReverseChargeForm from './ReverseChargeForm';
import AssetsTab, { type AssetDraft, type DisposalDraft } from './AssetsTab';
import IncomeTaxTab, { balanceText } from './IncomeTaxTab';
import { removeTaxReturnItem, removeWage, saveTaxReturnItem, saveWage, setChurchMonths, setFederalState, setFiledOn } from './income-tax-actions';
import { incomeTaxActionMessage } from '@/lib/tax/income-tax/messages';
import TreatmentForm, { type TreatmentSubmit } from './TreatmentForm';
import { useTabInView } from '@/lib/use-tab-in-view';
import { GROUPS, addressOf, defaultTab, groupCount, groupOf, waitingCounts, type GroupKey, type TabKey } from './tabs';
import OwnNames, { ownNamesMessage } from '../spending/OwnNames';
import { changeOwnNames, type OwnNamesView } from './own-names-actions';

/** Checks one setting answers for every item at once: shown as one notice, not once per receipt. */
const WORKSPACE_CHECKS: OpenCheckKind[] = ['small_business_unanswered'];
/** Checks that are resolved on the receipt itself or in the meal register, not with a decision here. */
const MEAL_CHECKS: OpenCheckKind[] = ['meal_incomplete', 'meal_without_register_facts'];
const RECEIPT_CHECKS: OpenCheckKind[] = ['no_date', 'no_amount', 'no_exchange_rate'];
/** Checks that are resolved by making the receipt part of an asset (or by adding its net amount). */
const ASSET_CHECKS: OpenCheckKind[] = ['needs_asset', 'net_amount_needed'];

function euro(cents: number): string {
  return `${formatCents(cents)} €`;
}

function allocationText(item: StatementItem): string {
  if (!item.allocations) return 'nicht entschieden';
  return item.allocations.map((a) => `${a.shareBp / 100} % ${PURPOSE_LABELS[a.purpose]}`).join(' + ');
}

/** The headline of the income tax estimate: the expected refund or payment, labelled an estimate, with what it covers. */
function incomeTaxTile(view: StatementView): { label: string; value: string; hint: string } {
  const tax = view.incomeTax;
  const estimate = tax.projected ?? tax.estimate;
  const label = `Einkommensteuer ${view.year} (Schätzung)`;
  if (estimate.scope === 'none') return { label, value: 'offen', hint: 'Lohnabrechnung unter „Einkommensteuer“ eintragen' };
  const value =
    estimate.totalBalanceCents === null ? balanceText(estimate.totalWithoutChurchCents) : balanceText(estimate.totalBalanceCents);
  const parts = [
    estimate.scope === 'business_only' ? 'nur Gewerbe, ohne Lohn' : estimate.scope === 'without_business' ? 'ohne Gewerbe' : 'Lohn und Gewerbe',
    tax.projected ? 'Lohn hochgerechnet' : '',
    estimate.missing.length > 0 ? `${estimate.missing.length} Angaben fehlen` : '',
  ].filter(Boolean);
  return { label, value, hint: parts.join(', ') };
}

/** The items a person has to act on, oldest first; workspace-wide questions are left to the notice above. */
export function openQueue(view: StatementView): StatementItem[] {
  return view.items.filter((i) => i.checks.some((c) => c.blocking && !WORKSPACE_CHECKS.includes(c.kind)));
}

const BANK_ACTIONS: BankActions = { listBankInstitutions, startBankConsent, chooseBankConnectionAccount, syncBankNow, disconnectBank, clearBankConnectionNotice };
const NO_BANK: BankView = { enabled: false, connections: [] };
const SHARING_ACTIONS: SharingActions = { shareAccountWith, endAccountShare };
/** The part of the payments each of their three tabs shows. */
const PAYMENT_PARTS = { questions: ['questions'], payments: ['list'], accounts: ['accounts'] } as const;
/** Tabs whose forms show a failure next to what was typed; on every other tab it is shown above the panel. */
const OWN_ERROR_TABS: readonly TabKey[] = ['open', 'questions', 'payments', 'accounts', 'vat', 'tax', 'names'];

export default function FinanceClient({
  initial,
  initialTab,
  bank: bankInitial = null,
  bankReturn = null,
  bankActions = BANK_ACTIONS,
  sharing = null,
  sharingFailed = false,
  sharingActions = SHARING_ACTIONS,
  ownNames: ownNamesInitial = null,
}: {
  initial: StatementView;
  initialTab?: TabKey;
  /** The live bank connections; null when they could not be read (the payments tab then shows no bank controls). */
  bank?: BankView | null;
  /** The outcome of the return from the bank (`?bank=`). */
  bankReturn?: string | null;
  bankActions?: BankActions;
  /** Sharing an account's private payments with another company; null when it could not be read (the section is then left out). */
  sharing?: SharingView | null;
  /** True when the sharing section could not be read: it says so instead of disappearing. */
  sharingFailed?: boolean;
  sharingActions?: SharingActions;
  /** The owner's own names, the same list as on Ausgaben; null when they could not be read (the tab then says so). */
  ownNames?: OwnNamesView | null;
}) {
  const tabsId = useId();
  const router = useRouter();
  const [view, setView] = useState(initial);
  // Two levels (plan 2026-10-25-finance-groups): a group, and the tab last chosen inside each group, so going
  // to another group and back finds the tab that was open there. Without an address the page opens on the first
  // work that waits; an overdue invoice is an open check too (decision D6 of the invoicing plan).
  const [firstTab] = useState<TabKey>(() => initialTab ?? defaultTab(waitingCounts(initial, openQueue(initial).length)));
  const [chosen, setChosen] = useState<Record<GroupKey, TabKey>>(() => {
    const byGroup = Object.fromEntries(GROUPS.map((g) => [g.key, g.tabs[0].key])) as Record<GroupKey, TabKey>;
    return { ...byGroup, [groupOf(firstTab).key]: firstTab };
  });
  const [group, setGroup] = useState<GroupKey>(() => groupOf(firstTab).key);
  const tab = chosen[group];
  // What the last action said belongs to the place it was done in: another tab or group starts without it,
  // and the outcome of the return from the bank is shown once, not again on the next visit to the accounts.
  const leave = () => {
    setError(null);
    setNotice(null);
    setNamesError(null);
    setNamesNotice(null);
    setBankNotice(null);
    setLastImport(null);
  };
  const showGroup = (next: GroupKey) => {
    if (next !== group) leave();
    setGroup(next);
  };
  const setTab = (next: TabKey) => {
    const owner = groupOf(next).key;
    if (next !== tab) leave();
    setChosen((c) => ({ ...c, [owner]: next }));
    setGroup(owner);
  };
  // On a phone the tab row scrolls sideways; the open tab is kept in view.
  const tabRow = useRef<HTMLDivElement>(null);
  useTabInView(tabRow, tab);
  const bankFeed = useBankFeed(bankInitial ?? NO_BANK, view.year, bankActions, (next) => setView(next), (url) => window.location.assign(url));
  const [bankNotice, setBankNotice] = useState(() => returnMessage(bankReturn));
  // The address keeps the open tab, so a reload or a shared link opens the same place. The outcome of the
  // return from the bank is shown once: the address loses it, so a reload does not repeat it. A visit
  // without an address keeps none until the person chooses a tab: a reload then chooses again by what waits.
  useEffect(() => {
    const url = new URL(window.location.href);
    if (tab === firstTab && !url.searchParams.has('reiter') && !url.searchParams.has('bank')) return;
    const before = url.toString();
    url.searchParams.set('reiter', addressOf(tab));
    url.searchParams.delete('bank');
    if (url.toString() !== before) window.history.replaceState(null, '', url.toString());
  }, [tab, firstTab]);
  const [ownNames, setOwnNames] = useState(ownNamesInitial);
  const [namesError, setNamesError] = useState<string | null>(null);
  const [namesNotice, setNamesNotice] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  // The item of the statement tab whose receipt is being split (its lines change the item ids, so both close together).
  const [splittingId, setSplittingId] = useState<string | null>(null);
  const closeEditing = () => {
    setEditingId(null);
    setSplittingId(null);
  };
  const [openLine, setOpenLine] = useState<string | null>(null);
  const [assetFromRow, setAssetFromRow] = useState<string | null>(null);
  const [lastImport, setLastImport] = useState<ImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  // A different year arrives as new props after the navigation.
  const [seenYear, setSeenYear] = useState(initial.year);
  if (initial.year !== seenYear) {
    setSeenYear(initial.year);
    setView(initial);
    setSelectedId(null);
    setEditingId(null);
    setOpenLine(null);
    setAssetFromRow(null);
    setLastImport(null);
    setError(null);
    setNotice(null);
    // The names are read afresh with the other year (another page may have changed them); old messages go.
    setOwnNames(ownNamesInitial);
    setNamesError(null);
    setNamesNotice(null);
    setBankNotice(null);
  }

  const queue = useMemo(() => openQueue(view), [view]);
  const selected = queue.find((i) => i.itemId === selectedId) ?? queue[0] ?? null;
  const itemsById = useMemo(() => new Map(view.items.map((i) => [i.itemId, i])), [view]);
  const assetsById = useMemo(() => new Map(view.assets.map((a) => [a.id, a])), [view]);
  const overdue = view.revenue.overdue;
  const openAssets = view.assets.filter((a) => a.checks.length > 0).length;
  const estimated = view.items.filter((i) => i.checks.some((c) => c.kind === 'amount_estimated')).length;
  const blockedBySetting =
    view.items.filter((i) => i.checks.some((c) => WORKSPACE_CHECKS.includes(c.kind))).length;
  const counts = waitingCounts(view, queue.length);

  function run(
    action: () => Promise<Result<StatementView>>,
    done: string,
    after?: (next: StatementView) => void,
    message: (error: string, detail?: string) => string = financeActionMessage,
  ) {
    setError(null);
    setNotice(null);
    startTransition(async () => {
      let result: Result<StatementView>;
      try {
        result = await action();
      } catch {
        // The request itself failed (offline, server restart): say so instead of looking saved.
        setError(financeActionMessage('failed'));
        return;
      }
      if (!result.ok) {
        setError(message(result.error, result.detail));
        return;
      }
      setView(result.value);
      setNotice(done);
      after?.(result.value);
    });
  }

  /**
   * Link a payment. A receipt that already carries payments is not linked
   * silently a second time: the server answers with what is on it, the person
   * is asked, and only a yes sends the link again.
   */
  function linkWithQuestion(input: { paymentId: string; rowId?: string; invoiceId?: string; cents?: number }, confirmed = false) {
    let moved = false;
    let question: string | null = null;
    run(
      async () => {
        const result = await confirmPaymentLink(view.year, { ...input, confirmed });
        if (!result.ok) {
          const [code, paid, own] = (result.detail ?? '').split(':');
          if (code === 'receipt_already_paid') {
            question = `Dieser Beleg hat schon eine Zahlung über ${euro(Number(paid))} (Belegbetrag ${euro(Number(own))}). Diese Zahlung zusätzlich zuordnen? Der Beleg zählt dann mit der Summe aller zugeordneten Zahlungen.`;
            return { ok: true, value: view };
          }
          // Money back a little above what the receipt still costs (exchange rates): asked once, then within the tolerance.
          if (code === 'refund_exceeds_receipt' && !confirmed && Number(paid) > 0) {
            question = `Diese Erstattung ist größer als das, was der Beleg noch kostet (${euro(Number(paid))}). Nur diese ${euro(Number(paid))} zuordnen? Der Rest der Zahlung bleibt offen (zum Beispiel ein Kursgewinn oder eine Erstattung für etwas anderes).`;
            return { ok: true, value: view };
          }
          return result;
        }
        moved = result.value.moved;
        return { ok: true, value: result.value.view };
      },
      'Zahlung zugeordnet.',
      () => {
        if (question !== null) {
          setNotice(question.startsWith('Diese Erstattung') ? 'Nichts zugeordnet: die Erstattung ist größer als der Rest des Belegs.' : 'Nichts zugeordnet: der Beleg hat schon eine Zahlung.');
          if (window.confirm(question)) linkWithQuestion(input, true);
        } else if (moved) {
          setNotice('Zahlung zugeordnet. Die bisherige Zuordnung dieses Belegs zur Abbuchung auf dem Bankkonto wurde hierher verschoben: es ist dasselbe Geld.');
        }
      },
    );
  }

  function decide(item: StatementItem, submit: TreatmentSubmit) {
    const label = item.vendor || item.label;
    run(
      () =>
        item.lineId
          ? decideLine(view.year, item.lineId, submit.treatment)
          : decideItem(view.year, {
              rowId: item.rowId,
              treatment: submit.treatment,
              applyToVendor: submit.applyToVendor ?? undefined,
            }),
      submit.applyToVendor ? `${label}: Regel für den Lieferanten gespeichert.` : `${label}: gespeichert.`,
      (next) => {
        setEditingId(null);
        // Advance to the entry after this one, as the meal queue does.
        const before = queue.findIndex((i) => i.itemId === item.itemId);
        const nextQueue = openQueue(next);
        const following = queue.slice(before + 1).find((i) => nextQueue.some((n) => n.itemId === i.itemId));
        setSelectedId(following?.itemId ?? nextQueue[0]?.itemId ?? null);
      },
    );
  }

  const saveAssetDraft = (assetId: string | null, draft: AssetDraft, done: () => void) =>
    run(() => saveAsset(view.year, assetId, draft), `${draft.label}: Anlage gespeichert.`, done);
  const deleteAssetView = (asset: AssetView) => run(() => removeAsset(view.year, asset.id), `${asset.label}: Anlage gelöscht.`);
  const disposeAssetView = (asset: AssetView, disposal: DisposalDraft | null, done: () => void) =>
    run(
      () => disposeAsset(view.year, asset.id, disposal),
      disposal ? `${asset.label}: Abgang gespeichert.` : `${asset.label}: Abgang zurückgenommen.`,
      done,
    );

  /** Add or take out an own name; resolves true when the server took it (the field is then emptied). */
  const changeNames = (change: { add: string } | { remove: string }) =>
    new Promise<boolean>((resolve) => {
      setNamesError(null);
      setNamesNotice(null);
      startTransition(async () => {
        let result: Awaited<ReturnType<typeof changeOwnNames>>;
        try {
          result = await changeOwnNames(view.year, change);
        } catch {
          // The request itself failed (offline, server restart): say so instead of looking saved.
          setNamesError(financeActionMessage('failed'));
          return resolve(false);
        }
        if (!result.ok) {
          setNamesError(ownNamesMessage(result.detail) ?? financeActionMessage(result.error, result.detail));
          return resolve(false);
        }
        const { names, settledOwnName, view: next } = result.value;
        setOwnNames((current) => (current ? { ...current, names } : current));
        if (next) setView(next);
        setNamesNotice(
          ('add' in change
            ? `${change.add} gespeichert.${settledOwnName > 0 ? ` ${settledOwnName} ${settledOwnName === 1 ? 'Benachrichtigung' : 'Benachrichtigungen'} erledigt: eigenes Konto.` : ''}`
            : `${change.remove} entfernt.`) + (next ? '' : ' Die Übersicht konnte danach nicht neu gerechnet werden; bitte die Seite neu laden.'),
        );
        resolve(true);
      });
    });

  const activeGroup = GROUPS.find((g) => g.key === group)!;

  return (
    <main className="relative z-10 min-h-svh px-4 pb-16 pt-6 sm:px-6" data-theme="dark">
      <div className="mx-auto w-full max-w-[88rem]">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold" style={{ color: 'var(--foreground)' }}>
              Finanzen
            </h1>
            <p className="mt-1 text-sm" style={{ color: 'var(--muted)' }}>
              Einnahmenüberschussrechnung aus den Belegen, Zeile für Zeile nachvollziehbar.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <label className="sr-only" htmlFor={`${tabsId}-year`}>
              Jahr
            </label>
            <select
              id={`${tabsId}-year`}
              className="ui-input"
              style={{ width: 'auto' }}
              value={view.year}
              onChange={(e) => router.push(`/app/finance?jahr=${e.target.value}&reiter=${addressOf(tab)}`)}
            >
              {view.years.map((y) => (
                <option key={y} value={y}>
                  {y}
                </option>
              ))}
            </select>
            <Link href="/app/meals" className="ui-btn">
              Bewirtungen
            </Link>
            <Link href="/app/dashboard" className="ui-btn">
              Dashboard
            </Link>
          </div>
        </div>

        <div className="mt-4 space-y-2">
          {!view.initialized && (
            <p className="ui-note ui-note-warn">
              Für diesen Arbeitsbereich gibt es noch keine Belegtabelle. Sie wird beim ersten Öffnen des{' '}
              <Link href="/app/dashboard" className="underline">
                Dashboards
              </Link>{' '}
              angelegt.
            </p>
          )}
          {view.smallBusiness === null && view.items.length > 0 && (
            <p className="ui-note ui-note-warn">
              Die Frage zur Kleinunternehmerregelung (§ 19 Umsatzsteuergesetz) ist noch nicht beantwortet. Davon hängt
              ab, ob brutto oder netto abgezogen wird; bis dahin wird kein Beleg gerechnet ({blockedBySetting}{' '}
              betroffen). Die Frage wird im{' '}
              <Link href="/app/meals" className="underline">
                Bewirtungsverzeichnis
              </Link>{' '}
              unter „Verzeichnis“ gestellt.
            </p>
          )}
          {view.vat.applies && (
            <p className="ui-note">
              In {view.year} gilt (zumindest zeitweise) die Regelbesteuerung: Belege aus dieser Zeit zählen mit ihrem
              Nettobetrag, die Umsatzsteuer darin ist Vorsteuer. Ein Beleg ohne Nettobetrag steht unter „Offen“.
            </p>
          )}
          {!view.rulesExact && (
            <p className="ui-note ui-note-warn">
              Für {view.year} sind noch keine eigenen Regeln hinterlegt. Gerechnet wird mit den Regeln von{' '}
              {view.rulesYear}.
            </p>
          )}
          {view.rulesProvisional && (
            <p className="ui-note ui-note-warn">
              Die Regeln für {view.rulesYear} sind vorläufig: {view.rulesProvisional.reason} Gerechnet wird mit den Werten
              von {view.rulesProvisional.carriedFromYear}; die Zeilen werden ohne Nummer gezeigt, bis der amtliche
              Vordruck vorliegt.
            </p>
          )}
          {view.rulesExact && !view.rulesProvisional && view.lines.some((l) => l.numbering === 'unverified') && (
            <p className="ui-note">
              Für einige Zeilen der Anlage N {view.year} sind die Zeilennummern noch nicht mit dem amtlichen Vordruck
              abgeglichen. Dort wird nur die Bezeichnung angezeigt, keine Nummer eines anderen Jahres.
            </p>
          )}
          {view.lines.some((l) => l.numbering === 'structured') && (
            <p className="ui-note">
              Für Fahrten zur Tätigkeitsstätte und die Tagespauschale fragt das Formular Tage und Entfernungen ab,
              keinen Betrag. Die hier gezeigte Summe dient der Übersicht und wird nicht in eine Formularzeile
              eingetragen.
            </p>
          )}
          {!view.revenue.recorded && (
            <p className="ui-note">
              Es ist noch keine Rechnung erfasst. Diese Ansicht zeigt deshalb nur die Ausgabenseite; ein Gewinn oder
              Verlust wird erst ausgewiesen, wenn unter „Einnahmen“ Rechnungen mit ihren Zahlungseingängen stehen.
            </p>
          )}
        </div>

        {/* Two tiles to a row on a phone (the result across both), so the five figures fit about one screen. */}
        <dl className="mt-4 grid grid-cols-2 gap-3 lg:grid-cols-5">
          {[
            {
              label: view.profitCents === null ? `Ergebnis ${view.year}` : view.profitCents < 0 ? `Verlust ${view.year}` : `Gewinn ${view.year}`,
              value: view.profitCents === null ? 'offen' : euro(Math.abs(view.profitCents)),
              hint:
                view.profitCents === null
                  ? 'erst mit erfassten Rechnungen'
                  : `Einnahmen ${euro(view.businessRevenueCents)}${queue.length > 0 ? `, ${queue.length} Belege noch offen` : ''}`,
            },
            { label: `Betriebsausgaben ${view.year}`, value: euro(view.businessExpenseCents), hint: `${view.countedItems} Belege gerechnet` },
            { label: 'Kosten für die Anlage N', value: euro(view.employmentCostCents), hint: 'Studium und Anstellung' },
            incomeTaxTile(view),
            {
              label: 'Offene Prüfungen',
              value: String(queue.length + overdue.length),
              hint:
                [
                  overdue.length > 0 ? (overdue.length === 1 ? '1 Rechnung überfällig' : `${overdue.length} Rechnungen überfällig`) : '',
                  estimated > 0 ? `${estimated} mit geschätztem Betrag` : '',
                  openAssets > 0 ? `${openAssets} Anlagen mit offener Prüfung` : '',
                ]
                  .filter(Boolean)
                  .join(', ') || 'Belege, die eine Entscheidung brauchen',
            },
          ].map((tile, index) => (
            <div key={tile.label} className={`glass-panel min-w-0 rounded-xl p-3 sm:p-4 ${index === 0 ? 'col-span-2 lg:col-span-1' : ''}`}>
              <dt className="ui-label">{tile.label}</dt>
              <dd className="text-lg font-semibold tabular-nums sm:text-2xl" style={{ color: 'var(--foreground)' }}>
                {tile.value}
              </dd>
              <dd className="mt-1 text-xs" style={{ color: 'var(--muted)' }}>
                {tile.hint}
              </dd>
            </div>
          ))}
        </dl>
        <p className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs" style={{ color: 'var(--muted)' }}>
          <span>Hier steht der Betrieb für die Steuererklärung. Alle Ausgaben, private eingeschlossen, mit Budgets:</span>
          <Link href="/app/spending" className="ui-btn ui-btn-sm">
            Ausgaben
          </Link>
        </p>

        {/* Four groups (two to a row on a phone, so none scrolls out of sight), the tabs of the chosen group below. */}
        <div role="tablist" aria-label="Bereiche der Finanzübersicht" className="mt-6 grid grid-cols-2 gap-2 sm:flex sm:flex-wrap">
          {GROUPS.map((g) => {
            const count = groupCount(g, counts);
            const selected = group === g.key;
            return (
              <button
                key={g.key}
                role="tab"
                type="button"
                id={`${tabsId}-group-${g.key}`}
                aria-selected={selected}
                aria-controls={`${tabsId}-group-panel`}
                tabIndex={selected ? 0 : -1}
                onClick={() => showGroup(g.key)}
                onKeyDown={(e) => arrowTo(e, GROUPS.map((x) => x.key), g.key, `${tabsId}-group-`, showGroup)}
                className="flex min-h-11 items-center justify-between gap-2 rounded-lg border px-3 py-2 text-left text-sm font-semibold transition-colors duration-150 sm:justify-start"
                style={{
                  borderColor: selected ? 'rgba(226, 163, 72, 0.55)' : 'var(--border)',
                  background: selected ? 'var(--accent-muted)' : 'var(--surface)',
                  color: selected ? 'var(--accent)' : 'var(--foreground)',
                }}
              >
                {g.label}
                {count !== undefined && (
                  <span className="rounded-full px-1.5 py-0.5 text-xs tabular-nums" style={{ background: 'rgba(255,255,255,0.07)', color: 'var(--foreground)' }}>
                    <span className="sr-only">, </span>
                    {count}
                    <span className="sr-only"> offen</span>
                  </span>
                )}
              </button>
            );
          })}
        </div>

        <div role="tabpanel" id={`${tabsId}-group-panel`} aria-labelledby={`${tabsId}-group-${group}`}>
        <div ref={tabRow} role="tablist" aria-label={`Reiter in ${activeGroup.label}`} className="ui-scroll-bare-phone mt-3 flex gap-1 overflow-x-auto overflow-y-hidden border-b" style={{ borderColor: 'var(--border)' }}>
          {activeGroup.tabs.map((t) => ({ ...t, count: counts[t.key] })).map((t) => (
            <button
              key={t.key}
              role="tab"
              type="button"
              id={`${tabsId}-tab-${t.key}`}
              aria-selected={tab === t.key}
              aria-controls={`${tabsId}-panel`}
              tabIndex={tab === t.key ? 0 : -1}
              onClick={() => setTab(t.key)}
              onKeyDown={(e) => arrowTo(e, activeGroup.tabs.map((x) => x.key), t.key, `${tabsId}-tab-`, setTab)}
              className="-mb-px shrink-0 border-b-2 px-3 py-2.5 text-sm font-medium transition-colors duration-150 max-sm:min-h-11"
              style={{
                borderColor: tab === t.key ? 'var(--accent)' : 'transparent',
                color: tab === t.key ? 'var(--accent)' : 'var(--muted)',
              }}
            >
              {t.label}
              {t.count !== undefined && (
                <span className="ml-2 rounded-full px-1.5 py-0.5 text-xs tabular-nums" style={{ background: 'rgba(255,255,255,0.07)', color: 'var(--foreground)' }}>
                  <span className="sr-only">, </span>
                  {t.count}
                  <span className="sr-only"> offen</span>
                </span>
              )}
            </button>
          ))}
        </div>

        <div role="status" aria-live="polite" className="mt-4 min-h-5 text-sm" style={{ color: 'var(--muted)' }}>
          {notice}
        </div>
        {/* The forms on the queue, payments and tax tabs show a failure next to what was typed; everywhere else it is shown here. */}
        {error && !OWN_ERROR_TABS.includes(tab) && (
          <p className="ui-note ui-note-danger mt-2" role="alert">
            {error}
          </p>
        )}

        <div role="tabpanel" id={`${tabsId}-panel`} aria-labelledby={`${tabsId}-tab-${tab}`} className="mt-4">
          {tab === 'open' && overdue.length > 0 && <OverdueInvoices overdue={overdue} onOpenRevenue={() => setTab('revenue')} />}
          {tab === 'open' &&
            (queue.length === 0 ? (
              overdue.length > 0 ? null : (
              <div className="glass-panel rounded-xl p-8 text-center">
                <p className="text-base font-medium" style={{ color: 'var(--foreground)' }}>
                  Keine offenen Prüfungen für {view.year}.
                </p>
                <p className="mx-auto mt-2 max-w-md text-sm" style={{ color: 'var(--muted)' }}>
                  Jeder Beleg des Jahres ist zugeordnet. Neue Belege erscheinen hier, sobald eine Entscheidung fehlt.
                  {(counts.questions ?? 0) > 0 ? ' Zu Zahlungen gibt es noch Fragen.' : ''}
                </p>
                <div className="mt-4 flex flex-wrap justify-center gap-2">
                  {(counts.questions ?? 0) > 0 && (
                    <button type="button" className="ui-btn ui-btn-primary" onClick={() => setTab('questions')}>
                      Zahlungen klären
                    </button>
                  )}
                  <button type="button" className={(counts.questions ?? 0) > 0 ? 'ui-btn' : 'ui-btn ui-btn-primary'} onClick={() => setTab('statement')}>
                    Zur EÜR
                  </button>
                </div>
              </div>
              )
            ) : (
              <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,19rem)_minmax(0,1fr)]">
                <nav aria-label="Offene Belege">
                  <p className="mb-2 text-xs" style={{ color: 'var(--muted)' }}>
                    {queue.length === 1 ? 'Noch 1 Beleg offen.' : `Noch ${queue.length} Belege offen.`}
                  </p>
                  <ul className="max-h-[40svh] space-y-1.5 overflow-y-auto pr-1 lg:max-h-[75svh]">
                    {queue.map((item) => {
                      const isSelected = selected?.itemId === item.itemId;
                      return (
                        <li key={item.itemId}>
                          <button
                            type="button"
                            aria-current={isSelected ? 'true' : undefined}
                            onClick={() => {
                              setSelectedId(item.itemId);
                              setError(null);
                            }}
                            className="w-full rounded-lg border px-3 py-2.5 text-left transition-colors duration-150"
                            style={{
                              borderColor: isSelected ? 'rgba(226, 163, 72, 0.55)' : 'var(--border)',
                              background: isSelected ? 'var(--accent-muted)' : 'var(--surface)',
                            }}
                          >
                            <span className="flex items-baseline justify-between gap-2">
                              <span className="truncate text-sm font-medium" style={{ color: 'var(--foreground)' }}>
                                {item.vendor || item.label}
                                {item.lineDescription && item.vendor ? `: ${item.lineDescription}` : ''}
                              </span>
                              <span className="shrink-0 text-sm tabular-nums" style={{ color: 'var(--foreground)' }}>
                                {item.amountCents !== null ? euro(item.amountCents) : ''}
                              </span>
                            </span>
                            <span className="mt-0.5 block text-xs" style={{ color: 'var(--muted)' }}>
                              {dayText(item)} ·{' '}
                              {item.checks
                                .filter((c) => c.blocking && !WORKSPACE_CHECKS.includes(c.kind))
                                .map((c) => CHECK_LABELS[c.kind])
                                .join(', ')}
                            </span>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </nav>
                {selected && (
                  <section aria-label="Beleg entscheiden" className="glass-panel rounded-xl p-4 sm:p-5">
                    <ItemHeader item={selected} />
                    <p className="m-0 mt-1 text-xs">
                      <Link href={receiptHref(selected.rowId)} className="underline" style={{ color: 'var(--dt-text-secondary)' }}>
                        Beleg in der Tabelle öffnen
                      </Link>
                    </p>
                    <OpenItemBody
                      // A fresh form per receipt: nothing typed for one leaks into the next.
                      key={selected.itemId}
                      item={selected}
                      view={view}
                      busy={pending}
                      error={error}
                      onSubmit={(submit) => decide(selected, submit)}
                      onMakeAsset={() => {
                        setAssetFromRow(selected.itemId);
                        setError(null);
                        setTab('assets');
                      }}
                      onSaveLines={(lines, done) => run(() => saveLines(view.year, selected.rowId, lines), `${selected.vendor || selected.label}: Positionen gespeichert.`, done)}
                      onRemoveLines={() => run(() => removeLines(view.year, selected.rowId), `${selected.vendor || selected.label}: Aufteilung aufgehoben.`)}
                    />
                  </section>
                )}
              </div>
            ))}

          {tab === 'statement' && (
            <div className="space-y-6">
              {view.lines.length === 0 ? (
                <div className="glass-panel rounded-xl p-8 text-center text-sm" style={{ color: 'var(--muted)' }}>
                  Für {view.year} ist noch kein Beleg gerechnet.
                  {queue.length > 0 ? ' Offene Belege stehen unter „Offen“.' : ''}
                </div>
              ) : (
                (
                  [
                    { id: 'revenue', form: 'euer', kind: 'revenue', title: 'Anlage EÜR: Betriebseinnahmen', total: view.businessRevenueCents },
                    { id: 'expense', form: 'euer', kind: 'expense', title: 'Anlage EÜR: Betriebsausgaben', total: view.businessExpenseCents },
                    { id: 'employment', form: 'employment', kind: 'expense', title: 'Anlage N: Kosten aus Studium und Anstellung', total: view.employmentCostCents },
                  ] as const
                ).map((group) => {
                  const lines = view.lines.filter((l) => l.form === group.form && l.kind === group.kind);
                  if (lines.length === 0) return null;
                  return (
                    <section key={group.id} className="glass-panel overflow-hidden rounded-xl">
                      <h2 className="px-4 pt-4 text-base font-semibold" style={{ color: 'var(--foreground)' }}>
                        {group.title}
                      </h2>
                      <ul className="mt-2">
                        {lines.map((line) => {
                          const open = openLine === line.key;
                          return (
                            <li key={line.key} className="border-t" style={{ borderColor: 'var(--border)' }}>
                              <button
                                type="button"
                                aria-expanded={open}
                                onClick={() => setOpenLine(open ? null : line.key)}
                                className="flex w-full items-baseline justify-between gap-4 px-4 py-3 text-left"
                              >
                                <span className="text-sm" style={{ color: 'var(--foreground)' }}>
                                  {line.line !== null && (
                                    <span className="mr-2 tabular-nums" style={{ color: 'var(--muted)' }}>
                                      Zeile {line.line}
                                    </span>
                                  )}
                                  {line.label}
                                  {line.entryNote && (
                                    <span className="block text-xs" style={{ color: 'var(--muted)' }}>
                                      {line.entryNote}
                                    </span>
                                  )}
                                  <span className="ml-2 text-xs" style={{ color: 'var(--muted)' }}>
                                    {[
                                      line.itemIds.length === 1 ? '1 Beleg' : line.itemIds.length > 1 ? `${line.itemIds.length} Belege` : '',
                                      line.assetIds.length === 1 ? '1 Anlage' : line.assetIds.length > 1 ? `${line.assetIds.length} Anlagen` : '',
                                    ]
                                      .filter(Boolean)
                                      .join(', ')}
                                  </span>
                                </span>
                                <span className="shrink-0 text-sm font-medium tabular-nums" style={{ color: 'var(--foreground)' }}>
                                  {euro(line.cents)}
                                  {line.nonDeductibleCents > 0 && (
                                    <span className="block text-xs font-normal" style={{ color: 'var(--muted)' }}>
                                      nicht abziehbar {euro(line.nonDeductibleCents)}
                                    </span>
                                  )}
                                </span>
                              </button>
                              {open && (
                                <ul className="pb-2">
                                  {line.assetIds.map((id) => {
                                    const asset = assetsById.get(id);
                                    if (!asset) return null;
                                    const part = asset.parts.filter((p) => p.lineKey === line.key).reduce((s, p) => s + p.cents, 0);
                                    return (
                                      <li key={id} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-t px-4 py-2.5" style={{ borderColor: 'var(--border)' }}>
                                        <span className="text-sm" style={{ color: 'var(--foreground)' }}>
                                          {asset.label}
                                          <span className="ml-2 text-xs" style={{ color: 'var(--muted)' }}>
                                            Anlage{asset.acquisitionDate ? `, angeschafft ${formatDay(asset.acquisitionDate)}` : ''}
                                            {asset.businessShareBp < 10000 ? ` · ${asset.businessShareBp / 100} % betrieblich` : ''}
                                          </span>
                                        </span>
                                        <span className="flex items-baseline gap-3">
                                          <span className="text-sm tabular-nums" style={{ color: 'var(--foreground)' }}>{euro(part)}</span>
                                          <button type="button" className="ui-btn ui-btn-sm" onClick={() => setTab('assets')}>
                                            Anlagen
                                          </button>
                                        </span>
                                      </li>
                                    );
                                  })}
                                  {line.itemIds.map((id) => {
                                    const item = itemsById.get(id);
                                    if (!item) return null;
                                    const part = item.parts.filter((p) => p.lineKey === line.key).reduce((s, p) => s + p.cents, 0);
                                    const editing = editingId === `${line.key}:${id}`;
                                    return (
                                      <li key={id} className="border-t px-4 py-2.5" style={{ borderColor: 'var(--border)' }}>
                                        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                                          <span className="text-sm" style={{ color: 'var(--foreground)' }}>
                                            <Link href={receiptHref(item.rowId)} className="hover:underline" title="Beleg in der Tabelle öffnen">
                                              {item.vendor || item.label}
                                            </Link>
                                            {item.lineDescription && item.vendor ? `: ${item.lineDescription}` : ''}
                                            <span className="ml-2 text-xs" style={{ color: 'var(--muted)' }}>
                                              {dayText(item)} · {allocationText(item)}
                                              {item.allocationOrigin ? ` (${ORIGIN_LABELS[item.allocationOrigin]})` : ''}
                                              {item.checks.some((c) => c.kind === 'amount_estimated') ? ' · Betrag geschätzt' : ''}
                                            </span>
                                          </span>
                                          <span className="flex items-baseline gap-3">
                                            <span className="text-sm tabular-nums" style={{ color: 'var(--foreground)' }}>
                                              {euro(part)}
                                              {item.amountCents !== null && part !== item.amountCents && (
                                                <span className="ml-1 text-xs" style={{ color: 'var(--muted)' }}>
                                                  von {euro(item.amountCents)}
                                                </span>
                                              )}
                                            </span>
                                            {item.isMeal ? (
                                              <Link href="/app/meals" className="ui-btn ui-btn-sm">
                                                Verzeichnis
                                              </Link>
                                            ) : (
                                              <button
                                                type="button"
                                                className="ui-btn ui-btn-sm"
                                                aria-expanded={editing}
                                                onClick={() => {
                                                  setEditingId(editing ? null : `${line.key}:${id}`);
                                                  setSplittingId(null);
                                                  setError(null);
                                                }}
                                              >
                                                {editing ? 'Schließen' : 'Ändern'}
                                              </button>
                                            )}
                                          </span>
                                        </div>
                                        {editing && (
                                          <div className="mt-3 rounded-lg border p-3" style={{ borderColor: 'var(--border)' }}>
                                            {splittingId === id ? (
                                              <LinesForm
                                                item={item}
                                                existing={item.receiptLines}
                                                busy={pending}
                                                error={error}
                                                onCancel={() => setSplittingId(null)}
                                                onSubmit={(lines) => run(() => saveLines(view.year, item.rowId, lines), `${item.vendor || item.label}: Positionen gespeichert.`, closeEditing)}
                                                onRemove={item.receiptLines.length > 0 ? () => run(() => removeLines(view.year, item.rowId), `${item.vendor || item.label}: Aufteilung aufgehoben.`, closeEditing) : null}
                                              />
                                            ) : (
                                              <>
                                                <TreatmentForm
                                                  item={item}
                                                  formLines={view.formLines}
                                                  busy={pending}
                                                  error={error}
                                                  submitLabel="Speichern"
                                                  onSubmit={(submit) => decide(item, submit)}
                                                />
                                                <SplitOffer item={item} onSplit={() => setSplittingId(id)} />
                                                <ReverseChargeForm
                                                  key={`${item.itemId}:${item.reverseCharge?.rateBp ?? 'none'}`}
                                                  item={item}
                                                  busy={pending}
                                                  onSubmit={(submit) =>
                                                    run(() => setReverseCharge(view.year, { rowId: item.rowId, ...submit }), `${item.vendor || item.label}: § 13b gespeichert.`)
                                                  }
                                                  onReset={
                                                    item.reverseChargeOwn
                                                      ? () => run(() => resetReverseCharge(view.year, item.rowId), `${item.vendor || item.label}: § 13b-Angabe entfernt.`)
                                                      : null
                                                  }
                                                />
                                              </>
                                            )}
                                            {splittingId !== id && (item.lineId ? item.allocationOrigin === 'line' : item.hasDecision) && (
                                              <button
                                                type="button"
                                                className="ui-btn ui-btn-sm mt-3"
                                                disabled={pending}
                                                onClick={() =>
                                                  run(
                                                    () => (item.lineId ? decideLine(view.year, item.lineId, null) : resetItem(view.year, item.rowId)),
                                                    `${item.vendor || item.label}: Einzelentscheidung entfernt.`,
                                                    () => setEditingId(null),
                                                  )
                                                }
                                              >
                                                Einzelentscheidung entfernen (Regel oder Vorgabe gilt wieder)
                                              </button>
                                            )}
                                          </div>
                                        )}
                                      </li>
                                    );
                                  })}
                                </ul>
                              )}
                            </li>
                          );
                        })}
                        <li className="flex items-baseline justify-between gap-4 border-t px-4 py-3" style={{ borderColor: 'var(--border)' }}>
                          <span className="text-sm font-semibold" style={{ color: 'var(--foreground)' }}>
                            Summe
                          </span>
                          <span className="text-sm font-semibold tabular-nums" style={{ color: 'var(--foreground)' }}>
                            {euro(group.total)}
                          </span>
                        </li>
                      </ul>
                    </section>
                  );
                })
              )}
              <p className="text-xs" style={{ color: 'var(--muted)' }}>
                {(['euer', 'employment'] as const)
                  .map((form) => {
                    const source = view.formSources[form];
                    const name = form === 'euer' ? 'Anlage EÜR' : 'Anlage N';
                    return source
                      ? `${name} nach: ${source.citation}, abgeglichen am ${formatDay(source.checkedOn)}.`
                      : `${name} ${view.year}: noch nicht mit einer amtlichen Quelle abgeglichen.`;
                  })
                  .join(' ')}{' '}
                Regeln zuletzt durchgesehen am {formatDay(view.rulesReviewedOn)}. Beträge sind Berechnungen aus den
                eigenen Belegen und ersetzen keine steuerliche Beratung.
              </p>
            </div>
          )}

          {tab === 'revenue' && (
            <RevenueTab
              view={view}
              busy={pending}
              error={null}
              onSave={(invoiceId, draft, done) => run(() => saveIssuedInvoice(view.year, invoiceId, draft), `Rechnung ${draft.number}: gespeichert.`, done)}
              onDelete={(invoice) => run(() => removeIssuedInvoice(view.year, invoice.id), `Rechnung ${invoice.number}: gelöscht.`)}
              onExpectation={(cents) => run(() => setRevenueExpectation(view.year, cents), 'Erwartung für die Hochrechnung übernommen.')}
            />
          )}

          {(tab === 'questions' || tab === 'payments') && view.payments.yearCount === 0 && (
            <p className="ui-note mb-4 flex flex-wrap items-center justify-between gap-2">
              <span>Konten, Kontoexporte und die Live-Anbindung an Banken stehen unter Einstellungen.</span>
              <button type="button" className="ui-btn ui-btn-sm" onClick={() => setTab('accounts')}>
                Zu den Konten
              </button>
            </p>
          )}
          {(tab === 'questions' || tab === 'payments' || tab === 'accounts') && (
            <PaymentsTab
              // A fresh part per tab: a draft or a check of a form in one part does not show up in another.
              key={tab}
              parts={PAYMENT_PARTS[tab]}
              view={view}
              busy={pending}
              error={error}
              lastImport={lastImport}
              onAddAccount={(input, done) => run(() => addAccount(view.year, input), `Konto ${input.label} angelegt.`, done)}
              onImport={(accountId, file, onlyThisYear, done) => {
                setLastImport(null);
                run(
                  async () => {
                    let result;
                    if ('pdf' in file) {
                      // The PDF travels as it is; the server takes its text.
                      const form = new FormData();
                      form.append('file', file.pdf);
                      result = await importPaymentPdf(view.year, accountId, form, onlyThisYear);
                    } else result = await importPaymentFile(view.year, accountId, file.text, onlyThisYear);
                    if (!result.ok) return result;
                    setLastImport(result.value.imported);
                    return { ok: true, value: result.value.view };
                  },
                  'Datei eingelesen.',
                  done,
                );
              }}
              onUndoImport={(batchId) => {
                setLastImport(null);
                run(() => undoImport(view.year, batchId), 'Import rückgängig gemacht.');
              }}
              onAccountPrivate={(account, isPrivate) =>
                run(
                  () => markAccountPrivate(view.year, account.id, isPrivate),
                  isPrivate ? `${account.label}: als privat vermerkt; nach seinen Zahlungen wird nicht mehr gefragt.` : `${account.label}: wird wieder geprüft.`,
                )
              }
              onRemoveAccount={(account) =>
                run(async () => {
                  const result = await removeAccount(view.year, account.id);
                  // Refused because the account changed meanwhile (a payment, an import or a connection arrived, or it is
                  // gone): the screen shows what it holds now, so the button does not stay where it no longer applies.
                  if (!result.ok && (result.detail === 'account_not_empty' || result.detail === 'account_not_found')) {
                    const fresh = await getStatement(view.year).catch(() => null);
                    if (fresh?.ok) setView(fresh.value);
                  }
                  return result;
                }, `${account.label}: entfernt.`)
              }
              onSearch={(query) => searchPayments(view.year, query)}
              onClassify={() => {
                let outcome = { summary: '', failed: false };
                run(
                  async () => {
                    const result = await classifyCounterpartiesNow(view.year);
                    if (!result.ok) return result;
                    outcome = { summary: result.value.summary, failed: result.value.failed };
                    return { ok: true, value: result.value.view };
                  },
                  'Eingeordnet.',
                  () => {
                    // Nothing decided because the model failed: said as a failure, never as a quiet notice.
                    if (outcome.failed) {
                      setNotice(null);
                      setError(outcome.summary);
                    } else setNotice(outcome.summary);
                  },
                );
              }}
              bank={bankInitial ? { feed: bankFeed, actions: bankActions, returnNotice: bankNotice } : null}
              sharing={
                sharing ? (
                  <AccountSharing initial={sharing} accounts={view.payments.accounts} actions={sharingActions} />
                ) : sharingFailed ? (
                  <section className="glass-panel rounded-xl p-4 sm:p-5" aria-label="Private Zahlungen in einer anderen Firma">
                    <h2 className="text-base font-semibold" style={{ color: 'var(--foreground)' }}>
                      Private Zahlungen in einer anderen Firma
                    </h2>
                    <p className="ui-note ui-note-danger mt-2" role="alert">
                      Die Weitergabe privater Zahlungen konnte nicht geladen werden. Bitte die Seite neu laden.
                    </p>
                  </section>
                ) : null
              }
              onTreat={(counterparty, treatment) => run(() => treatCounterparty(view.year, { counterparty, treatment }), `${counterparty}: ${treatment === null ? 'Antwort zurückgenommen' : 'gespeichert'}.`)}
              onLink={linkWithQuestion}
              onAcceptProposals={(pairs, onlyUnambiguous) => {
                let outcome = { linked: 0, skipped: 0 };
                run(
                  async () => {
                    const result = await acceptPaymentProposals(view.year, pairs, onlyUnambiguous);
                    if (!result.ok) return result;
                    outcome = result.value;
                    return { ok: true, value: result.value.view };
                  },
                  'Vorschläge übernommen.',
                  () =>
                    setNotice(
                      `${outcome.linked === 0 ? 'Nichts zugeordnet' : `${outcome.linked} ${outcome.linked === 1 ? 'Zahlung' : 'Zahlungen'} dem Beleg zugeordnet`}${
                        outcome.skipped > 0 ? `; ${outcome.skipped} ${outcome.skipped === 1 ? 'Vorschlag galt' : 'Vorschläge galten'} nicht mehr und ${outcome.skipped === 1 ? 'blieb' : 'blieben'} unberührt` : ''
                      }. Die Liste zeigt den aktuellen Stand.`,
                    ),
                );
              }}
              onTransfer={(paymentId, isTransfer) =>
                run(
                  () => markPaymentTransfer(view.year, paymentId, isTransfer),
                  isTransfer ? 'Als Übertrag zwischen eigenen Konten vermerkt; nach der Zahlung wird nicht mehr gefragt.' : 'Als eigene Zahlung vermerkt; sie steht wieder bei den offenen Zahlungen oder Gegenseiten.',
                )
              }
              onUnlink={(linkId) => run(() => removePaymentLink(view.year, linkId), 'Zuordnung gelöst.')}
              onNotIncome={(payment) => run(() => correctPaymentKind(view.year, payment.id, 'refund'), 'Als Erstattung oder Umbuchung vermerkt. Unter Auswerten, Zahlungen („Von dir umgewidmete Zahlungen“) lässt sich das zurücksetzen.')}
              onKind={(paymentId, kind) => run(() => correctPaymentKind(view.year, paymentId, kind), kind === null ? 'Zahlung zurückgesetzt.' : 'Zahlung umgewidmet.')}
            />
          )}

          {tab === 'vat' && (
            <VatTab
              view={view}
              busy={pending}
              error={error}
              onStatusChange={(input, done) => run(() => recordStatusChange(view.year, input), 'Statuswechsel eingetragen.', done)}
              onRemoveStatusChange={(changeId) => run(() => removeStatusChange(view.year, changeId), 'Statuswechsel gelöscht.')}
              onSettings={(input) => run(() => setVatSettings(view.year, input), 'Angaben zur Voranmeldung gespeichert.')}
              onSettlement={(input, done) => run(() => recordVatSettlement(view.year, input), 'Zahlung eingetragen.', done)}
              onRemoveSettlement={(settlementId) => run(() => removeVatSettlement(view.year, settlementId), 'Zahlung gelöscht.')}
            />
          )}

          {tab === 'tax' && (
            <IncomeTaxTab
              // A different year starts with fresh forms.
              key={view.year}
              view={view}
              busy={pending}
              error={error}
              onSaveWage={(wageId, draft, done) =>
                run(() => saveWage(view.year, wageId, draft), draft.month === 0 ? 'Lohnsteuerbescheinigung gespeichert.' : `Lohnabrechnung ${draft.employer} gespeichert.`, done, incomeTaxActionMessage)
              }
              onRemoveWage={(entry) => run(() => removeWage(view.year, entry.id), 'Lohnangabe gelöscht.', undefined, incomeTaxActionMessage)}
              onSaveItem={(itemId, draft, done) => run(() => saveTaxReturnItem(view.year, itemId, draft), 'Angabe gespeichert.', done, incomeTaxActionMessage)}
              onRemoveItem={(item) => run(() => removeTaxReturnItem(view.year, item.id), 'Angabe gelöscht.', undefined, incomeTaxActionMessage)}
              onChurchMonths={(months) =>
                run(() => setChurchMonths(view.year, months), months ? 'Monate der Kirchensteuerpflicht gespeichert.' : 'Angabe entfernt.', undefined, incomeTaxActionMessage)
              }
              onFederalState={(state) => run(() => setFederalState(view.year, state), 'Bundesland gespeichert.', undefined, incomeTaxActionMessage)}
              onFiledOn={(filedOn) =>
                run(
                  () => setFiledOn(view.year, filedOn),
                  filedOn ? `Erklärung ${view.year} als abgegeben eingetragen.` : `Abgabedatum ${view.year} entfernt: das Jahr ist wieder offen.`,
                  undefined,
                  incomeTaxActionMessage,
                )
              }
            />
          )}

          {tab === 'assets' && (
            <AssetsTab
              // Coming from the queue with a receipt opens a fresh form for it.
              key={assetFromRow ?? 'assets'}
              view={view}
              busy={pending}
              error={null}
              startFromRowId={assetFromRow}
              onStartHandled={() => setAssetFromRow(null)}
              onSave={saveAssetDraft}
              onDelete={deleteAssetView}
              onDispose={disposeAssetView}
            />
          )}

          {tab === 'vendors' && view.reverseChargeVendors.length > 0 && (
            <section className="glass-panel mb-4 rounded-xl p-4" aria-label="Lieferanten mit § 13b">
              <h2 className="text-sm font-semibold" style={{ color: 'var(--foreground)' }}>
                Steuerschuldnerschaft des Leistungsempfängers (§ 13b Umsatzsteuergesetz)
              </h2>
              <ul className="mt-2 space-y-1.5 text-sm" style={{ color: 'var(--foreground)' }}>
                {view.reverseChargeVendors.map((entry) => (
                  <li key={entry.id} className="flex flex-wrap items-baseline justify-between gap-2">
                    <span>
                      {entry.label || entry.vendorKey}
                      <span className="ml-2 text-xs" style={{ color: 'var(--muted)' }}>
                        {entry.effectiveFrom ? `ab ${formatDay(entry.effectiveFrom)}` : 'von Anfang an'} ·{' '}
                        {entry.rateBp === null ? 'kein § 13b' : `${entry.rateBp / 100} %`}
                      </span>
                    </span>
                    <button
                      type="button"
                      className="ui-btn ui-btn-sm ui-btn-danger"
                      disabled={pending}
                      onClick={() => run(() => removeReverseChargeVendor(view.year, entry.id), `§ 13b-Regel für ${entry.label || entry.vendorKey} gelöscht.`)}
                    >
                      Löschen
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}
          {tab === 'vendors' &&
            (view.vendorRules.length === 0 ? (
              <div className="glass-panel rounded-xl p-8 text-center text-sm" style={{ color: 'var(--muted)' }}>
                Noch keine Zuordnungsregel für einen Lieferanten. Eine Regel entsteht, wenn bei einem Beleg „Für alle Belege
                von … so behandeln“ angehakt wird.
              </div>
            ) : (
              <ul className="glass-panel divide-y rounded-xl" style={{ borderColor: 'var(--border)' }}>
                {view.vendorRules.map((rule) => (
                  <li key={rule.id} className="flex flex-wrap items-baseline justify-between gap-3 px-4 py-3" style={{ borderColor: 'var(--border)' }}>
                    <span className="text-sm" style={{ color: 'var(--foreground)' }}>
                      {rule.vendorLabel}
                      <span className="ml-2 text-xs" style={{ color: 'var(--muted)' }}>
                        {rule.effectiveFrom ? `ab ${formatDay(rule.effectiveFrom)}` : 'von Anfang an'} ·{' '}
                        {rule.allocations.map((a) => `${a.shareBp / 100} % ${PURPOSE_LABELS[a.purpose]}`).join(' + ')}
                        {rule.formLineKey ? ` · ${view.formLines.find((l) => l.key === rule.formLineKey)?.label ?? rule.formLineKey}` : ''}
                      </span>
                    </span>
                    <button
                      type="button"
                      className="ui-btn ui-btn-sm ui-btn-danger"
                      disabled={pending}
                      onClick={() => {
                        if (!window.confirm(`Regel für ${rule.vendorLabel} löschen? Belege ohne Einzelentscheidung fallen auf die Vorgaben zurück.`)) return;
                        run(() => removeVendorRule(view.year, rule.id), `Regel für ${rule.vendorLabel} gelöscht.`);
                      }}
                    >
                      Löschen
                    </button>
                  </li>
                ))}
              </ul>
            ))}

          {tab === 'names' &&
            (ownNames ? (
              <OwnNames open names={ownNames.names} canWrite={ownNames.canWrite} pending={pending} error={namesError} notice={namesNotice} onChange={changeNames} />
            ) : (
              <p className="ui-note ui-note-danger" role="alert">
                Die eigenen Namen konnten nicht geladen werden. Bitte die Seite neu laden; sie stehen auch unter{' '}
                <Link href="/app/spending" className="underline">
                  Ausgaben
                </Link>
                .
              </p>
            ))}
        </div>
        </div>
      </div>
    </main>
  );
}

/**
 * The arrow keys of a tab row (the ARIA tabs pattern): left and right move to
 * the neighbouring tab, wrapping around, Home and End to the first and last;
 * the tab is chosen and takes the focus. Only the chosen tab is in the Tab
 * order, so Tab leaves the row.
 */
function arrowTo<K extends string>(event: KeyboardEvent<HTMLButtonElement>, keys: readonly K[], current: K, idPrefix: string, choose: (key: K) => void) {
  const at = keys.indexOf(current);
  const target =
    event.key === 'ArrowRight' ? keys[(at + 1) % keys.length]
    : event.key === 'ArrowLeft' ? keys[(at - 1 + keys.length) % keys.length]
    : event.key === 'Home' ? keys[0]
    : event.key === 'End' ? keys[keys.length - 1]
    : null;
  if (target === null) return;
  event.preventDefault();
  choose(target);
  // Drawn after the choice; the button exists already in the same row.
  document.getElementById(`${idPrefix}${target}`)?.focus();
}

function ItemHeader({ item }: { item: StatementItem }) {
  return (
    <>
      <h2 className="text-base font-semibold" style={{ color: 'var(--foreground)' }}>
        {item.label}
      </h2>
      <p className="mb-4 mt-1 text-xs" style={{ color: 'var(--muted)' }}>
        {item.vendor ? `${item.vendor} · ` : ''}
        {dayText(item)}
        {item.amountCents !== null ? ` · ${euro(item.amountCents)}` : ''}
        {item.currency !== 'EUR' && item.gross !== null ? ` (${item.gross.toFixed(2).replace('.', ',')} ${item.currency})` : ''}
        {item.category ? ` · ${item.category}` : ''}
      </p>
    </>
  );
}

/** The day an item counts on; for one the ten-day rule moved, the day it was really paid and the year it counts in. */
function dayText(item: StatementItem): string {
  if (item.paidOn && item.date) return `gezahlt ${formatDay(item.paidOn)}, zählt für ${item.date.slice(0, 4)} (Jahreswechsel)`;
  return formatDay(item.date);
}

/** The way into splitting a receipt, or into changing its split, under a treatment form. */
function SplitOffer({ item, onSplit }: { item: StatementItem; onSplit: () => void }) {
  if (item.receiptGrossCents === null) return null;
  // A credit note is treated as a whole: it is not split into positions. (A
  // credit note with old lines comes back as one item whose lines do not add
  // up; that case is handled where the mismatch is.)
  if (item.receiptGrossCents < 0) return null;
  return (
    <p className="mt-3 text-xs" style={{ color: 'var(--muted)' }}>
      {item.lineId
        ? 'Diese Position gehört zu einem aufgeteilten Beleg.'
        : 'Enthält der Beleg Positionen, die unterschiedlich zu behandeln sind (zum Beispiel eine betrieblich, eine privat)?'}{' '}
      <button type="button" className="underline underline-offset-2" style={{ color: 'var(--accent)' }} onClick={onSplit}>
        {item.lineId ? 'Aufteilung ändern' : 'In Positionen aufteilen'}
      </button>
    </p>
  );
}

function OpenItemBody({
  item,
  view,
  busy,
  error,
  onSubmit,
  onMakeAsset,
  onSaveLines,
  onRemoveLines,
}: {
  item: StatementItem;
  view: StatementView;
  busy: boolean;
  error: string | null;
  onSubmit: (submit: TreatmentSubmit) => void;
  onMakeAsset: () => void;
  onSaveLines: (lines: LineDraft[], done: () => void) => void;
  onRemoveLines: () => void;
}) {
  const [splitting, setSplitting] = useState(false);
  const blocking = item.checks.filter((c) => c.blocking).map((c) => c.kind);
  const mismatch = blocking.includes('lines_do_not_sum');
  if (blocking.some((k) => MEAL_CHECKS.includes(k))) {
    return (
      <div className="space-y-3">
        <p className="ui-note ui-note-warn">
          Diese Bewirtung zählt erst, wenn Teilnehmer, Anlass und Ort erfasst sind. Das geschieht im
          Bewirtungsverzeichnis; der abziehbare Betrag (70 %) kommt dann von dort.
        </p>
        <Link href="/app/meals" className="ui-btn ui-btn-primary">
          Im Bewirtungsverzeichnis ergänzen
        </Link>
      </div>
    );
  }
  if (mismatch || splitting) {
    return (
      <div className="space-y-3">
        {mismatch && (
          <p className="ui-note ui-note-warn">
            Dieser Beleg wurde in Positionen aufgeteilt, die nicht mehr seinen Betrag ergeben (der Belegbetrag wurde
            wohl nachträglich geändert). Bis das stimmt, wird nichts davon gerechnet.
          </p>
        )}
        <LinesForm
          item={item}
          existing={item.receiptLines}
          busy={busy}
          error={error}
          onCancel={mismatch ? null : () => setSplitting(false)}
          onSubmit={(lines) => onSaveLines(lines, () => setSplitting(false))}
          onRemove={item.receiptLines.length > 0 ? onRemoveLines : null}
        />
      </div>
    );
  }
  const onReceipt = blocking.filter((k) => RECEIPT_CHECKS.includes(k));
  const assetCheck = blocking.find((k) => ASSET_CHECKS.includes(k));
  const limit = `${formatCents(view.assetLimits.lowValueNetLimitCents)} €`;
  return (
    <div className="space-y-4">
      {assetCheck && (
        <div className="ui-note ui-note-warn">
          <p>
            {assetCheck === 'needs_asset'
              ? `Dieser Beleg steht auf der Zeile für geringwertige Wirtschaftsgüter, kostet aber mehr als ${limit} netto. Er kann nicht sofort abgezogen werden, sondern wird als Anlage über die Nutzungsdauer abgeschrieben (Computerhardware: im Jahr der Anschaffung).`
              : `Dieser Beleg liegt nahe an der Grenze von ${limit} netto, und der Nettobetrag fehlt. Entweder den Nettobetrag im Dashboard am Beleg ergänzen oder den Beleg als Anlage führen.`}
          </p>
          <button type="button" className="ui-btn ui-btn-primary ui-btn-sm mt-2" onClick={onMakeAsset}>
            Als Anlage führen
          </button>
          <p className="mt-2 text-xs" style={{ color: 'var(--muted)' }}>
            Ist es kein Wirtschaftsgut (zum Beispiel eine Sammelrechnung über mehrere kleine Teile), unten eine andere
            Zeile wählen.
          </p>
        </div>
      )}
      {onReceipt.length > 0 && (
        <div className="ui-note ui-note-warn">
          <p>
            Am Beleg selbst fehlt etwas: {onReceipt.map((k) => CHECK_LABELS[k]).join(', ')}. Das wird im Dashboard am
            Beleg ergänzt; ohne diese Angabe kann er keinem Jahr und keiner Zeile zugerechnet werden.
          </p>
          <Link href="/app/dashboard" className="ui-btn ui-btn-sm mt-2">
            Zum Dashboard
          </Link>
        </div>
      )}
      <TreatmentForm item={item} formLines={view.formLines} busy={busy} error={error} submitLabel="Speichern und weiter" onSubmit={onSubmit} />
      <SplitOffer item={item} onSplit={() => setSplitting(true)} />
    </div>
  );
}
