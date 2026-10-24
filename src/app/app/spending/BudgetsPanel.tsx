'use client';

import { useId, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { formatCents } from '@/lib/tax/money';
import { MAX_LIMIT_CENTS, parseEuroInput, type BudgetLine, type BudgetLevel, type LimitBasis } from '@/lib/spending/budgets';
import { SPENDING_CATEGORY_LABELS, type SpendingCategory } from '@/lib/spending/categories';
import { CATEGORY_GROUP, budgetBars, type BudgetBar } from '@/lib/spending/charts';
import type { SpendingOverview } from '@/lib/spending/overview';
import { setBudget, type BudgetResult, type BudgetsView } from './budget-actions';
import { Swatch, groupColor } from './OverviewCharts';

/**
 * The one budget block of the spending overview (plan
 * docs/plans/2026-10-23-budget-overview.md, decided by the coordinating
 * session on 2026-10-24): per category, budget against spent for the period
 * shown as a bar, with the monthly limit to change right there (by default
 * the owner's twelve-month average); then the budgets per counterparty of
 * this month and the form for a new one. Warnings go out through the
 * notification port (see `checks.ts`).
 */

function euro(cents: number): string {
  return `${formatCents(cents)} €`;
}

const LEVEL_LABELS: Record<BudgetLevel, string> = {
  ok: 'im Rahmen',
  on_pace: 'wird bei gleichem Tempo überschritten',
  passed: 'überschritten',
};

/** Where a limit comes from; the average names how many months it is over when that is fewer than twelve. */
export function basisLabel(basis: LimitBasis, months: number): string {
  if (basis === 'set') return 'selbst gesetzt';
  if (basis === 'off') return 'ausgeschaltet';
  if (basis === 'none') return 'noch kein Budget';
  return months >= 12 ? 'Durchschnitt der letzten zwölf Monate' : `Durchschnitt aus ${months === 1 ? 'einem Monat' : `${months} Monaten`}`;
}

const AMOUNT_HINT = 'Bitte einen Betrag in Euro eingeben, größer als null und höchstens eine Million, zum Beispiel 120 oder 120,50.';

const MONTHS = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];

/** What went wrong, in words a person can act on. */
export function budgetActionMessage(result: Extract<BudgetResult<unknown>, { ok: false }>): string {
  if (result.error === 'unauthorized') return 'Die Anmeldung ist abgelaufen. Bitte die Seite neu laden und neu anmelden.';
  if (result.error === 'forbidden') return 'Für diesen Arbeitsbereich fehlt die Berechtigung zum Ändern.';
  if (result.detail === 'invalid_limit') return AMOUNT_HINT;
  if (result.detail === 'invalid_key') return 'Bitte den Namen der Gegenseite so eingeben, wie er in den Zahlungen steht (höchstens 200 Zeichen).';
  return 'Das hat nicht geklappt. Bitte noch einmal versuchen; wenn es wieder scheitert, die Seite neu laden.';
}

