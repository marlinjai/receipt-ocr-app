'use client';

import { useId, useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { formatDay } from '@/lib/meals/messages';
import { formatCents } from '@/lib/tax/money';
import { ANSWERABLE_CATEGORIES, SPENDING_CATEGORY_LABELS, isSpendingCategory, type SpendingCategory } from '@/lib/spending/categories';
import type { CategoryBasis, SpendingPurpose } from '@/lib/spending/rules';
import type { SpendingView } from '@/lib/spending/service';
import { answerCategory, type Result } from './actions';

const MONTHS = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];
const MONTHS_SHORT = ['Jan', 'Feb', 'Mär', 'Apr', 'Mai', 'Jun', 'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dez'];

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
  return 'Das hat nicht geklappt. Bitte noch einmal versuchen; wenn es wieder scheitert, die Seite neu laden.';
}

export default function SpendingClient({ initial }: { initial: SpendingView }) {
  const id = useId();
  const router = useRouter();
  const [view, setView] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const { overview } = view;
  const period = overview.month === null ? `${overview.year}` : `${MONTHS[overview.month - 1]} ${overview.year}`;
  const largest = Math.max(1, ...overview.byCategory.map((c) => c.cents));
  const largestMonth = Math.max(1, ...overview.byMonth.map((m) => m.cents));

  const go = (year: number, month: number | null) => {
    router.push(month === null ? `/app/spending?jahr=${year}` : `/app/spending?jahr=${year}&monat=${month}`);
  };

  const answer = (counterparty: string, category: SpendingCategory | null) => {
    setError(null);
    startTransition(async () => {
      const result = await answerCategory(overview.year, overview.month, counterparty, category);
      if (result.ok) setView(result.value);
      else setError(spendingActionMessage(result));
    });
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
        {error && <p className="ui-note ui-note-danger">{error}</p>}
        {view.noPayments && (
          <p className="ui-note ui-note-warn">
            In diesem Arbeitsbereich sind noch keine Zahlungen. Sie kommen aus den Kontoauszügen, die unter{' '}
            <Link href="/app/finance" className="underline">
              Finanzen, Zahlungen
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
                {a.label} bis {formatDay(a.completeThrough)}
              </span>
            ))}
          </p>
        )}
      </div>

      <section className="mt-4 grid gap-3 sm:grid-cols-4" aria-label={`Summen ${period}`}>
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
          Nicht mitgezählt: {overview.ownTransfers.count} Umbuchungen zwischen eigenen Konten über {euro(overview.ownTransfers.cents)}.
        </p>
      )}

      <section className="glass-panel mt-4 rounded-xl p-4" aria-labelledby={`${id}-months`}>
        <h2 id={`${id}-months`} className="text-sm font-semibold" style={{ color: 'var(--foreground)' }}>
          Monate {overview.year}
        </h2>
        <ol className="mt-3 grid grid-cols-12 items-end gap-1" style={{ height: 120 }}>
          {overview.byMonth.map((m) => {
            const selected = overview.month === m.month;
            return (
              <li key={m.month} className="flex h-full flex-col justify-end">
                <button
                  type="button"
                  className="flex h-full w-full flex-col items-center justify-end gap-1 rounded"
                  aria-pressed={selected}
                  aria-label={`${MONTHS[m.month - 1]}: ${euro(m.cents)}`}
                  title={`${MONTHS[m.month - 1]}: ${euro(m.cents)}`}
                  onClick={() => go(overview.year, selected ? null : m.month)}
                >
                  <span
                    className="w-full rounded-sm"
                    style={{
                      height: `${Math.max(2, Math.round((Math.max(0, m.cents) / largestMonth) * 90))}%`,
                      background: selected ? 'var(--accent)' : 'var(--accent-muted)',
                    }}
                  />
                  <span className="text-[10px]" style={{ color: selected ? 'var(--accent)' : 'var(--muted)' }}>
                    {MONTHS_SHORT[m.month - 1]}
                  </span>
                </button>
              </li>
            );
          })}
        </ol>
      </section>

      <section className="glass-panel mt-4 rounded-xl p-4" aria-labelledby={`${id}-categories`}>
        <h2 id={`${id}-categories`} className="text-sm font-semibold" style={{ color: 'var(--foreground)' }}>
          Kategorien {period}
        </h2>
        <ul className="mt-3 space-y-2">
          {[...overview.byCategory]
            .sort((a, b) => b.cents - a.cents)
            .map((c) => (
              <li key={c.category}>
                <div className="flex items-baseline justify-between gap-3 text-sm">
                  <span style={{ color: c.category === 'unclear' && c.cents !== 0 ? 'var(--danger, var(--foreground))' : 'var(--foreground)' }}>
                    {SPENDING_CATEGORY_LABELS[c.category]}
                    <span className="ml-2 text-xs" style={{ color: 'var(--muted)' }}>
                      {c.count} {c.count === 1 ? 'Zahlung' : 'Zahlungen'}
                    </span>
                  </span>
                  <span className="tabular-nums" style={{ color: 'var(--foreground)' }}>
                    {euro(c.cents)}
                  </span>
                </div>
                <div className="mt-1 h-1.5 w-full rounded-full" style={{ background: 'var(--border, rgba(128,128,128,0.2))' }}>
                  <div
                    className="h-1.5 rounded-full"
                    style={{ width: `${Math.round((Math.max(0, c.cents) / largest) * 100)}%`, background: c.category === 'unclear' ? 'var(--muted)' : 'var(--accent)' }}
                  />
                </div>
              </li>
            ))}
        </ul>
      </section>

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
            </p>
            <ul className="mt-3 divide-y" style={{ borderColor: 'var(--border, rgba(128,128,128,0.2))' }}>
              {overview.unclear.map((u) => (
                <li key={u.counterpartyKey || `${u.counterparty}-${u.lastDay}`} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
                  <span style={{ color: 'var(--foreground)' }}>
                    {u.counterparty || 'ohne Namen'}
                    <span className="ml-2 text-xs" style={{ color: 'var(--muted)' }}>
                      {u.count} {u.count === 1 ? 'Zahlung' : 'Zahlungen'}, zuletzt {formatDay(u.lastDay)}
                    </span>
                  </span>
                  <span className="flex items-center gap-2">
                    <span className="tabular-nums">{euro(u.cents)}</span>
                    {u.counterpartyKey ? (
                      <select
                        className="ui-input"
                        style={{ width: 'auto' }}
                        aria-label={`Kategorie für ${u.counterparty}`}
                        value=""
                        disabled={pending}
                        onChange={(e) => {
                          if (isSpendingCategory(e.target.value)) answer(u.counterparty, e.target.value);
                        }}
                      >
                        <option value="">Kategorie wählen</option>
                        {ANSWERABLE_CATEGORIES.map((c) => (
                          <option key={c} value={c}>
                            {SPENDING_CATEGORY_LABELS[c]}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <span className="text-xs" style={{ color: 'var(--muted)' }}>
                        ohne Gegenseite, keine Zuordnung möglich
                      </span>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          </>
        )}
      </section>

      {view.answers.length > 0 && (
        <details className="glass-panel ui-disclosure mt-4 rounded-xl p-4">
          <summary className="cursor-pointer text-sm font-semibold" style={{ color: 'var(--foreground)' }}>
            Deine Zuordnungen ({view.answers.length})
          </summary>
          <ul className="mt-3 divide-y">
            {view.answers.map((a) => (
              <li key={a.counterpartyKey} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
                <span>
                  {a.label}: {SPENDING_CATEGORY_LABELS[a.category]}
                </span>
                <button type="button" className="ui-btn ui-btn-sm" disabled={pending} onClick={() => answer(a.label, null)}>
                  Zurücknehmen
                </button>
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
            <thead>
              <tr className="text-xs" style={{ color: 'var(--muted)' }}>
                <th className="py-1 pr-3 font-normal">Tag</th>
                <th className="py-1 pr-3 font-normal">Gegenseite</th>
                <th className="py-1 pr-3 font-normal">Kategorie</th>
                <th className="py-1 pr-3 font-normal">Zuordnung</th>
                <th className="py-1 text-right font-normal">Betrag</th>
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
                  <td className="py-1 pr-3">{p.spendingCents === null ? 'Umbuchung' : PURPOSE_LABELS[p.purpose]}</td>
                  <td className="py-1 text-right tabular-nums">{euro(-p.amountCents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </main>
  );
}
