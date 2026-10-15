import Link from 'next/link';
import { auth } from '@/lib/auth';
import { getSpending } from './actions';
import SpendingClient from './SpendingClient';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Ausgaben' };

export default async function SpendingPage({ searchParams }: { searchParams: Promise<{ jahr?: string; monat?: string }> }) {
  await auth.requireSession('/app/spending');
  const { jahr, monat } = await searchParams;
  const data = await getSpending(jahr ? Number(jahr) : new Date().getFullYear(), monat ? Number(monat) : null);

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
            <Link href="/app/spending" className="ui-btn ui-btn-primary">
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
  return <SpendingClient key={`${data.value.overview.year}-${data.value.overview.month ?? 'all'}`} initial={data.value} />;
}
