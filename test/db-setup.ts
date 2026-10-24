import { assertThrowawayUrl } from './db-guard';

/**
 * Setup of every test file of `pnpm test:db`. Fails loudly when a test database is not configured, and
 * refuses anything but a local throwaway database (see test/db-guard.ts). The databases were emptied once
 * before the run (test/db-reset.ts, the global setup).
 *
 * Two throwaway databases are needed: the receipts app's own (TEST_DATABASE_URL)
 * and the suite's contacts database (CONTACTS_TEST_DATABASE_URL, same guard).
 */
// Every client of the run connects with the URL the guard rebuilt, never with the one that was passed in.
const receipts = assertThrowawayUrl('TEST_DATABASE_URL', process.env.TEST_DATABASE_URL);
process.env.TEST_DATABASE_URL = receipts.url;
process.env.DATABASE_URL = receipts.url;

// The shared contacts client reads this when a test first opens it.
const contacts = assertThrowawayUrl('CONTACTS_TEST_DATABASE_URL', process.env.CONTACTS_TEST_DATABASE_URL);
process.env.CONTACTS_TEST_DATABASE_URL = contacts.url;
process.env.CONTACTS_DATABASE_URL = contacts.url;

// The shared contacts database is the app's only contact store, so every database
// test that touches a guest needs its layout. Applying it is idempotent under a lock.
const { ensureContactsLayout } = await import('./contacts-db');
await ensureContactsLayout();

// Top-level await needs this file to be a module.
export {};
