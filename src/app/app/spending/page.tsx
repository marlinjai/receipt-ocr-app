import Link from 'next/link';
import { auth } from '@/lib/auth';
import { getSpending } from './actions';
import SpendingClient from './SpendingClient';
import { spendingTabOf } from '@/lib/spending/paths';
import ReceiptChecks from './ReceiptChecks';
import { getReceiptChecks } from './loop-actions';
import { getBudgets } from './budget-actions';
import { berlinToday } from '@/lib/spending/period';
import { measurePage, timed } from '@/lib/timing';
import { withSharedReads } from '@/lib/shared-reads';
import { getPurchases } from './purchases-actions';
import PurchasesPanel from './PurchasesPanel';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Ausgaben' };

type SpendingParams = Promise<{ jahr?: string; monat?: string; pruefen?: string; firma?: string; ansicht?: string }>;

export default async function SpendingPage({ searchParams }: { searchParams: SpendingParams }) {
  return measurePage('/app/spending', () => renderSpending(searchParams));
}

async function renderSpending(searchParams: SpendingParams) {
  await timed('auth.session', () => auth.requireSession('/app/spending'));
  const { jahr, monat, pruefen, firma, ansicht } = await searchParams;
  const tab = spendingTabOf(ansicht, pruefen);
  // The overview, the receipt checks and the budgets all start from the company's payments: read once for all
  // three (`withSharedReads`), the page only reads.
  const [data, checks, budgets, purchases] = await withSharedReads(() =>
    Promise.all([
      timed('spending', () => getSpending(jahr ?? null, monat ?? null)),
      timed('checks', () => getReceiptChecks()),
      timed('budgets', () => getBudgets()),
      // "Was gekauft" is read only when its tab is open.
      tab === 'gekauft' ? timed('purchases', () => getPurchases(jahr ?? null, monat ?? null)) : Promise.resolve(null),
    ]),
  );

  // "Reload" keeps the period that was asked for.
  const params = new URLSearchParams();
  if (jahr) params.set('jahr', jahr);
  if (monat) params.set('monat', monat);
  if (tab !== 'ueberblick') params.set('ansicht', tab);
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
  // The panels handed in as props carry keys: React checks elements that cross from the server as it checks a list.
  return (
    <SpendingClient
      key={`${data.value.overview.year}-${data.value.overview.month ?? 'all'}`}
      initial={data.value}
      tab={tab}
      today={berlinToday()}
      openChecks={checks.ok ? checks.value.loop.open.length : null}
      checks={
        checks.ok ? (
          // Keyed by company: after a switch nothing of the other company (a summary, a notice, the settings form) stays.
          <ReceiptChecks key={checks.value.workspaceId} initial={checks.value} focusPaymentId={pruefen ?? null} forCompany={firma ?? null} />
        ) : (
          <p key="checks" className="ui-note ui-note-danger mt-4">Die offenen Belege konnten nicht geladen werden. Bitte die Seite neu laden.</p>
        )
      }
      budgets={budgets.ok ? budgets.value : null}
      purchases={
        purchases === null ? null : purchases.ok ? (
          <PurchasesPanel key="purchases" overview={purchases.value} />
        ) : (
          <p key="purchases" className="ui-note ui-note-danger mt-4">
            {purchases.error === 'failed' ? 'Was gekauft wurde, konnte nicht geladen werden. Bitte die Seite neu laden.' : 'Für diesen Arbeitsbereich fehlt der Zugriff. Bitte neu anmelden oder den Arbeitsbereich wechseln.'}
          </p>
        )
      }
    />
  );
}
