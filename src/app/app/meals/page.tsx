import Link from 'next/link';
import { auth } from '@/lib/auth';
import { getMealsPageData } from './actions';
import MealsClient from './MealsClient';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Bewirtungsverzeichnis' };

export default async function MealsPage() {
  await auth.requireSession('/app/meals');
  const data = await getMealsPageData();

  if (!data.ok) {
    return (
      <main className="relative z-10 flex min-h-svh items-center justify-center px-4 py-16">
        <div className="glass-panel max-w-md rounded-xl p-6 text-center">
          <h1 className="text-lg font-semibold" style={{ color: 'var(--foreground)' }}>
            Das Bewirtungsverzeichnis konnte nicht geladen werden
          </h1>
          <p className="mt-2 text-sm" style={{ color: 'var(--muted)' }}>
            {data.error === 'unauthorized' || data.error === 'forbidden'
              ? 'Für diesen Arbeitsbereich fehlt der Zugriff. Bitte neu anmelden oder den Arbeitsbereich wechseln.'
              : 'Beim Laden ist ein Fehler aufgetreten. Bitte die Seite neu laden.'}
          </p>
          <div className="mt-4 flex justify-center gap-2">
            <Link href="/app/meals" className="ui-btn ui-btn-primary">
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

  return <MealsClient initial={data.value} />;
}
