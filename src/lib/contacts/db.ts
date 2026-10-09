import 'server-only';
import { contactsFor, createContactsDb, type Contacts, type ContactsDb } from '@marlinjai/contacts-core';

/**
 * Whether this process uses the suite's shared contacts database.
 *
 * Off unless `CONTACTS_STORE=shared`. The URL alone never selects the shared
 * store: `CONTACTS_DATABASE_URL` already sits in the production secret project,
 * and switching to an empty database before the data move has run would show
 * an empty guest list. The flip is a deliberate second step (see the plan,
 * docs/plans/2026-10-09-shared-contacts-wave2.md).
 */
export function sharedContactsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CONTACTS_STORE?.trim() === 'shared';
}

const globalForContacts = globalThis as unknown as { contactsDb?: ContactsDb };

/**
 * The one connection handle of this process. Nothing connects until the first
 * query, and the pool is kept small because the database is shared by apps.
 * Cached on globalThis so hot reloads in development do not open new pools.
 */
export function contactsDb(): ContactsDb {
  if (globalForContacts.contactsDb) return globalForContacts.contactsDb;
  const url = process.env.CONTACTS_DATABASE_URL?.trim();
  if (!url) throw new Error('CONTACTS_DATABASE_URL is not set, but CONTACTS_STORE=shared');
  const handle = createContactsDb(url, { applicationName: 'receipts' });
  globalForContacts.contactsDb = handle;
  return handle;
}

/** The contacts of one company. Every call made through it carries that company's id. */
export function companyContacts(tenantId: string): Contacts {
  return contactsFor(contactsDb(), tenantId);
}