/** "Ändern" and its form for one monthly limit: set, switch off, back to the average (or remove a counterparty budget). */
function LimitEditor({
  line,
  pending,
  onSave,
}: {
  line: BudgetLine;
  pending: boolean;
  /** Resolves true when the server took the change; the form stays open with its input otherwise. */
  onSave: (change: { limitCents?: number | null; reset?: boolean }) => Promise<boolean>;
}) {
  const id = useId();
  const [editing, setEditing] = useState(false);
  const [amount, setAmount] = useState('');
  const [inputError, setInputError] = useState<string | null>(null);
  if (!editing) {
    return (
      <button
        type="button"
        className="ui-btn ui-btn-sm ui-btn-ghost shrink-0"
        disabled={pending}
        onClick={() => {
          // Always the current limit, also after a reset or a change elsewhere.
          setAmount(line.limitCents ? formatCents(line.limitCents) : '');
          setInputError(null);
          setEditing(true);
        }}
        aria-label={`Budget für ${line.label} ändern`}
      >
        Ändern
      </button>
    );
  }
  return (
    <form
      className="mt-2 flex w-full flex-wrap items-center gap-2"
      onSubmit={async (e) => {
        e.preventDefault();
        const cents = parseEuroInput(amount);
        if (cents === null || cents > MAX_LIMIT_CENTS) {
          setInputError(AMOUNT_HINT);
          return;
        }
        setInputError(null);
        if (await onSave({ limitCents: cents })) setEditing(false);
      }}
    >
      <label className="sr-only" htmlFor={`${id}-amount`}>
        Monatliches Budget für {line.label} in Euro
      </label>
      <input
        id={`${id}-amount`}
        className="ui-input"
        style={{ width: 120 }}
        inputMode="decimal"
        value={amount}
        autoFocus
        aria-invalid={inputError ? true : undefined}
        aria-describedby={inputError ? `${id}-amount-error` : undefined}
        onChange={(e) => setAmount(e.target.value)}
      />
      <span className="text-xs">€ im Monat</span>
      <button type="submit" className="ui-btn ui-btn-sm" disabled={pending} aria-label={`Budget für ${line.label} speichern`}>
        Speichern
      </button>
      {line.basis !== 'off' && (
        <button
          type="button"
          className="ui-btn ui-btn-sm ui-btn-ghost"
          disabled={pending}
          onClick={async () => {
            if (await onSave({ limitCents: null })) setEditing(false);
          }}
        >
          Ausschalten
        </button>
      )}
      {(line.basis === 'set' || line.basis === 'off') && (
        <button
          type="button"
          className="ui-btn ui-btn-sm ui-btn-ghost"
          disabled={pending}
          onClick={async () => {
            if (await onSave({ reset: true })) setEditing(false);
          }}
        >
          {line.scope === 'category' ? 'Zurück zum Durchschnitt' : 'Budget entfernen'}
        </button>
      )}
      <button type="button" className="ui-btn ui-btn-sm ui-btn-ghost" onClick={() => setEditing(false)}>
        Abbrechen
      </button>
      {inputError && (
        <p id={`${id}-amount-error`} className="ui-note ui-note-danger w-full" role="alert">
          {inputError}
        </p>
      )}
    </form>
  );
}

/** What the monthly limit of this month is and where it comes from, in one line. */
function limitNote(line: BudgetLine, monthName: string): string {
  const parts = [`${monthName}: ${basisLabel(line.basis, line.averageMonths)}`];
  if (line.limitCents !== null) parts[0] += ` ${euro(line.limitCents)}, ${LEVEL_LABELS[line.level]}`;
  if (line.level === 'on_pace') parts.push(`etwa ${euro(line.projectedCents)} zum Monatsende`);
  if (line.basis === 'set' && line.averageCents !== null) parts.push(`Durchschnitt ${euro(line.averageCents)}`);
  if (line.spentCents < 0) parts.push('Gutschriften überwiegen');
  if (line.allBusiness) parts.push('die Zahlungen dieses Monats zählen als geschäftlich');
  return parts.join('; ');
}

const LEVEL_TEXT = { ok: null, on_pace: 'wird bei gleichem Tempo überschritten', passed: 'überschritten' } as const;

/** A category's line of this month; a category without one (no spending, no limit this month) gets an empty one to set a limit on. */
function lineOf(lines: readonly BudgetLine[], category: SpendingCategory): BudgetLine {
  return (
    lines.find((l) => l.scope === 'category' && l.key === category) ?? {
      scope: 'category',
      key: category,
      label: SPENDING_CATEGORY_LABELS[category],
      limitCents: null,
      basis: 'none',
      averageCents: null,
      averageMonths: 0,
      allBusiness: false,
      spentCents: 0,
      projectedCents: 0,
      level: 'ok',
    }
  );
}

