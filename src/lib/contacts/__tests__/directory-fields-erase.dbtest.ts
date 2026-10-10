import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createWorkspace, db, plainMealReceipt } from '../../../../test/db-helpers';
import { ensureContactsLayout } from '../../../../test/contacts-db';
import { companyContacts, contactsDb } from '../db';
import { SharedContactStore } from '../shared-store';
import {
  archiveDirectoryField,
  createDirectoryContact,
  createDirectoryField,
  eraseDirectoryContact,
  linkPerson,
  listDirectory,
  listDirectoryFields,
  previewEraseContact,
  updateDirectoryContact,
} from '../directory';
import { currentRegisterHash } from '../../company-export';
import { RETENTION_YEARS } from '../../erasure';

/**
 * Custom fields, the preferred contact method and the erasure of one contact
 * against the real contacts database (layout 0002) and the real meal guest rows.
 * Each test works in fresh company and workspace ids; the database is throwaway.
 */

const company = () => `test-fld-${randomUUID()}`;
const workspace = () => `test-ws-${randomUUID()}`;

beforeAll(async () => {
  await ensureContactsLayout();
});

afterAll(async () => {
  await contactsDb().close();
  await db.$disconnect();
});

async function guestRow(tenant: string, contactId: string, name: string) {
  const ws = workspace();
  return db.mealGuest.create({
    data: { authWorkspaceId: ws, authTenantId: tenant, rowId: `row-${randomUUID()}`, contactId, position: 0, displayName: name, displayCompany: '' },
  });
}

describe('custom fields and the preferred contact method against the real database', () => {
  it('stores typed values, and an edit of the name keeps them and the contact method', async () => {
    const tenant = company();
    const contacts = companyContacts(tenant);
    await createDirectoryField(contacts, { key: 'diet', label: 'Ernährung', type: 'select', options: ['vegan', 'alles'] });
    await createDirectoryField(contacts, { key: 'seats', label: 'Plätze', type: 'number' });
    const org = await createDirectoryContact(contacts, { kind: 'organization', name: 'Felder GmbH', preferredContact: 'post', customFields: { diet: 'vegan', seats: 12 } });
    const renamed = await updateDirectoryContact(contacts, org.id, { name: 'Felder Holding GmbH' }, org.version);
    expect(renamed).toMatchObject({ name: 'Felder Holding GmbH', preferredContact: 'post', customFields: { diet: 'vegan', seats: 12 } });

    const store = new SharedContactStore(contacts, db);
    const person = await store.create({ name: 'Feld Person', companyOrRole: 'Felder' });
    await updateDirectoryContact(contacts, person.id, { preferredContact: 'email', customFields: { seats: 2 } });
    await store.update(person.id, { name: 'Feld Person Neu', companyOrRole: 'Felder' });
    const listed = (await listDirectory(contacts)).find((c) => c.id === person.id);
    expect(listed).toMatchObject({ name: 'Feld Person Neu', preferredContact: 'email', customFields: { seats: 2 } });
  });

  it('refuses a wrong value and an unknown key by name, keeps a company apart, and archives without losing values', async () => {
    const tenant = company();
    const contacts = companyContacts(tenant);
    const other = companyContacts(company());
    await createDirectoryField(contacts, { key: 'since', label: 'Kunde seit', type: 'date' });
    const org = await createDirectoryContact(contacts, { kind: 'organization', name: 'Datum GmbH', customFields: { since: '2026-02-28' } });
    await expect(updateDirectoryContact(contacts, org.id, { customFields: { since: '2026-02-30' } })).rejects.toMatchObject({ code: 'invalid_value', field: 'since' });
    await expect(updateDirectoryContact(contacts, org.id, { customFields: { nope: 'x' } })).rejects.toMatchObject({ code: 'unknown_field', field: 'nope' });
    expect(await listDirectoryFields(other)).toEqual([]);
    await archiveDirectoryField(contacts, 'since');
    await expect(updateDirectoryContact(contacts, org.id, { customFields: { since: '2026-03-01' } })).rejects.toMatchObject({ code: 'field_archived', field: 'since' });
    expect((await listDirectory(contacts))[0].customFields).toEqual({ since: '2026-02-28' });
    await expect(createDirectoryField(contacts, { key: 'since', label: 'Nochmal', type: 'date' })).rejects.toMatchObject({ code: 'duplicate_field' });
  });
});

