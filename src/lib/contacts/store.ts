/**
 * The contact list behind the business-meal register.
 *
 * THE SEAM. Everything that reads or writes contacts goes through the
 * `ContactStore` interface below. Two implementations exist: the app's own
 * `contacts` table (prisma-store.ts, the default) and the suite's shared
 * contacts database (shared-store.ts, behind the `CONTACTS_STORE=shared`
 * switch). Meals hold a contact id plus a printed copy of name and company,
 * so neither implementation changes meals, rules, register or export.
 *
 * This file is pure (types, validation, errors) and safe to import anywhere.
 */

export interface Contact {
  /** Stable id. Never reused, never derived from the name. */
  id: string;
  name: string;
  /** Company or role, as printed next to the name. Empty string when unknown. */
  companyOrRole: string;
  note: string | null;
  archived: boolean;
}

export interface ContactInput {
  name: string;
  companyOrRole?: string | null;
  note?: string | null;
}

export type ContactErrorCode = 'invalid_name' | 'too_long' | 'duplicate' | 'not_found' | 'stale';

export class ContactError extends Error {
  readonly code: ContactErrorCode;
  /** For `duplicate`: the contact that already carries this name and company. For `stale`: the current record. */
  readonly existing?: Contact;
  constructor(code: ContactErrorCode, existing?: Contact) {
    super(code);
    this.name = 'ContactError';
    this.code = code;
    this.existing = existing;
  }
}

export interface ContactStore {
  /** Active contacts by default, sorted by name; archived ones on request. */
  list(options?: { includeArchived?: boolean }): Promise<Contact[]>;
  /** The given ids that exist for THIS company (archived included). Unknown and foreign ids are simply absent. */
  getMany(ids: string[]): Promise<Contact[]>;
  /** Throws `duplicate` (carrying the existing contact) when name plus company already exists. */
  create(input: ContactInput): Promise<Contact>;
  /** Corrects a contact. The printed copies on existing meals follow the correction. Throws `stale` when the record changed since it was read. */
  update(id: string, input: ContactInput): Promise<Contact>;
  /** Hides the contact from pickers. Meals that already name it keep their guest. */
  archive(id: string): Promise<Contact>;
  restore(id: string): Promise<Contact>;
}

export const CONTACT_NAME_MAX = 120;
export const CONTACT_COMPANY_MAX = 160;
export const CONTACT_NOTE_MAX = 500;

function collapse(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** Trim and validate. Throws ContactError('invalid_name' | 'too_long'). */
export function normalizeContactInput(input: ContactInput): {
  name: string;
  companyOrRole: string;
  note: string | null;
} {
  const name = collapse(String(input.name ?? ''));
  const companyOrRole = collapse(String(input.companyOrRole ?? ''));
  const noteRaw = String(input.note ?? '').trim();
  if (!name) throw new ContactError('invalid_name');
  if (
    name.length > CONTACT_NAME_MAX ||
    companyOrRole.length > CONTACT_COMPANY_MAX ||
    noteRaw.length > CONTACT_NOTE_MAX
  ) {
    throw new ContactError('too_long');
  }
  return { name, companyOrRole, note: noteRaw || null };
}

/** The key two contacts share when they are "the same person" for the duplicate check. */
export function contactIdentityKey(name: string, companyOrRole: string): string {
  return `${collapse(name).toLocaleLowerCase('de-DE')}\u0000${collapse(companyOrRole).toLocaleLowerCase('de-DE')}`;
}

/** How a guest is printed: "Name (Company)" or just "Name". */
export function formatGuest(name: string, company: string): string {
  return company ? `${name} (${company})` : name;
}
