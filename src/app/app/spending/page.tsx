import Link from 'next/link';
import { auth } from '@/lib/auth';
import { getSpending } from './actions';
import SpendingClient from './SpendingClient';
import ReceiptChecks from './ReceiptChecks';
import { getReceiptChecks } from './loop-actions';
import BudgetsPanel from './BudgetsPanel';
import { getBudgets } from './budget-actions';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Ausgaben' };

export default async function SpendingPage({ searchParams }: { searchParams: Promise<{ jahr?: string; monat?: string; pruefen?: string; firma?: string }> }) {
  await auth.requireSession('/app/spending');
  const { jahr, monat, pruefen, firma } = await searchParams;
  const [data, checks, budgets] = await Promise.all([getSpending(jahr ?? null, monat ?? null), getReceiptChecks(), getBudgets()]);

  // "Reload" keeps the period that was asked for.
  const params = new URLSearchParams();
  if (jahr) params.set('jahr', jahr);
  if (monat) params.set('monat', monat);
  const reload = params.size > 0 ? `/app/spending?${params.toString()}` : '/app/spending';

  if (!data.ok) {
    return (
      <main className="relative z-10 flex min-h-svh items-center justify-center px-4 py-16">
        <div className="glass-panel max-w-md rounded-xl p-6 text-center">
          <h1 className="text-lg font-semibold" style={{ color: 'var(--foreground)' }}>
            Die Ausgabenübersicht konnte nicht geladen werden
          </h1>
          <p className="mt-2 text-sm" style={{ color: 'var(--muted)' }}>
            {data.error === 'unauthorized' || data.error === 'forbidden'
              ? 'Für diesen Arbeitsbereich fehlt der Zugriff. Bitte neu anmelden oder den Arbeitsbereich wechseln.'
              : 'Beim Laden ist ein Fehler aufgetreten. Bitte die Seite neu laden.'}
          </p>
          <div className="mt-4 flex justify-center gap-2">
            <Link href={reload} className="ui-btn ui-btn-primary">
              Neu laden
            </Link>
            <Link href="/app/dashboard" className="ui-btn">
              Zum Dashboard
            </Link>
          </div>
        </div>
      </main>
    );
  }

  // Keyed by the period, so a new year or month starts from the server's view, not the previous one's state.
  return (
    <SpendingClient key={`${data.value.overview.year}-${data.value.overview.month ?? 'all'}`} initial={data.value}>
      {checks.ok ? (
        // Keyed by company: after a switch nothing of the other company (a summary, a notice, the settings form) stays.
        <ReceiptChecks key={checks.value.workspaceId} initial={checks.value} focusPaymentId={pruefen ?? null} forCompany={firma ?? null} />
      ) : (
        <p className="ui-note ui-note-danger mt-4">Die offenen Belege konnten nicht geladen werden. Bitte die Seite neu laden.</p>
      )}
      {budgets.ok ? (
        <BudgetsPanel initial={budgets.value} />
      ) : (
        <p className="ui-note ui-note-danger mt-4">Die Budgets konnten nicht geladen werden. Bitte die Seite neu laden.</p>
      )}
    </SpendingClient>
  );
}
