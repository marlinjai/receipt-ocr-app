import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../../../test/db-helpers';
import { ensureContactsLayout } from '../../../../test/contacts-db';
import { companyContacts, contactsDb } from '../db';
import { SharedContactStore } from '../shared-store';
import {
  createDirectoryContact,
  linkPerson,
  listDirectory,
  mergeDirectoryContacts,
} from '../directory';

/**
 * The directory against the real contacts database and the real meal guest rows.
 * Each test works in fresh company and workspace ids; the database is throwaway.
 */

const company = () => `test-dir-${randomUUID()}`;
const workspace = () => `test-ws-${randomUUID()}`;

beforeAll(async () => {
  await ensureContactsLayout();
});

afterAll(async () => {
  await contactsDb().close();
  await db.$disconnect();
});

describe('directory against the real databases', () => {
  it('links a person to an organization and merges a duplicate without changing printed names', async () => {
    const tenant = company();
    const contacts = companyContacts(tenant);
    const store = new SharedContactStore(contacts, db);
    const org = await createDirectoryContact(contacts, { kind: 'organization', name: 'Acme GmbH', legalForm: 'GmbH', city: 'Berlin', country: 'DE' });
    const kept = await store.create({ name: 'Edsger Directory', companyOrRole: 'TU' });
    const dup = await store.create({ name: 'Edsger D.', companyOrRole: 'TU' });
    await linkPerson(contacts, kept.id, org.id);

    const ws = workspace();
    const meal = `row-${randomUUID()}`;
    await db.mealGuest.createMany({
      data: [
        { authWorkspaceId: ws, authTenantId: tenant, rowId: meal, contactId: dup.id, position: 0, displayName: 'Edsger D.', displayCompany: 'TU' },
      ],
    });

    const merged = await mergeDirectoryContacts(contacts, db, dup.id, kept.id);
    expect(merged).toMatchObject({ outcome: 'merged', repointed: 1, deduplicated: 0 });
    const copy = await db.mealGuest.findFirstOrThrow({ where: { rowId: meal } });
    expect(copy).toMatchObject({ contactId: kept.id, displayName: 'Edsger D.' });

    const listed = await listDirectory(contacts);
    expect(listed.find((c) => c.id === kept.id)).toMatchObject({ organizationName: 'Acme GmbH' });
    expect(listed.some((c) => c.id === dup.id)).toBe(false);

    const again = await mergeDirectoryContacts(contacts, db, dup.id, kept.id);
    expect(again).toMatchObject({ outcome: 'already_merged', repointed: 0 });
  });

  it('keeps organizations of one company away from another company', async () => {
    const a = companyContacts(company());
    const b = companyContacts(company());
    const org = await createDirectoryContact(a, { kind: 'organization', name: 'Only A GmbH' });
    expect((await listDirectory(b)).some((c) => c.id === org.id)).toBe(false);
  });
});