function CategoryRow({
  bar,
  line,
  count,
  scale,
  monthName,
  canWrite,
  pending,
  error,
  onSave,
}: {
  bar: BudgetBar;
  line: BudgetLine;
  /** Payments of the category in the period. */
  count: number;
  scale: number;
  monthName: string;
  canWrite: boolean;
  pending: boolean;
  error: string | null;
  onSave: (change: { limitCents?: number | null; reset?: boolean }) => Promise<boolean>;
}) {
  const over = bar.level === 'passed';
  const fill = over ? 'var(--danger)' : bar.level === 'on_pace' ? 'var(--warning)' : groupColor(CATEGORY_GROUP[bar.category]);
  const status = LEVEL_TEXT[bar.level];
  const pct = (cents: number) => `${(Math.max(0, cents) / scale) * 100}%`;
  return (
    <li className="py-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 text-sm">
        <span className="inline-flex items-center gap-1.5" style={{ color: 'var(--foreground)' }}>
          <Swatch group={CATEGORY_GROUP[bar.category]} />
          {bar.label}
          <span className="text-xs" style={{ color: 'var(--muted)' }}>
            {count} {count === 1 ? 'Zahlung' : 'Zahlungen'}
          </span>
        </span>
        <span className="tabular-nums" style={{ color: 'var(--foreground)' }}>
          {euro(bar.spentCents)}
          <span style={{ color: 'var(--muted)' }}>{bar.limitCents !== null ? ` von ${euro(bar.limitCents)}${bar.average ? ' (Durchschnitt)' : ''}` : ', kein Budget'}</span>
        </span>
      </div>
      <div
        className="relative mt-1 h-2 w-full rounded-full"
        style={{ background: 'var(--chart-grid)' }}
        role="img"
        aria-label={`${bar.label}: ${euro(bar.spentCents)} ausgegeben${bar.limitCents !== null ? `, Budget ${euro(bar.limitCents)}${bar.average ? ' (Durchschnitt der letzten Monate)' : ''}` : ', kein Budget'}${bar.projectedCents !== null ? `, bei gleichem Tempo etwa ${euro(bar.projectedCents)}` : ''}${status ? `, ${status}` : ''}`}
      >
        {bar.projectedCents !== null && bar.projectedCents > bar.spentCents && (
          <span aria-hidden="true" className="absolute inset-y-0 left-0 rounded-full" style={{ width: pct(bar.projectedCents), background: fill, opacity: 0.3 }} />
        )}
        <span aria-hidden="true" className="absolute inset-y-0 left-0 rounded-full" style={{ width: pct(bar.spentCents), background: fill }} />
        {bar.limitCents !== null && (
          <span aria-hidden="true" className="absolute -inset-y-1 w-0.5 rounded" style={{ left: `calc(${pct(bar.limitCents)} - 1px)`, background: 'var(--foreground)' }} />
        )}
      </div>
      {status && (
        <p className="mt-1 text-xs" style={{ color: over ? 'var(--danger)' : 'var(--warning)' }}>
          <span aria-hidden="true">⚠ </span>
          {status}
          {bar.projectedCents !== null && bar.level === 'on_pace' && `, etwa ${euro(bar.projectedCents)} am Monatsende`}
        </p>
      )}
      {/* The note and "Ändern" share a line; the form, when open, takes the full width below. */}
      <div className="mt-1 flex flex-wrap items-center justify-between gap-x-2">
        <p className="text-xs" style={{ color: 'var(--muted)' }}>
          {limitNote(line, monthName)}
        </p>
        {canWrite && <LimitEditor line={line} pending={pending} onSave={onSave} />}
      </div>
      {error && (
        <p className="ui-note ui-note-danger mt-2" role="alert">
          {error}
        </p>
      )}
    </li>
  );
}

