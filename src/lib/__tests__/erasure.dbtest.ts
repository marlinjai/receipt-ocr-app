import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../../test/db-helpers';
import { ensureContactsLayout } from '../../../test/contacts-db';
import { companyContacts, contactsDb } from '../contacts/db';
import { SharedContactStore } from '../contacts/shared-store';
import { eraseCompanyContacts, purgeExpiredRetainedGuests } from '../erasure';

/**
 * Company erasure against the real receipts tables and the real contacts
 * database. Covers the hold (no export on record), repeat runs, the export
 * branch and the purge.
 */

beforeAll(async () => {
  await ensureContactsLayout();
});

afterAll(async () => {
  await contactsDb().close();
  await db.$disconnect();
});

async function scenario() {
  const tenant = `test-er-${randomUUID()}`;
  const ws = `test-ws-${randomUUID()}`;
  const store = new SharedContactStore(companyContacts(tenant), db);
  const contact = await store.create({ name: `Held ${randomUUID().slice(0, 8)}` });
  const rowId = `row-${randomUUID()}`;
  await db.mealGuest.create({
    data: { authWorkspaceId: ws, authTenantId: tenant, rowId, contactId: contact.id, position: 0, displayName: 'Printed Name', displayCompany: 'Printed Co' },
  });
  return { tenant, ws, rowId, contactId: contact.id, store };
}

describe('eraseCompanyContacts against the real databases', () => {
  it('without an export: the contact goes, the printed copy is held for ten years, and a repeat does not move the date', async () => {
    const f = await scenario();
    const now = new Date('2026-10-09T10:00:00Z');
    const first = await eraseCompanyContacts(db, f.tenant, [f.ws], now);
    expect(first).toMatchObject({ guestCopies: 0, guestCopiesHeld: 1, sharedContacts: 1 });
    expect(await f.store.list({ includeArchived: true })).toEqual([]);

    const held = await db.mealGuest.findFirstOrThrow({ where: { rowId: f.rowId } });
    expect(held).toMatchObject({ contactId: null, displayName: 'Printed Name', displayCompany: 'Printed Co' });
    expect(held.retainUntil?.toISOString()).toBe('2036-10-09T10:00:00.000Z');

    const later = new Date('2027-03-01T00:00:00Z');
    const second = await eraseCompanyContacts(db, f.tenant, [f.ws], later);
    expect(second).toMatchObject({ guestCopies: 0, guestCopiesHeld: 0 });
    const still = await db.mealGuest.findFirstOrThrow({ where: { rowId: f.rowId } });
    expect(still.retainUntil?.toISOString()).toBe('2036-10-09T10:00:00.000Z');
  });

  it('with an export on record: the printed copy is removed now', async () => {
    const f = await scenario();
    await db.companyExport.create({ data: { authTenantId: f.tenant, fileCount: 3, sha256: 'a'.repeat(64) } });
    const counts = await eraseCompanyContacts(db, f.tenant, [f.ws]);
    expect(counts).toMatchObject({ guestCopies: 1, guestCopiesHeld: 0 });
    expect(await db.mealGuest.count({ where: { rowId: f.rowId } })).toBe(0);
  });

  it('the purge removes only held copies past their date, never a copy still linked to a contact', async () => {
    const f = await scenario();
    await eraseCompanyContacts(db, f.tenant, [f.ws], new Date('2026-01-01T00:00:00Z'));
    const linkedRow = `row-${randomUUID()}`;
    const linked = await f.store.create({ name: `Linked ${randomUUID().slice(0, 8)}` });
    await db.mealGuest.create({
      data: { authWorkspaceId: f.ws, authTenantId: f.tenant, rowId: linkedRow, contactId: linked.id, position: 0, displayName: 'Linked', displayCompany: '' },
    });
    await purgeExpiredRetainedGuests(db, new Date('2030-01-01T00:00:00Z'));
    expect(await db.mealGuest.count({ where: { rowId: f.rowId } })).toBe(1);
    expect(await db.mealGuest.count({ where: { rowId: linkedRow } })).toBe(1);
    const removed = await purgeExpiredRetainedGuests(db, new Date('2037-01-01T00:00:00Z'));
    expect(removed).toBeGreaterThanOrEqual(1);
    expect(await db.mealGuest.count({ where: { rowId: f.rowId } })).toBe(0);
    expect(await db.mealGuest.count({ where: { rowId: linkedRow } })).toBe(1);
  });
});
