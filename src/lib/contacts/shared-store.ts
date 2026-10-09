import 'server-only';
import type { PrismaClient } from '@prisma/client';
import {
  ContactError as SharedContactError,
  type Contact as SharedContact,
  type Contacts,
} from '@marlinjai/contacts-core';
import { ContactError, normalizeContactInput, type Contact, type ContactInput, type ContactStore } from './store';

function toContact(c: SharedContact): Contact {
  return { id: c.id, name: c.name, companyOrRole: c.companyOrRole, note: c.note, archived: c.archived };
}

/**
 * Translate a shared-package error into the receipts app's own error, so the
 * server actions and their wording keep working unchanged. Anything else is
 * rethrown as it is and surfaces as a failure, never as a silent success.
 */
function translate(e: unknown): never {
  if (e instanceof SharedContactError) {
    switch (e.code) {
      case 'duplicate':
        throw new ContactError('duplicate', e.existing ? toContact(e.existing) : undefined);
      case 'stale':
        throw new ContactError('stale', e.existing ? toContact(e.existing) : undefined);
      case 'not_found':
        throw new ContactError('not_found');
      case 'too_long':
        throw new ContactError('too_long');
      case 'invalid_name':
        throw new ContactError('invalid_name');
    }
  }
  throw e;
}

/**
 * The company's contact list in the suite's shared contacts database.
 *
 * An instance is bound to ONE company. The package's `Contacts` object carries
 * that company id on every query, so an id from another company behaves exactly
 * like an id that does not exist.
 *
 * `db` is the receipts Prisma client, needed only for the printed copies of
 * the names on meals (`meal_guests`). Those live in this app's database, so a
 * correction has two steps; see `update`.
 */
export class SharedContactStore implements ContactStore {
  constructor(
    private readonly contacts: Contacts,
    private readonly db: PrismaClient,
  ) {}

  /** Guests are persons. Organizations belong to the contacts screen, not the meal picker. */
  private async requirePerson(id: string): Promise<SharedContact> {
    const row = await this.contacts.get(id);
    if (!row || row.kind !== 'person') throw new ContactError('not_found');
    return row;
  }

  /**
   * Active contacts by default. Each list also brings the printed copies on
   * meals back in line with the contacts (see `reconcileGuestCopies`), so a
   * correction whose second step failed is repaired the next time the list opens.
   */
  async list(options: { includeArchived?: boolean } = {}): Promise<Contact[]> {
    const rows = await this.contacts.list({ kind: 'person', includeArchived: options.includeArchived === true });
    const contacts = rows.map(toContact);
    await reconcileGuestCopies(this.db, contacts);
    return contacts;
  }

  async getMany(ids: string[]): Promise<Contact[]> {
    const unique = [...new Set(ids)];
    if (unique.length === 0) return [];
    const rows = await this.contacts.getMany(unique);
    return rows.filter((row) => row.kind === 'person').map(toContact);
  }

  async create(input: ContactInput): Promise<Contact> {
    const data = normalizeContactInput(input);
    try {
      const row = await this.contacts.create({
        kind: 'person',
        name: data.name,
        companyOrRole: data.companyOrRole,
        note: data.note,
      });
      return toContact(row);
    } catch (e) {
      return translate(e);
    }
  }

  /**
   * A correction is two writes, because the contact lives in the shared
   * database and the printed copies live in this app's database. No transaction
   * spans both.
   *
   * 1. The contact is corrected. The package's `update` writes EVERY column, so
   *    the fields this app does not edit are carried over from the record just
   *    read (email, phone, address and so on, possibly written by another app).
   *    The version check refuses the save when the record changed in between.
   * 2. The printed copies on meals are corrected in every workspace of the
   *    company. They are keyed by contact id alone: the id is globally unique,
   *    and step 1 has already proven it belongs to this company. Keying on
   *    the company column would skip rows written before it was filled.
   *
   * If step 2 fails, the save fails and nothing is reported as saved. Saving
   * again is the retry, and the list reconciles any copy that still differs.
   */
  async update(id: string, input: ContactInput): Promise<Contact> {
    const data = normalizeContactInput(input);
    const current = await this.requirePerson(id);
    let updated: SharedContact;
    try {
      updated = await this.contacts.update(
        id,
        {
          kind: 'person',
          name: data.name,
          companyOrRole: data.companyOrRole,
          note: data.note,
          organizationId: current.organizationId,
          email: current.email,
          phone: current.phone,
          legalForm: current.legalForm,
          addressLine1: current.addressLine1,
          addressLine2: current.addressLine2,
          postalCode: current.postalCode,
          city: current.city,
          country: current.country,
          vatId: current.vatId,
        },
        { expectedVersion: current.version },
      );
    } catch (e) {
      return translate(e);
    }
    await this.db.mealGuest.updateMany({
      where: { contactId: id },
      data: { displayName: updated.name, displayCompany: updated.companyOrRole },
    });
    return toContact(updated);
  }

  async archive(id: string): Promise<Contact> {
    await this.requirePerson(id);
    try {
      return toContact(await this.contacts.archive(id));
    } catch (e) {
      return translate(e);
    }
  }

  async restore(id: string): Promise<Contact> {
    await this.requirePerson(id);
    try {
      return toContact(await this.contacts.restore(id));
    } catch (e) {
      return translate(e);
    }
  }
}

/**
 * Bring the printed copies on meals in line with the contacts they name.
 *
 * Only copies that differ are written. Returns how many contacts were brought
 * in line, and the log line carries that count only, never a name.
 */
export async function reconcileGuestCopies(db: PrismaClient, contacts: Contact[]): Promise<number> {
  if (contacts.length === 0) return 0;
  const byId = new Map(contacts.map((c) => [c.id, c]));
  const copies = await db.mealGuest.findMany({
    where: { contactId: { in: [...byId.keys()] } },
    select: { contactId: true, displayName: true, displayCompany: true },
    distinct: ['contactId', 'displayName', 'displayCompany'],
  });
  const drifted = new Set<string>();
  for (const copy of copies) {
    const contact = byId.get(copy.contactId);
    if (!contact) continue;
    if (copy.displayName !== contact.name || copy.displayCompany !== contact.companyOrRole) {
      drifted.add(contact.id);
    }
  }
  for (const id of drifted) {
    const contact = byId.get(id)!;
    await db.mealGuest.updateMany({
      where: { contactId: id },
      data: { displayName: contact.name, displayCompany: contact.companyOrRole },
    });
  }
  if (drifted.size > 0) console.log(`[contacts] brought ${drifted.size} printed guest copies in line with their contacts`);
  return drifted.size;
}
