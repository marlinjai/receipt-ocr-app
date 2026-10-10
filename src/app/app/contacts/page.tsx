import Link from 'next/link';
import { auth } from '@/lib/auth';
import { listDirectoryAction, listFieldsAction } from './actions';
import ContactsClient from './ContactsClient';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Kontakte' };

export default async function ContactsPage() {
  await auth.requireSession('/app/contacts');
  // Archived contacts are loaded too: the page filters one list, it never loads a second one.
  const [contacts, fields] = await Promise.all([listDirectoryAction(true), listFieldsAction()]);

  if (!contacts.ok || !fields.ok) {
    const error = !contacts.ok ? contacts.error : !fields.ok ? fields.error : 'failed';
    return (
      <main className="relative z-10 flex min-h-svh items-center justify-center px-4 py-16">
        <div className="glass-panel max-w-md rounded-xl p-6 text-center">
          <h1 className="text-lg font-semibold" style={{ color: 'var(--foreground)' }}>
            Die Kontakte konnten nicht geladen werden
          </h1>
          <p className="mt-2 text-sm" style={{ color: 'var(--muted)' }}>
            {error === 'unauthorized' || error === 'forbidden'
              ? 'Für diesen Arbeitsbereich fehlt der Zugriff. Bitte neu anmelden oder den Arbeitsbereich wechseln.'
              : 'Beim Laden ist ein Fehler aufgetreten. Bitte die Seite neu laden.'}
          </p>
          <div className="mt-4 flex justify-center gap-2">
            <Link href="/app/contacts" className="ui-btn ui-btn-primary">
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

  return <ContactsClient initial={{ contacts: contacts.value, fields: fields.value }} />;
}
