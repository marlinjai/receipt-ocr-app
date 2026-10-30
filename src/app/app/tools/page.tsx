import Link from 'next/link';
import { auth } from '@/lib/auth';
import FxRecomputePanel from './FxRecomputePanel';
import InvoiceNumbersPanel from './InvoiceNumbersPanel';
import LinesBackfillPanel from './LinesBackfillPanel';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Werkzeuge' };

const SECTION = 'glass-panel rounded-xl p-4';
const HEADING = 'mb-2 text-base font-semibold';

/** The jobs that keep the data in order: run now and then, not part of daily work. */
export default async function ToolsPage() {
  await auth.requireSession('/app/tools');
  return (
    <main className="ui-touch relative z-10 mx-auto w-full max-w-3xl px-4 py-10">
      <h1 className="mb-6 text-2xl font-bold" style={{ color: 'var(--foreground)' }}>
        Werkzeuge
      </h1>
      <div className="space-y-4">
        <section className={SECTION} aria-labelledby="tool-import">
          <h2 id="tool-import" className={HEADING} style={{ color: 'var(--foreground)' }}>Aus Google Sheets importieren</h2>
          <p className="mb-3 text-sm" style={{ color: 'var(--dt-text-secondary)' }}>Übernimmt Belege aus einer Tabelle in diese Firma.</p>
          <Link href="/app/import" className="ui-btn ui-btn-primary">Import öffnen</Link>
        </section>
        <section className={SECTION} aria-labelledby="tool-fx">
          <h2 id="tool-fx" className={HEADING} style={{ color: 'var(--foreground)' }}>Wechselkurse neu berechnen</h2>
          <FxRecomputePanel />
        </section>
        <section className={SECTION} aria-labelledby="tool-lines">
          <h2 id="tool-lines" className={HEADING} style={{ color: 'var(--foreground)' }}>Positionen lesen</h2>
          <LinesBackfillPanel />
        </section>
        <section className={SECTION} aria-labelledby="tool-numbers">
          <h2 id="tool-numbers" className={HEADING} style={{ color: 'var(--foreground)' }}>Rechnungsnummern lesen</h2>
          <InvoiceNumbersPanel />
        </section>
      </div>
    </main>
  );
}
