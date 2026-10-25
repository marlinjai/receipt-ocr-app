'use client';

import { useId, useState, useTransition, type ReactNode } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { formatDay } from '@/lib/meals/messages';
import { formatCents } from '@/lib/tax/money';
import { ANSWERABLE_CATEGORIES, SPENDING_CATEGORY_LABELS, isSpendingCategory, type SpendingCategory } from '@/lib/spending/categories';
import type { CategoryBasis, SpendingPurpose } from '@/lib/spending/rules';
import type { UnclearCounterparty } from '@/lib/spending/overview';
import { monthStacks, monthlyBudgetSum, topCounterparties } from '@/lib/spending/charts';
import { MAX_OWN_NAMES, MAX_OWN_NAME_LENGTH } from '@/lib/spending/own-names';
import { spendingHref, type SpendingTab } from '@/lib/spending/paths';
import { answerCategory, markOwnAccount, saveOwnNames, unlinkRoutedReceipt, unmarkOwnAccount, withdrawCategory, type Result, type SpendingPageView } from './actions';
import { MonthsChart, TopCounterpartiesChart } from './OverviewCharts';
import BudgetsPanel from './BudgetsPanel';
import type { BudgetsView } from './budget-actions';

const MONTHS = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];

/** The payment services whose collections can wait for their next list. */
const SERVICE_LABELS: Record<string, string> = { klarna: 'Klarna', paypal: 'PayPal' };

const PURPOSE_LABELS: Record<SpendingPurpose, string> = {
  private: 'Privat',
  business: 'Geschäftlich',
  unanswered: 'Nicht zugeordnet',
};

const BASIS_LABELS: Record<CategoryBasis, string> = {
  own_account: 'eigenes Konto',
  answer: 'von dir zugeordnet',
  kind: 'aus der Zahlungsart',
  keyword: 'aus Name oder Verwendungszweck',
  app: 'von der App eingeordnet',
  none: 'nicht erkannt',
};

function euro(cents: number): string {
  return `${formatCents(cents)} €`;
}

/** What went wrong, in words a person can act on. */
export function spendingActionMessage(result: Extract<Result<unknown>, { ok: false }>): string {
  if (result.error === 'unauthorized') return 'Die Anmeldung ist abgelaufen. Bitte die Seite neu laden und neu anmelden.';
  if (result.error === 'forbidden') return 'Für diesen Arbeitsbereich fehlt die Berechtigung zum Ändern.';
  if (result.detail === 'counterparty_required') return 'Diese Zahlung nennt keine Gegenseite, deshalb lässt sich keine Kategorie für sie merken.';
  if (result.detail === 'invalid_category') return 'Diese Kategorie gibt es nicht. Bitte eine aus der Liste wählen.';
  if (result.detail === 'treatment_exists')
    return 'Diese Gegenseite ist unter Finanzen (Auswerten, Zahlungen) schon als geschäftlich oder privat beantwortet. Das bitte dort ändern, damit die steuerliche Zuordnung nicht unbemerkt verloren geht.';
  if (result.detail === 'invalid_treatment') return 'Diese Gegenseite lässt sich nicht als eigenes Konto merken, weil die Zahlung keinen Namen nennt.';
  if (result.detail === 'not_own_account') return 'Diese Gegenseite ist nicht mehr als eigenes Konto beantwortet. Bitte die Seite neu laden.';
  if (result.detail === 'link_not_found') return 'An dieser Zahlung hängt hier kein Beleg mehr. Bitte die Seite neu laden.';
  if (result.detail === 'invalid_names') return 'Ein Name braucht mindestens zwei Buchstaben oder Ziffern, zum Beispiel Vor- und Nachname.';
  if (result.detail === 'name_too_long') return `Ein Name darf höchstens ${MAX_OWN_NAME_LENGTH} Zeichen lang sein.`;
  if (result.detail === 'too_many_names') return `Es lassen sich höchstens ${MAX_OWN_NAMES} eigene Namen merken.`;
  if (result.detail === 'name_listed') return 'Dieser Name steht schon in der Liste, vielleicht in einer anderen Schreibweise.';
  if (result.detail === 'name_not_listed') return 'Dieser Name steht nicht mehr in der Liste, vielleicht wurde er auf einer anderen Seite entfernt. Bitte die Seite neu laden.';
  return 'Das hat nicht geklappt. Bitte noch einmal versuchen; wenn es wieder scheitert, die Seite neu laden.';
}

