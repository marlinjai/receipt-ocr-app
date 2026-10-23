'use client';

import { useEffect, useId, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { formatCents } from '@/lib/tax/money';
import { MAX_LIMIT_CENTS, parseEuroInput, type BudgetLine, type BudgetLevel, type LimitBasis } from '@/lib/spending/budgets';
import { setBudget, type BudgetResult, type BudgetsView } from './budget-actions';

/**
 * The budgets of this month on the spending page: per category (by default
 * the owner's twelve-month average) and per counterparty where he set one,
 * with what is spent, where the month is heading, and a way to change each
 * limit. Warnings go out through the notification port (see `checks.ts`).
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

function BudgetRow({
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
  /** Resolves true when the server took the change; the form stays open with its input otherwise. */
  onSave: (change: { limitCents?: number | null; reset?: boolean }) => Promise<boolean>;
}) {
  const id = useId();
  const [editing, setEditing] = useState(false);
  const [amount, setAmount] = useState('');
  const [inputError, setInputError] = useState<string | null>(null);
  const share = line.limitCents ? Math.min(100, Math.round((line.spentCents / line.limitCents) * 100)) : 0;
  const color = line.level === 'passed' ? 'var(--danger, var(--accent))' : line.level === 'on_pace' ? 'var(--warning, var(--accent))' : 'var(--accent)';
  return (
    <li className="py-3 text-sm">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span style={{ color: 'var(--foreground)' }}>
          {line.label}
          {line.scope === 'vendor' && (
            <span className="ml-2 text-xs" style={{ color: 'var(--muted)' }}>
              Gegenseite
            </span>
          )}
        </span>
        <span className="tabular-nums">
          {euro(Math.max(0, line.spentCents))}
          {line.limitCents !== null && <span style={{ color: 'var(--muted)' }}> von {euro(line.limitCents)}</span>}
        </span>
      </div>
      {line.limitCents !== null && (
        <div
          className="mt-1 h-1.5 w-full rounded-full"
          style={{ background: 'var(--border, rgba(128,128,128,0.2))' }}
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
      <p className="mt-1 text-xs" style={{ color: 'var(--muted)' }}>
        {basisLabel(line.basis, line.averageMonths)}
        {line.limitCents !== null && `, ${LEVEL_LABELS[line.level]}`}
        {line.level === 'on_pace' && `: etwa ${euro(line.projectedCents)} zum Monatsende`}
        {line.basis === 'set' && line.averageCents !== null && `; Durchschnitt ${euro(line.averageCents)}`}
        {line.spentCents < 0 && '; Gutschriften überwiegen'}
        {line.allBusiness && '; die Zahlungen dieses Monats zählen als geschäftlich'}
      </p>
      {canWrite && !editing && (
        <button
          type="button"
          className="ui-btn ui-btn-sm ui-btn-ghost mt-1"
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
      )}
      {canWrite && editing && (
        <form
          className="mt-2 flex flex-wrap items-center gap-2"
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
      )}
      {error && (
        <p className="ui-note ui-note-danger mt-2" role="alert">
          {error}
        </p>
      )}
    </li>
  );
}

export default function BudgetsPanel({ initial }: { initial: BudgetsView }) {
  const id = useId();
  const router = useRouter();
  const [view, setView] = useState(initial);
  // The page reads the budgets afresh after a check or an import: take that over.
  useEffect(() => {
    // Synchronizing with a new server view is the point of this effect.
    setView(initial);
  }, [initial]);
  const [error, setError] = useState<{ at: string; message: string } | null>(null);
  const [pending, startTransition] = useTransition();
  const [vendor, setVendor] = useState('');
  const [vendorAmount, setVendorAmount] = useState('');
  const monthName = MONTHS[Number(view.month.slice(5, 7)) - 1];

  /** Save a change; resolves true when the server took it, so a form only closes or clears on success. */
  const save = (at: string, input: Record<string, unknown>) =>
    new Promise<boolean>((resolve) => {
      setError(null);
      startTransition(async () => {
        const result = await setBudget(input);
        if (result.ok) {
          setView(result.value);
          // The charts above compare against the same limits: the page reads them afresh.
          router.refresh();
        } else setError({ at, message: budgetActionMessage(result) });
        resolve(result.ok);
      });
    });
  const errorAt = (at: string) => (error?.at === at ? error.message : null);
  const warnings = view.lines.filter((l) => l.level !== 'ok');

  return (
    <section id="budgets" className="glass-panel mt-4 rounded-xl p-4" aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`} className="text-sm font-semibold" style={{ color: 'var(--foreground)' }}>
        Budgets {monthName} {view.month.slice(0, 4)}
        {warnings.length > 0 && (
          <span className="ml-2 text-xs" style={{ color: 'var(--danger, var(--accent))' }}>
            {warnings.length === 1 ? '1 Warnung' : `${warnings.length} Warnungen`}
          </span>
        )}
      </h2>
      <p className="mt-1 text-xs" style={{ color: 'var(--muted)' }}>
        Ohne eigene Zahl gilt der Durchschnitt der bisherigen Monate (höchstens zwölf). Geschäftliche Zahlungen zählen nicht. Eine Warnung kommt, wenn ein Budget überschritten ist oder
        bei gleichem Tempo bis zum Monatsende sicher überschritten wird.
      </p>
      {view.lines.length === 0 ? (
        <p className="mt-3 text-sm" style={{ color: 'var(--muted)' }}>
          Noch keine Ausgaben, aus denen sich Budgets ergeben.
        </p>
      ) : (
        <ul className="mt-2 divide-y">
          {view.lines.map((line) => (
            <BudgetRow
              key={`${line.scope}:${line.key}`}
              line={line}
              canWrite={view.canWrite}
              pending={pending}
              error={errorAt(`${line.scope}:${line.key}`)}
              onSave={(change) => save(`${line.scope}:${line.key}`, { scope: line.scope, key: line.key, label: line.label, ...change })}
            />
          ))}
        </ul>
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