function VendorRow({
  line,
  canWrite,
  pending,
  error,
  onSave,
}: {
  line: BudgetLine;
  canWrite: boolean;
  pending: boolean;
  error: string | null;
  onSave: (change: { limitCents?: number | null; reset?: boolean }) => Promise<boolean>;
}) {
  const share = line.limitCents ? Math.min(100, Math.round((line.spentCents / line.limitCents) * 100)) : 0;
  const color = line.level === 'passed' ? 'var(--danger)' : line.level === 'on_pace' ? 'var(--warning)' : 'var(--accent)';
  return (
    <li className="py-3 text-sm">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span style={{ color: 'var(--foreground)' }}>
          {line.label}
          <span className="ml-2 text-xs" style={{ color: 'var(--muted)' }}>
            Gegenseite
          </span>
        </span>
        <span className="tabular-nums">
          {euro(Math.max(0, line.spentCents))}
          {line.limitCents !== null && <span style={{ color: 'var(--muted)' }}> von {euro(line.limitCents)}</span>}
        </span>
      </div>
      {line.limitCents !== null && (
        <div
          className="mt-1 h-1.5 w-full rounded-full"
          style={{ background: 'var(--chart-grid)' }}
          role="meter"
          aria-valuemin={0}
          aria-valuemax={Math.max(line.limitCents, line.spentCents)}
          aria-valuenow={Math.max(0, line.spentCents)}
          aria-valuetext={`${euro(line.spentCents)} von ${euro(line.limitCents)}, ${LEVEL_LABELS[line.level]}`}
          aria-label={`${line.label}: ${euro(line.spentCents)} von ${euro(line.limitCents)}`}
        >
          <div className="h-1.5 rounded-full" style={{ width: `${Math.max(0, share)}%`, background: color }} />
        </div>
      )}
      <div className="mt-1 flex flex-wrap items-center justify-between gap-x-2">
        <p className="text-xs" style={{ color: 'var(--muted)' }}>
          {basisLabel(line.basis, line.averageMonths)}
          {line.limitCents !== null && `, ${LEVEL_LABELS[line.level]}`}
          {line.level === 'on_pace' && `: etwa ${euro(line.projectedCents)} zum Monatsende`}
          {line.spentCents < 0 && '; Gutschriften überwiegen'}
          {line.allBusiness && '; die Zahlungen dieses Monats zählen als geschäftlich'}
        </p>
        {canWrite && <LimitEditor line={line} pending={pending} onSave={onSave} />}
      </div>
      {error && (
        <p className="ui-note ui-note-danger mt-2" role="alert">
          {error}
        </p>
      )}
    </li>
  );
}

