import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../../test/db-helpers';
import { ensureContactsLayout } from '../../../test/contacts-db';
import { companyContacts, contactsDb } from '../contacts/db';
import { SharedContactStore } from '../contacts/shared-store';
import { eraseCompanyContacts } from '../erasure';

/**
 * Company erasure against the real receipts tables and the real contacts
 * database: one company goes, the other stays, and a repeat finds nothing.
 */

beforeAll(async () => {
  await ensureContactsLayout();
});

afterAll(async () => {
  await contactsDb().close();
  await db.$disconnect();
});

describe('eraseCompanyContacts against the real databases', () => {
  it('erases one company, leaves the other, and a repeat removes nothing more', async () => {
    const doomed = `test-er-${randomUUID()}`;
    const kept = `test-er-${randomUUID()}`;
    const wsDoomed = `test-ws-${randomUUID()}`;
    const wsKept = `test-ws-${randomUUID()}`;
    const doomedStore = new SharedContactStore(companyContacts(doomed), db);
    const keptStore = new SharedContactStore(companyContacts(kept), db);
    const doomedContact = await doomedStore.create({ name: 'Doomed Person' });
    const keptContact = await keptStore.create({ name: 'Kept Person' });
    await db.mealGuest.createMany({
      data: [
        { authWorkspaceId: wsDoomed, authTenantId: null, rowId: `row-${randomUUID()}`, contactId: doomedContact.id, position: 0, displayName: 'Doomed Person', displayCompany: '' },
        { authWorkspaceId: wsKept, authTenantId: kept, rowId: `row-${randomUUID()}`, contactId: keptContact.id, position: 0, displayName: 'Kept Person', displayCompany: '' },
      ],
    });

    const first = await eraseCompanyContacts(db, doomed, [wsDoomed]);
    expect(first).toMatchObject({ sharedContacts: 1 });
    expect(first.guestCopies).toBeGreaterThanOrEqual(1);
    expect(await doomedStore.list({ includeArchived: true })).toEqual([]);
    expect((await keptStore.list()).map((c) => c.name)).toEqual(['Kept Person']);
    expect(await db.mealGuest.count({ where: { authWorkspaceId: wsKept } })).toBe(1);

    const second = await eraseCompanyContacts(db, doomed, [wsDoomed]);
    expect(second).toEqual({ guestCopies: 0, ownContacts: 0, sharedContacts: 0 });
  });
});
