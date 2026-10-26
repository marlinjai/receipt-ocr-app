import Link from 'next/link';
import { auth } from '@/lib/auth';
import { getStatement } from './actions';
import { getBankView } from './bank-actions';
import { getSharingView } from './sharing-actions';
import { getOwnNamesView } from './own-names-actions';
import { tabFromAddress } from './tabs';
import FinanceClient from './FinanceClient';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Finanzen' };

export default async function FinancePage({ searchParams }: { searchParams: Promise<{ jahr?: string; reiter?: string; bank?: string }> }) {
  await auth.requireSession('/app/finance');
  const { jahr, reiter, bank } = await searchParams;
  const [data, bankView, sharing, ownNames] = await Promise.all([
    getStatement(jahr ? Number(jahr) : new Date().getFullYear()),
    getBankView(),
    getSharingView(),
    getOwnNamesView(),
  ]);

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

  // `?reiter=` opens its tab, values from before the groups included; the return from the bank
  // (`/api/banking/callback`, `?bank=`) opens the accounts under Einstellungen with its outcome.
  return (
    <FinanceClient
      initial={data.value}
      initialTab={tabFromAddress(reiter, typeof bank === 'string')}
      bank={bankView.ok ? bankView.value : null}
      bankReturn={typeof bank === 'string' ? bank.slice(0, 80) : null}
      sharing={sharing.ok ? sharing.value : null}
      sharingFailed={!sharing.ok}
      ownNames={ownNames.ok ? ownNames.value : null}
    />
  );
}