/** The choice in an unclear row: a category, or "this is an own account". */
const OWN_ACCOUNT = 'own_account';

/**
 * One unclear counterparty with its own choice and button: choosing in the
 * list does not save (arrow keys on a closed list change the value in some
 * browsers), the button does. An error shows in the row it belongs to.
 */
function UnclearRow({
  entry,
  canWrite,
  pending,
  error,
  onAssign,
}: {
  entry: UnclearCounterparty;
  canWrite: boolean;
  pending: boolean;
  error: string | null;
  onAssign: (choice: string) => void;
}) {
  const id = useId();
  const [choice, setChoice] = useState('');
  return (
    <li className="py-2 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span style={{ color: 'var(--foreground)' }}>
          {entry.counterparty || 'ohne Namen'}
          <span className="ml-2 text-xs" style={{ color: 'var(--muted)' }}>
            {entry.count} {entry.count === 1 ? 'Zahlung' : 'Zahlungen'}, zuletzt {formatDay(entry.lastDay)}
          </span>
        </span>
        <span className="flex flex-wrap items-center gap-2">
          <span className="tabular-nums">{euro(entry.cents)}</span>
          {!entry.counterpartyKey ? (
            <span className="text-xs" style={{ color: 'var(--muted)' }}>
              ohne Gegenseite, keine Zuordnung möglich
            </span>
          ) : canWrite ? (
            <>
              <label className="sr-only" htmlFor={`${id}-choice`}>
                Kategorie für {entry.counterparty}
              </label>
              <select id={`${id}-choice`} className="ui-input" style={{ width: 'auto' }} value={choice} disabled={pending} onChange={(e) => setChoice(e.target.value)}>
                <option value="">Kategorie wählen</option>
                {ANSWERABLE_CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {SPENDING_CATEGORY_LABELS[c]}
                  </option>
                ))}
                <option value={OWN_ACCOUNT}>Eigenes Konto (keine Ausgabe)</option>
              </select>
              <button
                type="button"
                className="ui-btn ui-btn-sm"
                disabled={pending || !choice}
                aria-label={`Kategorie für ${entry.counterparty} zuordnen`}
                onClick={() => onAssign(choice)}
              >
                Zuordnen
              </button>
            </>
          ) : null}
        </span>
      </div>
      {error && (
        <p className="ui-note ui-note-danger mt-2" role="alert">
          {error}
        </p>
      )}
    </li>
  );
}

/**
 * The owner's own names: money to or from a counterparty carrying one of them
 * is an own transfer. While the list is empty it asks for a name up front
 * (the sign-in tells the app no name to start from); afterwards it is a quiet
 * list to change.
 */
