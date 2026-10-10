import 'server-only';
import { contactsFor, createContactsDb, type Contacts, type ContactsDb } from '@marlinjai/contacts-core';

/**
 * Thrown when the shared contacts database is not configured. There is no other
 * contact store to fall back to, so this must surface, never be swallowed.
 */
export class ContactsNotConfiguredError extends Error {
  constructor() {
    super('CONTACTS_DATABASE_URL is not set: the shared contacts database is the only contact store');
    this.name = 'ContactsNotConfiguredError';
  }
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
  if (!url) throw new ContactsNotConfiguredError();
  const handle = createContactsDb(url, { applicationName: 'receipts' });
  globalForContacts.contactsDb = handle;
  return handle;
}

/** The contacts of one company. Every call made through it carries that company's id. */
export function companyContacts(tenantId: string): Contacts {
  return contactsFor(contactsDb(), tenantId);
}