export default function BudgetsPanel({
  initial,
  overview,
  today,
  period,
}: {
  initial: BudgetsView;
  /** The period shown: its payments make the bars, its categories' counts the numbers next to them. */
  overview: Pick<SpendingOverview, 'year' | 'month' | 'payments' | 'byCategory'>;
  /** Today in the owner's time zone, "YYYY-MM-DD". */
  today: string;
  /** The period in words ("Oktober 2026", "2026"). */
  period: string;
}) {
  const id = useId();
  const router = useRouter();
  const [view, setView] = useState(initial);
  // The page reads the budgets afresh after a check or an import: take that over (while rendering, not in an effect).
  const [shownInitial, setShownInitial] = useState(initial);
  if (shownInitial !== initial) {
    setShownInitial(initial);
    setView(initial);
  }
  const [error, setError] = useState<{ at: string; message: string } | null>(null);
  const [pending, startTransition] = useTransition();
  const [vendor, setVendor] = useState('');
  const [vendorAmount, setVendorAmount] = useState('');
  const monthName = MONTHS[Number(view.month.slice(5, 7)) - 1];
  const currentMonth = overview.month !== null && `${overview.year}-${String(overview.month).padStart(2, '0')}` === view.month;

  /** Save a change; resolves true when the server took it, so a form only closes or clears on success. */
  const save = (at: string, input: Record<string, unknown>) =>
    new Promise<boolean>((resolve) => {
      setError(null);
      startTransition(async () => {
        const result = await setBudget(input);
        if (result.ok) {
          setView(result.value);
          // The months chart above draws the sum of the same limits: the page reads them afresh.
          router.refresh();
        } else setError({ at, message: budgetActionMessage(result) });
        resolve(result.ok);
      });
    });
  const errorAt = (at: string) => (error?.at === at ? error.message : null);
  const warnings = view.lines.filter((l) => l.level !== 'ok');
  const bars = budgetBars(overview, view.lines, today, SPENDING_CATEGORY_LABELS);
  const scale = Math.max(1, ...bars.map((b) => Math.max(b.spentCents, b.limitCents ?? 0, b.projectedCents ?? 0)));
  const counts = new Map(overview.byCategory.map((c) => [c.category, c.count]));
  const vendors = view.lines.filter((l) => l.scope === 'vendor');
  const saveLine = (line: BudgetLine) => (change: { limitCents?: number | null; reset?: boolean }) =>
    save(`${line.scope}:${line.key}`, { scope: line.scope, key: line.key, label: line.label, ...change });

  return (
    <section id="budgets" className="glass-panel mt-4 rounded-xl p-4" aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`} className="text-sm font-semibold" style={{ color: 'var(--foreground)' }}>
        Budget und Ausgaben {period}
        {warnings.length > 0 && (
          <span className="ml-2 text-xs" style={{ color: 'var(--danger)' }}>
            {warnings.length === 1 ? '1 Warnung' : `${warnings.length} Warnungen`}
            {!currentMonth && ` im ${monthName}`}
          </span>
        )}
      </h2>
      <p className="mt-1 text-xs" style={{ color: 'var(--muted)' }}>
        Gezählt wird der private Teil; geschäftliche Zahlungen zählen nicht. Ein Budget gilt je Monat: ohne eigene Zahl der Durchschnitt der bisherigen
        Monate (höchstens zwölf). Der Strich ist das Budget für diesen Zeitraum{currentMonth ? ', der blasse Teil zeigt, wo der Monat bei gleichem Tempo endet' : ''}.
        Eine Warnung kommt, wenn ein Budget überschritten ist oder bei gleichem Tempo bis zum Monatsende sicher überschritten wird.
      </p>
      {bars.length === 0 ? (
        <p className="mt-3 text-sm" style={{ color: 'var(--muted)' }}>
          In diesem Zeitraum gibt es weder Ausgaben noch Budgets.
        </p>
      ) : (
        <ul className="mt-2 divide-y">
          {bars.map((bar) => {
            const line = lineOf(view.lines, bar.category);
            return (
              <CategoryRow
                key={bar.category}
                bar={bar}
                line={line}
                count={counts.get(bar.category) ?? 0}
                scale={scale}
                monthName={`${monthName} ${view.month.slice(0, 4)}`}
                canWrite={view.canWrite}
                pending={pending}
                error={errorAt(`category:${bar.category}`)}
                onSave={saveLine(line)}
              />
            );
          })}
        </ul>
      )}
      {vendors.length > 0 && (
        <>
          <h3 className="mt-3 text-xs font-semibold" style={{ color: 'var(--foreground)' }}>
            Budgets für Gegenseiten, {monthName} {view.month.slice(0, 4)}
          </h3>
          <ul className="divide-y">
            {vendors.map((line) => (
              <VendorRow key={line.key} line={line} canWrite={view.canWrite} pending={pending} error={errorAt(`vendor:${line.key}`)} onSave={saveLine(line)} />
            ))}
          </ul>
        </>
      )}
      {view.canWrite && (
        <form
          className="mt-3 flex flex-wrap items-end gap-2 text-sm"
          onSubmit={async (e) => {
            e.preventDefault();
            const cents = parseEuroInput(vendorAmount);
            if (!vendor.trim() || cents === null || cents > MAX_LIMIT_CENTS) {
              setError({ at: 'new', message: `Bitte die Gegenseite eingeben. ${AMOUNT_HINT}` });
              return;
            }
            if (await save('new', { scope: 'vendor', label: vendor, limitCents: cents })) {
              setVendor('');
              setVendorAmount('');
            }
          }}
        >
          <label className="block">
            <span className="ui-label">Budget für eine Gegenseite</span>
            <input
              className="ui-input"
              value={vendor}
              maxLength={200}
              list={`${id}-counterparties`}
              placeholder="Name wie in den Zahlungen"
              aria-invalid={errorAt('new') ? true : undefined}
              aria-describedby={errorAt('new') ? `${id}-new-error` : undefined}
              onChange={(e) => setVendor(e.target.value)}
            />
            <datalist id={`${id}-counterparties`}>
              {view.counterparties.map((c) => (
                <option key={c} value={c} />
              ))}
            </datalist>
          </label>
          <label className="block">
            <span className="ui-label">Euro im Monat</span>
            <input
              className="ui-input"
              style={{ width: 120 }}
              inputMode="decimal"
              value={vendorAmount}
              aria-invalid={errorAt('new') ? true : undefined}
              aria-describedby={errorAt('new') ? `${id}-new-error` : undefined}
              onChange={(e) => setVendorAmount(e.target.value)}
            />
          </label>
          <button type="submit" className="ui-btn ui-btn-sm" disabled={pending}>
            Hinzufügen
          </button>
          {errorAt('new') && (
            <p id={`${id}-new-error`} className="ui-note ui-note-danger w-full" role="alert">
              {errorAt('new')}
            </p>
          )}
        </form>
      )}
    </section>
  );
}
