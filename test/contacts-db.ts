import { createContactsDb, migrate } from '@marlinjai/contacts-core';

/**
 * The throwaway contacts database for the database tests. Applies the package's
 * layout (the same migrations an app applies at start), so each test starts from
 * the layout the code expects. Idempotent: a layout already applied is left alone.
 */
export async function ensureContactsLayout(): Promise<void> {
  const url = process.env.CONTACTS_TEST_DATABASE_URL;
  if (!url) throw new Error('CONTACTS_TEST_DATABASE_URL is not set (see test/db-setup.ts)');
  const handle = createContactsDb(url, { applicationName: 'receipts-test', max: 2 });
  try {
    await migrate(handle.sql, { log: () => {} });
  } finally {
    await handle.close();
  }
}