function OwnNames({
  names,
  canWrite,
  pending,
  error,
  notice,
  onChange,
}: {
  names: readonly string[];
  canWrite: boolean;
  pending: boolean;
  error: string | null;
  /** What the last change did, for the status line. */
  notice: string | null;
  /** Add or take out one name; resolves true when the server took it. */
  onChange: (change: { add: string } | { remove: string }) => Promise<boolean>;
}) {
  const id = useId();
  const [draft, setDraft] = useState('');
  const explanation = (
    <p className="mt-1 text-xs" style={{ color: 'var(--muted)' }}>
      Zahlungen an oder von diesen Namen sind Umbuchungen zwischen eigenen Konten: keine Ausgabe, kein Beleg nötig, keine Benachrichtigung. Groß- und
      Kleinschreibung, Akzente, Satzzeichen und die Reihenfolge der Wörter zählen nicht; Rechtsformen wie UG oder GmbH schon. Eine Antwort zu einer
      Gegenseite unter Finanzen als geschäftlich oder gemischt geht vor; „privat“ dort (eine Privatentnahme) bleibt für die Ausgaben eine Umbuchung.
    </p>
  );
  const editor = canWrite && (
    <>
      {names.length > 0 && (
        <ul className="mt-2 flex flex-wrap gap-2">
          {names.map((n) => (
            <li key={n} className="inline-flex items-center gap-1 rounded-full border py-0.5 pr-0.5 pl-2.5 text-sm" style={{ borderColor: 'var(--border)' }}>
              {n}
              <button type="button" className="ui-btn ui-btn-sm ui-btn-ghost" disabled={pending} aria-label={`${n} aus den eigenen Namen entfernen`} onClick={() => void onChange({ remove: n })}>
                Entfernen
              </button>
            </li>
          ))}
        </ul>
      )}
      <form
        className="mt-2 flex flex-wrap items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          const name = draft.trim();
          // A saved name leaves the field; a refused one stays there to be corrected.
          if (name) void onChange({ add: name }).then((saved) => saved && setDraft(''));
        }}
      >
        <label className="sr-only" htmlFor={`${id}-name`}>
          Eigener Name, wie die Bank ihn schreibt
        </label>
        <input
          id={`${id}-name`}
          className="ui-input"
          style={{ width: 'auto', minWidth: '12rem', flex: '1 1 14rem' }}
          placeholder="Vor- und Nachname, wie auf dem Kontoauszug"
          value={draft}
          maxLength={MAX_OWN_NAME_LENGTH}
          disabled={pending}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${id}-error` : undefined}
          onChange={(e) => setDraft(e.target.value)}
        />
        <button type="submit" className="ui-btn ui-btn-primary ui-btn-sm" disabled={pending || !draft.trim()} aria-label="Eigenen Namen hinzufügen">
          Hinzufügen
        </button>
      </form>
      {error && (
        <p id={`${id}-error`} className="ui-note ui-note-danger mt-2" role="alert">
          {error}
        </p>
      )}
    </>
  );
  // Always rendered, so a screen reader announces what a change did.
  const status = (
    <p className={notice ? 'ui-note ui-note-ok mt-2' : 'sr-only'} role="status">
      {notice ?? ''}
    </p>
  );
  if (names.length === 0) {
    return (
      <section className="ui-note ui-note-warn mt-4" aria-labelledby={`${id}-title`}>
        <h2 id={`${id}-title`} className="text-sm font-semibold">
          Eigene Namen
        </h2>
        <p className="mt-1 text-sm">
          Noch kein eigener Name hinterlegt. Überweisungen an sich selbst (eigene Spaces, Tagesgeld, ein anderes eigenes Konto) zählen deshalb als Ausgabe und
          fragen nach einem Beleg.
          {canWrite
            ? ' Trag deinen Namen so ein, wie die Bank ihn schreibt; mehrere Schreibweisen sind möglich.'
            : ' Eintragen kann ihn, wer in diesem Arbeitsbereich ändern darf.'}
        </p>
        {explanation}
        {editor}
        {status}
      </section>
    );
  }
  return (
    <details className="glass-panel ui-disclosure mt-4 rounded-xl p-4">
      <summary className="cursor-pointer text-sm font-semibold" style={{ color: 'var(--foreground)' }}>
        Eigene Namen ({names.length})
      </summary>
      {explanation}
      {canWrite ? editor : <p className="mt-2 text-sm">{names.join(', ')}</p>}
      {status}
    </details>
  );
}

export default function SpendingClient({
  initial,
  tab = 'ueberblick',
  openChecks = null,
  checks,
  budgets,
  today,
}: {
  initial: SpendingPageView;
  tab?: SpendingTab;
  /** Payments waiting for a receipt, for the count on the tab; null when the checks could not be read. */
  openChecks?: number | null;
  /** The receipt checks and the notifications: the "Belege" tab. */
  checks?: ReactNode;
  /** The budgets of this month, for the budget block; null when they could not be read. */
  budgets?: BudgetsView | null;
  /** Today in the owner's time zone, "YYYY-MM-DD". */
  today: string;
}) {

  const id = useId();
  const router = useRouter();
  const [view, setView] = useState(initial);
  // An error belongs to the place it happened: a row of the unclear list, an answer, or the page.
  const [error, setError] = useState<{ at: string; message: string } | null>(null);
  // The page reads the overview afresh after a change in the checks below (a receipt linked by hand): take that
  // over, and drop errors that told the person to reload.
  const [shownInitial, setShownInitial] = useState(initial);
  if (shownInitial !== initial) {
    setShownInitial(initial);
    setView(initial);
    setError(null);
  }
  const [pending, startTransition] = useTransition();
  const { overview } = view;
  const period = overview.month === null ? `${overview.year}` : `${MONTHS[overview.month - 1]} ${overview.year}`;

  // The period and the tab live in the address, so a reload or a shared link shows the same.
  const go = (year: number, month: number | null) => {
    router.push(spendingHref(year, month, tab), { scroll: false });
  };
  const showTab = (next: SpendingTab) => {
    if (next !== tab) router.push(spendingHref(overview.year, overview.month, next), { scroll: false });
  };
  const tabs: Array<{ key: SpendingTab; label: string; count: number | null }> = [
    { key: 'ueberblick', label: 'Überblick', count: null },
    { key: 'belege', label: 'Belege', count: openChecks },
  ];

  const run = (at: string, action: () => Promise<Result<SpendingPageView>>) => {
    setError(null);
    startTransition(async () => {
      const result = await action();
      if (result.ok) {
        setView(result.value);
        // The open checks and the budgets below read the same payments: the page reads them afresh.
        router.refresh();
      } else setError({ at, message: spendingActionMessage(result) });
    });
  };

  const [namesNotice, setNamesNotice] = useState<string | null>(null);
  const changeOwnNames = (change: { add: string } | { remove: string }) =>
    new Promise<boolean>((resolve) => {
      setError(null);
      setNamesNotice(null);
      startTransition(async () => {
        const result = await saveOwnNames(overview.year, overview.month, change);
        if (result.ok) {
          setView(result.value);
          const { settledOwnName } = result.value;
          setNamesNotice(
            'add' in change
              ? `${change.add} gespeichert.${settledOwnName > 0 ? ` ${settledOwnName} ${settledOwnName === 1 ? 'Benachrichtigung' : 'Benachrichtigungen'} erledigt: eigenes Konto.` : ''}`
              : `${change.remove} entfernt. Zahlungen an diesen Namen zählen wieder als Ausgabe.`,
          );
          // The open checks and the budgets read the same payments: the page reads them afresh.
          router.refresh();
        } else setError({ at: 'names', message: spendingActionMessage(result) });
        resolve(result.ok);
      });
    });

  const assign = (entry: UnclearCounterparty, choice: string) => {
    const at = `unclear:${entry.counterpartyKey}`;
    if (choice === OWN_ACCOUNT) run(at, () => markOwnAccount(overview.year, overview.month, entry.counterparty));
    else if (isSpendingCategory(choice)) run(at, () => answerCategory(overview.year, overview.month, entry.counterparty, choice as SpendingCategory));
  };

  return (
    <main className="relative z-10 mx-auto w-full max-w-5xl px-4 py-6 sm:px-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold" style={{ color: 'var(--foreground)' }}>
            Ausgaben
          </h1>
          <p className="mt-1 text-sm" style={{ color: 'var(--muted)' }}>
            Wohin das Geld geht, aus den Zahlungen dieses Arbeitsbereichs.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <label className="sr-only" htmlFor={`${id}-year`}>
            Jahr
          </label>
          <select id={`${id}-year`} className="ui-input" style={{ width: 'auto' }} value={overview.year} onChange={(e) => go(Number(e.target.value), overview.month)}>
            {view.years.map((y) => (
              <option key={y} value={y}>
                {y}
              </option>
            ))}
          </select>
          <label className="sr-only" htmlFor={`${id}-month`}>
            Monat
          </label>
          <select
            id={`${id}-month`}
            className="ui-input"
            style={{ width: 'auto' }}
            value={overview.month ?? ''}
            onChange={(e) => go(overview.year, e.target.value ? Number(e.target.value) : null)}
          >
            <option value="">Ganzes Jahr</option>
            {MONTHS.map((m, i) => (
              <option key={m} value={i + 1}>
                {m}
              </option>
            ))}
          </select>
          <Link href="/app/finance" className="ui-btn">
            Finanzen
          </Link>
          <Link href="/app/dashboard" className="ui-btn">
            Dashboard
          </Link>
        </div>
      </div>

      <div className="mt-4 space-y-2" aria-live="polite">
        {view.noPayments && (
          <p className="ui-note ui-note-warn">
            In diesem Arbeitsbereich sind noch keine Zahlungen. Sie kommen aus den Kontoauszügen, die unter{' '}
            <Link href="/app/finance?reiter=konten" className="underline">
              Finanzen, Einstellungen, Konten
            </Link>{' '}
            eingelesen werden.
          </p>
        )}
        {view.accounts.length > 0 && (
          <p className="text-xs" style={{ color: 'var(--muted)' }}>
            Stand der Konten:{' '}
            {view.accounts.map((a, i) => (
              <span key={a.id}>
                {i > 0 && ', '}
                {a.label}
                {a.sharedFrom && ` (private Zahlungen, geführt von ${view.companies[a.sharedFrom] ?? 'einer anderen Firma'})`} bis {formatDay(a.completeThrough)}
              </span>
            ))}
          </p>
        )}
        {view.sharedOut.length > 0 && (
          <p className="ui-note">
            Private Zahlungen von{' '}
            {view.sharedOut.map((s, i) => (
              <span key={`${s.accountLabel}-${s.receiverWorkspaceId}`}>
                {i > 0 && ', '}
                {s.accountLabel} (an {view.companies[s.receiverWorkspaceId] ?? 'eine andere Firma'})
              </span>
            ))}{' '}
            stehen in der Firma, an die sie weitergegeben werden, mit Budgets und fehlenden Belegen. Hier bleiben von diesen Konten die
            geschäftlichen, die noch nicht beantworteten und die hier verknüpften Zahlungen und die Umbuchungen.
          </p>
        )}
      </div>

      <div role="tablist" aria-label="Bereiche der Ausgaben" className="ui-scroll-bare mt-4 flex gap-1 overflow-x-auto overflow-y-hidden border-b" style={{ borderColor: 'var(--border)' }}>
        {tabs.map((t) => (
          <button
            key={t.key}
            role="tab"
            type="button"
            id={`${id}-tab-${t.key}`}
            aria-selected={tab === t.key}
            // Only the open tab's panel is on the page.
            aria-controls={tab === t.key ? `${id}-panel-${t.key}` : undefined}
            tabIndex={tab === t.key ? 0 : -1}
            onClick={() => showTab(t.key)}
            onKeyDown={(e) => {
              // The tabs pattern: arrow keys, Home and End move between the tabs.
              const at = tabs.findIndex((x) => x.key === t.key);
              const next = e.key === 'ArrowRight' ? (at + 1) % tabs.length : e.key === 'ArrowLeft' ? (at - 1 + tabs.length) % tabs.length : e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : -1;
              if (next < 0) return;
              e.preventDefault();
              document.getElementById(`${id}-tab-${tabs[next].key}`)?.focus();
              showTab(tabs[next].key);
            }}
            className="ui-tab -mb-px shrink-0 border-b-2 px-3 py-2.5 text-sm font-medium"
            style={{ borderColor: tab === t.key ? 'var(--accent)' : 'transparent', color: tab === t.key ? 'var(--accent)' : 'var(--muted)' }}
          >
            {t.label}
            {t.count !== null && (
              <span className="ml-2 rounded-full px-1.5 py-0.5 text-xs tabular-nums" style={{ background: 'rgba(255,255,255,0.07)', color: 'var(--foreground)' }}>
                {t.count}
                <span className="sr-only"> offen</span>
              </span>
            )}
          </button>
        ))}
      </div>

      {tab === 'belege' ? (
        <div role="tabpanel" id={`${id}-panel-belege`} aria-labelledby={`${id}-tab-belege`}>
          {checks}
        </div>
      ) : (
        <div role="tabpanel" id={`${id}-panel-ueberblick`} aria-labelledby={`${id}-tab-ueberblick`}>
          <section className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4" aria-label={`Summen ${period}`}>
            <div className="glass-panel rounded-xl p-4">
              <p className="text-xs" style={{ color: 'var(--muted)' }}>
                Ausgaben {period}
              </p>
              <p className="mt-1 text-xl font-semibold tabular-nums" style={{ color: 'var(--foreground)' }}>
                {euro(overview.totalCents)}
              </p>
            </div>
            {(['private', 'business', 'unanswered'] as const).map((purpose) => (
              <div key={purpose} className="glass-panel rounded-xl p-4">
                <p className="text-xs" style={{ color: 'var(--muted)' }}>
                  {PURPOSE_LABELS[purpose]}
                </p>
                <p className="mt-1 text-lg font-semibold tabular-nums" style={{ color: 'var(--foreground)' }}>
                  {euro(overview.split[purpose])}
                </p>
              </div>
            ))}
          </section>
          {overview.split.unanswered !== 0 && (
            <p className="mt-2 text-xs" style={{ color: 'var(--muted)' }}>
              „Nicht zugeordnet“ heißt: für die Gegenseite ist noch nicht gesagt, ob sie privat oder geschäftlich ist. Das wird unter Finanzen,
              Zahlungen einmal pro Gegenseite beantwortet.
            </p>
          )}
          {overview.ownTransfers.count > 0 && (
            <p className="mt-1 text-xs" style={{ color: 'var(--muted)' }}>
              Nicht mitgezählt: {overview.ownTransfers.count} Umbuchungen zwischen eigenen Konten über {euro(overview.ownTransfers.cents)}
              {overview.ownTransfers.byName.count > 0 && `, davon ${overview.ownTransfers.byName.count} an eigene Namen über ${euro(overview.ownTransfers.byName.cents)}`}.
            </p>
          )}
          {overview.waitingDebits.map((w) => {
            const name = SERVICE_LABELS[w.service] ?? w.service;
            return (
              <p key={w.service} className="mt-1 text-xs" style={{ color: 'var(--muted)' }}>
                Nicht mitgezählt: {w.count === 1 ? `1 ${name}-Sammelzahlung` : `${w.count} ${name}-Sammelzahlungen`} über {euro(w.cents)}{' '}
                {w.count === 1 ? 'wartet' : 'warten'} auf die nächste {name}-Liste. Mit der Liste zählen die Käufe darin.
              </p>
            );
          })}

          <OwnNames
            names={view.ownNames}
            canWrite={view.canWrite}
            pending={pending}
            error={error?.at === 'names' ? error.message : null}
            notice={namesNotice}
            onChange={changeOwnNames}
          />

          <MonthsChart
            year={overview.year}
            stacks={monthStacks(overview)}
            budgetSum={budgets ? monthlyBudgetSum(budgets.lines) : null}
            selectedMonth={overview.month}
            onSelect={(month) => go(overview.year, month)}
          />
          {budgets === null ? (
            <p className="ui-note ui-note-danger mt-4">Die Budgets konnten nicht geladen werden. Bitte die Seite neu laden.</p>
          ) : (
            budgets && <BudgetsPanel initial={budgets} overview={overview} today={today} period={period} />
          )}
          <TopCounterpartiesChart items={topCounterparties(overview.payments, overview.totalCents)} period={period} />

          <section className="glass-panel mt-4 rounded-xl p-4" aria-labelledby={`${id}-unclear`}>
            <h2 id={`${id}-unclear`} className="text-sm font-semibold" style={{ color: 'var(--foreground)' }}>
              Unklar {period}
            </h2>
            {overview.unclear.length === 0 ? (
              <p className="mt-2 text-sm" style={{ color: 'var(--muted)' }}>
                Alle Ausgaben dieses Zeitraums haben eine Kategorie.
              </p>
            ) : (
              <>
                <p className="mt-1 text-xs" style={{ color: 'var(--muted)' }}>
                  Eine Kategorie gilt für alle Zahlungen der Gegenseite, auch für künftige.
                  {!view.canWrite && ' Zum Zuordnen fehlt in diesem Arbeitsbereich die Berechtigung.'}
                </p>
                <ul className="mt-3 divide-y" style={{ borderColor: 'var(--border, rgba(128,128,128,0.2))' }}>
                  {overview.unclear.map((u) => (
                    <UnclearRow
                      key={u.counterpartyKey || `${u.counterparty}-${u.lastDay}`}
                      entry={u}
                      canWrite={view.canWrite}
                      pending={pending}
                      error={error?.at === `unclear:${u.counterpartyKey}` ? error.message : null}
                      onAssign={(choice) => assign(u, choice)}
                    />
                  ))}
                </ul>
                <p className="mt-2 text-xs" style={{ color: 'var(--muted)' }}>
                  Eine Abbuchung, die nur eine eigene Kreditkarte oder ein eigenes Konto ausgleicht, ist keine Ausgabe: dafür „Eigenes Konto“
                  wählen. Das gilt dann auch unter{' '}
                  <Link href="/app/finance?reiter=zahlungsliste" className="underline">
                    Finanzen, Auswerten, Zahlungen
                  </Link>
                  .
                </p>
              </>
            )}
          </section>

          {view.ownAccounts.length > 0 && (
            <details className="glass-panel ui-disclosure mt-4 rounded-xl p-4">
              <summary className="cursor-pointer text-sm font-semibold" style={{ color: 'var(--foreground)' }}>
                Eigene Konten ({view.ownAccounts.length})
              </summary>
              <p className="mt-2 text-xs" style={{ color: 'var(--muted)' }}>
                Zahlungen an diese Gegenseiten zählen nicht als Ausgabe. Dieselbe Antwort steht unter Finanzen, Auswerten, Zahlungen; was über die eigenen Namen
                dazukommt, ändert sich mit den Namen.
              </p>
              <ul className="mt-2 divide-y">
                {view.ownAccounts.map((o) => (
                  <li key={o.counterpartyKey} className="py-2 text-sm">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span>
                        {o.label}
                        {o.byName && (
                          <span className="ml-2 text-xs" style={{ color: 'var(--muted)' }}>
                            über Eigene Namen
                          </span>
                        )}
                      </span>
                      {view.canWrite && !o.byName && (
                        <button
                          type="button"
                          className="ui-btn ui-btn-sm"
                          disabled={pending}
                          aria-label={`${o.label} nicht mehr als eigenes Konto führen`}
                          onClick={() => run(`own:${o.counterpartyKey}`, () => unmarkOwnAccount(overview.year, overview.month, o.counterpartyKey))}
                        >
                          Zurücknehmen
                        </button>
                      )}
                    </div>
                    {error?.at === `own:${o.counterpartyKey}` && (
                      <p className="ui-note ui-note-danger mt-2" role="alert">
                        {error.message}
                      </p>
                    )}
                  </li>
                ))}
              </ul>
            </details>
          )}

          {view.answers.length > 0 && (
            <details className="glass-panel ui-disclosure mt-4 rounded-xl p-4">
              <summary className="cursor-pointer text-sm font-semibold" style={{ color: 'var(--foreground)' }}>
                Deine Zuordnungen ({view.answers.length})
              </summary>
              <ul className="mt-3 divide-y">
                {view.answers.map((a) => (
                  <li key={a.counterpartyKey} className="py-2 text-sm">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span>
                        {a.label}: {SPENDING_CATEGORY_LABELS[a.category]}
                      </span>
                      {view.canWrite && (
                        <button
                          type="button"
                          className="ui-btn ui-btn-sm"
                          disabled={pending}
                          aria-label={`Zuordnung für ${a.label} zurücknehmen`}
                          onClick={() => run(`answer:${a.counterpartyKey}`, () => withdrawCategory(overview.year, overview.month, a.counterpartyKey))}
                        >
                          Zurücknehmen
                        </button>
                      )}
                    </div>
                    {error?.at === `answer:${a.counterpartyKey}` && (
                      <p className="ui-note ui-note-danger mt-2" role="alert">
                        {error.message}
                      </p>
                    )}
                  </li>
                ))}
              </ul>
            </details>
          )}

          {view.dormantLinks.length > 0 && (
            <details className="glass-panel ui-disclosure mt-4 rounded-xl p-4">
              <summary className="cursor-pointer text-sm font-semibold" style={{ color: 'var(--foreground)' }}>
                Belege an Zahlungen, die nicht mehr hierher gehören ({view.dormantLinks.length})
              </summary>
              <p className="mt-2 text-xs" style={{ color: 'var(--muted)' }}>
                Die Firma, die das Konto führt, hat diese Zahlungen inzwischen anders beantwortet, die Weitergabe ist beendet, oder ein
                späterer Import hat die Zahlung storniert. Der Beleg zählt so lange nirgends; einer anderen Zahlung wird er nur bei einer
                stornierten Zahlung vorgeschlagen. Kommt die Zahlung zurück, gilt die Verknüpfung wieder; „Lösen“ gibt den Beleg frei.
              </p>
              <ul className="mt-2 divide-y">
                {view.dormantLinks.map((l) => (
                  <li key={l.paymentId} className="py-2 text-sm">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span>
                        {l.receipts === 1 ? 'Beleg' : `${l.receipts} Belege`} verknüpft am {formatDay(l.linkedOn)} über {euro(l.cents)}
                      </span>
                      {view.canWrite && (
                        <button
                          type="button"
                          className="ui-btn ui-btn-sm"
                          disabled={pending}
                          aria-label={`Lösen: ${l.receipts === 1 ? 'Beleg' : `${l.receipts} Belege`}, verknüpft am ${formatDay(l.linkedOn)} über ${euro(l.cents)}`}
                          onClick={() => {
                            const what = l.receipts === 1 ? 'Den Beleg' : `Die ${l.receipts} Belege`;
                            if (!window.confirm(`${what} von dieser Zahlung lösen? ${l.receipts === 1 ? 'Der Beleg bleibt' : 'Die Belege bleiben'} erhalten und ${l.receipts === 1 ? 'kann' : 'können'} einer anderen Zahlung zugeordnet werden.`)) return;
                            run(`dormant:${l.paymentId}`, () => unlinkRoutedReceipt(overview.year, overview.month, l.paymentId));
                          }}
                        >
                          Lösen
                        </button>
                      )}
                    </div>
                    {error?.at === `dormant:${l.paymentId}` && (
                      <p className="ui-note ui-note-danger mt-2" role="alert">
                        {error.message}
                      </p>
                    )}
                  </li>
                ))}
              </ul>
            </details>
          )}

          <details className="glass-panel ui-disclosure mt-4 rounded-xl p-4">
            <summary className="cursor-pointer text-sm font-semibold" style={{ color: 'var(--foreground)' }}>
              Zahlungen {period} ({overview.payments.length})
            </summary>
            <div className="ui-scroll mt-3 overflow-x-auto">
              <table className="w-full text-left text-sm">
                <caption className="sr-only">Zahlungen {period} mit Kategorie, Zweck und Beleg</caption>
                <thead>
                  <tr className="text-xs" style={{ color: 'var(--muted)' }}>
                    <th scope="col" className="py-1 pr-3 font-normal">Tag</th>
                    <th scope="col" className="py-1 pr-3 font-normal">Gegenseite</th>
                    <th scope="col" className="py-1 pr-3 font-normal">Kategorie</th>
                    <th scope="col" className="py-1 pr-3 font-normal">Zweck</th>
                    <th scope="col" className="py-1 pr-3 font-normal">Beleg</th>
                    <th scope="col" className="py-1 text-right font-normal">Betrag</th>
                  </tr>
                </thead>
                <tbody>
                  {overview.payments.map((p) => (
                    <tr key={p.id} className="align-top">
                      <td className="py-1 pr-3 whitespace-nowrap">{formatDay(p.bookingDay)}</td>
                      <td className="py-1 pr-3">
                        {p.counterparty || 'ohne Namen'}
                        {p.reference && (
                          <span className="block text-xs" style={{ color: 'var(--muted)' }}>
                            {p.reference}
                          </span>
                        )}
                      </td>
                      <td className="py-1 pr-3">
                        {SPENDING_CATEGORY_LABELS[p.category]}
                        <span className="block text-xs" style={{ color: 'var(--muted)' }}>
                          {BASIS_LABELS[p.basis]}
                        </span>
                      </td>
                      <td className="py-1 pr-3">
                        {p.awaitingList !== null ? `Sammelzahlung, wartet auf die nächste ${SERVICE_LABELS[p.awaitingList] ?? p.awaitingList}-Liste` : p.spendingCents === null ? 'Umbuchung' : PURPOSE_LABELS[p.purpose]}
                      </td>
                      <td className="py-1 pr-3">
                        {p.spendingCents === null ? 'nicht nötig' : p.hasReceipt ? 'verknüpft' : 'keiner'}
                        {p.routed && p.hasReceipt && view.canWrite && (
                          <button
                            type="button"
                            className="ui-btn ui-btn-sm ml-2"
                            disabled={pending}
                            aria-label={`Lösen: Beleg von ${p.counterparty || 'dieser Zahlung'} am ${formatDay(p.bookingDay)}`}
                            onClick={() => {
                              if (!window.confirm('Den Beleg von dieser Zahlung lösen? Der Beleg bleibt erhalten, die Zahlung fragt dann wieder nach einem Beleg.')) return;
                              run(`routed:${p.id}`, () => unlinkRoutedReceipt(overview.year, overview.month, p.id));
                            }}
                          >
                            Lösen
                          </button>
                        )}
                        {error?.at === `routed:${p.id}` && (
                          <span className="ui-note ui-note-danger mt-1 block" role="alert">
                            {error.message}
                          </span>
                        )}
                      </td>
                      <td className="py-1 text-right tabular-nums">{euro(-p.amountCents)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        </div>
      )}
    </main>
  );
}
