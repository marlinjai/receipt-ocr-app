import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../../../test/db-helpers';
import { ensureContactsLayout } from '../../../../test/contacts-db';
import { companyContacts, contactsDb } from '../db';
import { SharedContactStore, reconcileGuestCopies } from '../shared-store';

/**
 * The shared contact store against a real contacts database and the real meal
 * guest table. Every test works in freshly generated company and workspace ids,
 * so runs do not collide, and nothing is cleaned up afterwards (the database is
 * throwaway, see test/db-setup.ts).
 */

const company = () => `test-tnt-${randomUUID()}`;
const workspace = () => `test-ws-${randomUUID()}`;

function storeFor(tenantId: string) {
  return new SharedContactStore(companyContacts(tenantId), db);
}

beforeAll(async () => {
  await ensureContactsLayout();
});

afterAll(async () => {
  await contactsDb().close();
  await db.$disconnect();
});

describe('SharedContactStore against the contacts database', () => {
  it('never shows a company the contacts of another company', async () => {
    const a = storeFor(company());
    const b = storeFor(company());
    const ada = await a.create({ name: 'Ada Isolation' });
    expect((await b.list({ includeArchived: true })).map((c) => c.id)).not.toContain(ada.id);
    expect(await b.getMany([ada.id])).toEqual([]);
    await expect(b.archive(ada.id)).rejects.toMatchObject({ code: 'not_found' });
  });

  it('a guest picked and created in one workspace is the same contact in another', async () => {
    const tenant = company();
    const store = storeFor(tenant);
    const grace = await store.create({ name: 'Grace Hopper', companyOrRole: 'Navy' });
    const ws1 = workspace();
    const ws2 = workspace();
    await db.mealGuest.createMany({
      data: [
        { authWorkspaceId: ws1, authTenantId: tenant, rowId: `row-${ws1}`, contactId: grace.id, position: 0, displayName: 'Grace Hopper', displayCompany: 'Navy' },
        // A guest row written before the company was filled: still followed by id.
        { authWorkspaceId: ws2, authTenantId: null, rowId: `row-${ws2}`, contactId: grace.id, position: 0, displayName: 'Grace Hopper', displayCompany: 'Navy' },
      ],
    });
    expect((await store.getMany([grace.id]))[0]).toMatchObject({ name: 'Grace Hopper' });
    expect((await store.list()).map((c) => c.id)).toContain(grace.id);
  });

  it('a correction shows on the meals of both workspaces, and saving it again changes nothing', async () => {
    const tenant = company();
    const store = storeFor(tenant);
    const contact = await store.create({ name: 'Edsger Dijkstra', companyOrRole: 'TU' });
    const ws1 = workspace();
    const ws2 = workspace();
    await db.mealGuest.createMany({
      data: [
        { authWorkspaceId: ws1, authTenantId: tenant, rowId: `row-${ws1}`, contactId: contact.id, position: 0, displayName: 'Edsger Dijkstra', displayCompany: 'TU' },
        { authWorkspaceId: ws2, authTenantId: tenant, rowId: `row-${ws2}`, contactId: contact.id, position: 0, displayName: 'Edsger Dijkstra', displayCompany: 'TU' },
      ],
    });

    await store.update(contact.id, { name: 'Edsger W. Dijkstra', companyOrRole: 'Univ. Texas' });
    const copies = await db.mealGuest.findMany({ where: { contactId: contact.id } });
    expect(copies.map((c) => [c.displayName, c.displayCompany])).toEqual([
      ['Edsger W. Dijkstra', 'Univ. Texas'],
      ['Edsger W. Dijkstra', 'Univ. Texas'],
    ]);

    // Re-entry: the same save again is accepted and leaves the same state.
    await expect(store.update(contact.id, { name: 'Edsger W. Dijkstra', companyOrRole: 'Univ. Texas' })).resolves.toMatchObject({
      name: 'Edsger W. Dijkstra',
    });
  });

  it('a list repairs printed copies that drifted (a correction whose second step failed)', async () => {
    const tenant = company();
    const store = storeFor(tenant);
    const contact = await store.create({ name: 'Barbara Liskov', companyOrRole: 'MIT' });
    const ws = workspace();
    await db.mealGuest.create({
      data: { authWorkspaceId: ws, authTenantId: tenant, rowId: `row-${ws}`, contactId: contact.id, position: 0, displayName: 'B. Liskov (old)', displayCompany: '' },
    });
    await store.list();
    const copy = await db.mealGuest.findFirstOrThrow({ where: { contactId: contact.id } });
    expect(copy).toMatchObject({ displayName: 'Barbara Liskov', displayCompany: 'MIT' });
    expect(await reconcileGuestCopies(db, await store.list())).toBe(0);
  });
});