describe('erasing one contact against the real databases', () => {
  it('without an export: the contact goes, the printed name is held ten years with the link cleared, and a repeat changes nothing', async () => {
    const tenant = company();
    const contacts = companyContacts(tenant);
    const store = new SharedContactStore(contacts, db);
    const gone = await store.create({ name: 'Wird Gelöscht' });
    const kept = await store.create({ name: 'Bleibt Bestehen' });
    const g1 = await guestRow(tenant, gone.id, 'Wird Gelöscht');
    const g2 = await guestRow(tenant, kept.id, 'Bleibt Bestehen');

    const scope = [g1.authWorkspaceId, g2.authWorkspaceId];
    await expect(previewEraseContact(contacts, db, gone.id, scope)).resolves.toEqual({ exists: true, meals: 1, printedNames: 'held', coverage: 'no_export', linkedPersons: 0 });
    const now = new Date('2026-10-10T00:00:00Z');
    await expect(eraseDirectoryContact(contacts, db, gone.id, scope, now)).resolves.toEqual({ outcome: 'erased', printedNamesRemoved: 0, printedNamesHeld: 1, coverage: 'no_export' });

    const held = await db.mealGuest.findUniqueOrThrow({ where: { id: g1.id } });
    expect(held).toMatchObject({ contactId: null, displayName: 'Wird Gelöscht' });
    expect(held.retainUntil!.getUTCFullYear()).toBe(now.getUTCFullYear() + RETENTION_YEARS);
    expect(await db.mealGuest.findUniqueOrThrow({ where: { id: g2.id } })).toMatchObject({ contactId: kept.id, retainUntil: null });
    expect((await store.list({ includeArchived: true })).map((c) => c.id)).toEqual([kept.id]);

    await expect(eraseDirectoryContact(contacts, db, gone.id, scope, new Date('2027-01-01T00:00:00Z'))).resolves.toMatchObject({ outcome: 'already_erased', printedNamesHeld: 0 });
    expect((await db.mealGuest.findUniqueOrThrow({ where: { id: g1.id } })).retainUntil).toEqual(held.retainUntil);
  });

  it('with an export identical to the register: the printed name is removed; after a correction it is held', async () => {
    // A real workspace with a Receipts table, so the register is the real one.
    const ws = await createWorkspace();
    const contacts = companyContacts(ws.tenantId);
    const store = new SharedContactStore(contacts, db);
    const scope = [ws.workspaceId];
    const onMeal = async (contactId: string, name: string) => {
      const rowId = await ws.addReceipt(plainMealReceipt());
      return db.mealGuest.create({
        data: { authWorkspaceId: ws.workspaceId, authTenantId: ws.tenantId, rowId, contactId, position: 0, displayName: name, displayCompany: '' },
      });
    };
    const first = await store.create({ name: 'Mit Export' });
    const second = await store.create({ name: 'Nach Korrektur' });
    const g1 = await onMeal(first.id, 'Mit Export');
    const g2 = await onMeal(second.id, 'Nach Korrektur');
    await db.companyExport.create({
      data: { authTenantId: ws.tenantId, fileCount: 3, sha256: 'test', registerSha256: await currentRegisterHash(db, scope) },
    });

    await expect(previewEraseContact(contacts, db, first.id, scope)).resolves.toMatchObject({ meals: 1, printedNames: 'removed', coverage: 'identical' });
    await expect(eraseDirectoryContact(contacts, db, first.id, scope)).resolves.toEqual({ outcome: 'erased', printedNamesRemoved: 1, printedNamesHeld: 0, coverage: 'identical' });
    expect(await db.mealGuest.findUnique({ where: { id: g1.id } })).toBeNull();

    // The removal changed the register, so the same export no longer covers the next erase.
    await expect(previewEraseContact(contacts, db, second.id, scope)).resolves.toMatchObject({ printedNames: 'held', coverage: 'changed' });
    await expect(eraseDirectoryContact(contacts, db, second.id, scope)).resolves.toMatchObject({ printedNamesRemoved: 0, printedNamesHeld: 1, coverage: 'changed' });
    expect(await db.mealGuest.findUniqueOrThrow({ where: { id: g2.id } })).toMatchObject({ contactId: null, displayName: 'Nach Korrektur' });
  });

  it('never touches the meals of another company, and an erased organization leaves its persons, unlinked', async () => {
    const tenant = company();
    const contacts = companyContacts(tenant);
    const otherTenant = company();
    const other = companyContacts(otherTenant);
    const foreign = await new SharedContactStore(other, db).create({ name: 'Fremde Person' });
    const foreignRow = await guestRow(otherTenant, foreign.id, 'Fremde Person');
    await expect(eraseDirectoryContact(contacts, db, foreign.id, [foreignRow.authWorkspaceId])).resolves.toMatchObject({ outcome: 'already_erased' });
    expect(await db.mealGuest.findUniqueOrThrow({ where: { id: foreignRow.id } })).toMatchObject({ contactId: foreign.id, retainUntil: null });
    expect((await other.get(foreign.id))?.id).toBe(foreign.id);

    const org = await createDirectoryContact(contacts, { kind: 'organization', name: 'Geht Weg GmbH' });
    const store = new SharedContactStore(contacts, db);
    const a = await store.create({ name: 'Person Eins' });
    const b = await store.create({ name: 'Person Zwei' });
    await linkPerson(contacts, a.id, org.id);
    await linkPerson(contacts, b.id, org.id);
    await expect(previewEraseContact(contacts, db, org.id, [])).resolves.toMatchObject({ linkedPersons: 2 });
    await eraseDirectoryContact(contacts, db, org.id, []);
    const people = (await listDirectory(contacts)).filter((c) => c.kind === 'person');
    expect(people.map((p) => p.organizationId)).toEqual([null, null]);
    expect(people).toHaveLength(2);
  });
});
