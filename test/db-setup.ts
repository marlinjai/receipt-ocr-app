/**
 * Setup for `pnpm test:db`. Fails loudly when a test database is not configured,
 * and refuses anything that does not look like a local throwaway database.
 *
 * Two throwaway databases are needed: the receipts app's own (TEST_DATABASE_URL)
 * and the suite's contacts database (CONTACTS_TEST_DATABASE_URL, same guard).
 */
function localUrl(name: string): string {
  const url = process.env[name];
  if (!url) {
    throw new Error(
      `${name} is not set. The database tests need a throwaway Postgres for this (see test/db-setup.ts). ` +
        'They never run against a shared database.',
    );
  }
  const host = new URL(url).hostname;
  if (host !== '127.0.0.1' && host !== 'localhost') {
    throw new Error(`${name} must point at a local database, got host "${host}".`);
  }
  return url;
}

const receiptsUrl = localUrl('TEST_DATABASE_URL');
process.env.DATABASE_URL = receiptsUrl;

// The shared contacts client reads this when a test first opens it.
process.env.CONTACTS_DATABASE_URL = localUrl('CONTACTS_TEST_DATABASE_URL');

// The shared contacts database is the app's only contact store, so every database
// test that touches a guest needs its layout. Applying it is idempotent under a lock.
const { ensureContactsLayout } = await import('./contacts-db');
await ensureContactsLayout();
