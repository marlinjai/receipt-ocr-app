import Link from 'next/link';
import { auth } from '@/lib/auth';
import { getStatement } from './actions';
import FinanceClient from './FinanceClient';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Finanzen' };

export default async function FinancePage({ searchParams }: { searchParams: Promise<{ jahr?: string }> }) {
  await auth.requireSession('/app/finance');
  const { jahr } = await searchParams;
  const data = await getStatement(jahr ? Number(jahr) : new Date().getFullYear());

  if (!data.ok) {
    return (
      <main className="relative z-10 flex min-h-svh items-center justify-center px-4 py-16">
        <div className="glass-panel max-w-md rounded-xl p-6 text-center">
          <h1 className="text-lg font-semibold" style={{ color: 'var(--foreground)' }}>
            Die Finanzübersicht konnte nicht geladen werden
          </h1>
          <p className="mt-2 text-sm" style={{ color: 'var(--muted)' }}>
            {data.error === 'unauthorized' || data.error === 'forbidden'
              ? 'Für diesen Arbeitsbereich fehlt der Zugriff. Bitte neu anmelden oder den Arbeitsbereich wechseln.'
              : 'Beim Laden ist ein Fehler aufgetreten. Bitte die Seite neu laden.'}
          </p>
          <div className="mt-4 flex justify-center gap-2">
            <Link href="/app/finance" className="ui-btn ui-btn-primary">
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

  return <FinanceClient initial={data.value} />;
}
