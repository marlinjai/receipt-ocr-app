import { assertThrowawayUrl } from './db-guard';
import { emptyDatabase } from './db-reset';
import { currentWorker, withConnectionLimit, workerDatabase } from './db-workers';

/**
 * Setup of every test file of `pnpm test:db`. Fails loudly when a test database is not configured, and
 * refuses anything but a local throwaway database (see test/db-guard.ts).
 *
 * Two throwaway databases are needed: the receipts app's own (TEST_DATABASE_URL)
 * and the suite's contacts database (CONTACTS_TEST_DATABASE_URL, same guard).
 *
 * The file runs in its worker's copy of each (test/db-workers.ts), and empties both copies first: a file
 * meets only what it creates itself, so it passes in any order and its time does not depend on the files
 * that ran before it in the same worker.
 */
const worker = currentWorker();
const receipts = workerDatabase('TEST_DATABASE_URL', assertThrowawayUrl('TEST_DATABASE_URL', process.env.TEST_DATABASE_URL), worker);
const contacts = workerDatabase(
  'CONTACTS_TEST_DATABASE_URL',
  assertThrowawayUrl('CONTACTS_TEST_DATABASE_URL', process.env.CONTACTS_TEST_DATABASE_URL),
  worker,
);

// The copies were made from the migrated, emptied originals by the global setup (test/db-reset.ts); the layouts
// stay, only rows and the per-workspace tables of the file before go.
await emptyDatabase(receipts, 'TEST_DATABASE_URL', { dropWorkspaceTables: true, requireMigrations: '_prisma_migrations' });
await emptyDatabase(contacts, 'CONTACTS_TEST_DATABASE_URL', { dropWorkspaceTables: false, requireMigrations: null });

// Every client of the file connects to the worker's copy with the URL the guard rebuilt, never with the one passed in.
process.env.TEST_DATABASE_URL = receipts.url;
// The app's own Prisma client (src/lib/prisma.ts) reads this one; the ceiling keeps the workers within the server's limit.
process.env.DATABASE_URL = withConnectionLimit(receipts.url);
// The shared contacts client reads this when a test first opens it.
process.env.CONTACTS_TEST_DATABASE_URL = contacts.url;
process.env.CONTACTS_DATABASE_URL = contacts.url;

// Top-level await needs this file to be a module.
export {};
