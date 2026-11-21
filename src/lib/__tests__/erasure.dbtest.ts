import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createWorkspace, db, plainMealReceipt } from '../../../test/db-helpers';
import { ensureContactsLayout } from '../../../test/contacts-db';
import { companyContacts, contactsDb } from '../contacts/db';
import { SharedContactStore } from '../contacts/shared-store';
import { currentRegisterHash } from '../company-export';
import { eraseCompanyContacts, exportCoversRegister, purgeExpiredRetainedGuests, settleGuestCopies, type RegisterHasher } from '../erasure';

/**
 * The printed guest names against the real receipts tables and the real contacts
 * database. Two rules:
 * - when ONE contact is erased and the company goes on, the export decides: an
 *   export counts only while the register it was taken from is still the
 *   register, otherwise the names are held; the purge removes them after their date;
 * - when the whole company is erased, its names go whatever it exported.
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

/** A real workspace with a Receipts table, one business meal and one guest on it. */
async function mealScenario() {
  const ws = await createWorkspace();
  const store = new SharedContactStore(companyContacts(ws.tenantId), db);
  const contact = await store.create({ name: `Gast ${randomUUID().slice(0, 8)}` });
  const addGuest = async (contactId: string, name: string) => {
    const rowId = await ws.addReceipt(plainMealReceipt());
    await db.mealGuest.create({
      data: { authWorkspaceId: ws.workspaceId, authTenantId: ws.tenantId, rowId, contactId, position: 0, displayName: name, displayCompany: '' },
    });
    return rowId;
  };
  const rowId = await addGuest(contact.id, contact.name);
  let taken = 0;
  /** Record an export of the register as it is right now, as the export route does. */
  const takeExport = async () =>
    db.companyExport.create({
      data: {
        authTenantId: ws.tenantId,
        fileCount: 1,
        sha256: 'a'.repeat(64),
        registerSha256: await currentRegisterHash(db, [ws.workspaceId]),
        createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, ++taken)),
      },
    });
  return { ws, store, contact, rowId, addGuest, takeExport };
}

/**
 * The rule as the erasure of one contact applies it (`eraseContact` in contacts/directory.ts):
 * the export is compared over the company's workspaces, then the contact's printed copies are settled.
 */
async function settleContact(f: { ws: { tenantId: string; workspaceId: string }; contact: { id: string } }, workspaceIds?: string[], hasher?: RegisterHasher, now?: Date) {
  const coverage = await exportCoversRegister(db, f.ws.tenantId, workspaceIds ?? [f.ws.workspaceId], hasher);
  const settled = await settleGuestCopies(db, [{ contactId: f.contact.id }], coverage.covered, now);
  return { guestCopies: settled.removed, guestCopiesHeld: settled.held, exportCoverage: coverage.reason };
}

describe('the export rule against the real register (one contact erased, the company goes on)', () => {
  it('export, then no change: the printed copy is removed', async () => {
    const f = await mealScenario();
    await f.takeExport();
    const counts = await settleContact(f);
    expect(counts).toMatchObject({ guestCopies: 1, guestCopiesHeld: 0, exportCoverage: 'identical' });
    expect(await db.mealGuest.count({ where: { rowId: f.rowId } })).toBe(0);
  });

  it('export, then a guest correction: the export no longer holds the printed name, so it is held', async () => {
    const f = await mealScenario();
    const before = await currentRegisterHash(db, [f.ws.workspaceId]);
    await f.takeExport();
    await f.store.update(f.contact.id, { name: `${f.contact.name} korrigiert` });
    expect(await currentRegisterHash(db, [f.ws.workspaceId])).not.toBe(before);
    const counts = await settleContact(f);
    expect(counts).toMatchObject({ guestCopies: 0, guestCopiesHeld: 1, exportCoverage: 'changed' });
    const held = await db.mealGuest.findFirstOrThrow({ where: { rowId: f.rowId } });
    expect(held).toMatchObject({ contactId: null, displayName: `${f.contact.name} korrigiert` });
  });

  it('export, then a new meal guest: the register changed, so the erased contact\'s printed copy is held, and the other guest\'s copy is not touched', async () => {
    const f = await mealScenario();
    await f.takeExport();
    const second = await f.store.create({ name: `Zweiter ${randomUUID().slice(0, 8)}` });
    const newRow = await f.addGuest(second.id, second.name);
    const counts = await settleContact(f);
    expect(counts).toMatchObject({ guestCopies: 0, guestCopiesHeld: 1, exportCoverage: 'changed' });
    expect(await db.mealGuest.findFirstOrThrow({ where: { rowId: f.rowId } })).toMatchObject({ contactId: null });
    expect((await db.mealGuest.findFirstOrThrow({ where: { rowId: f.rowId } })).retainUntil).not.toBeNull();
    expect(await db.mealGuest.findFirstOrThrow({ where: { rowId: newRow } })).toMatchObject({ contactId: second.id, retainUntil: null });
  });

  it('the newest export decides: a later export of the changed register covers it again', async () => {
    const f = await mealScenario();
    await f.takeExport();
    await f.store.update(f.contact.id, { name: `${f.contact.name} korrigiert` });
    await f.takeExport();
    const counts = await settleContact(f);
    expect(counts).toMatchObject({ guestCopies: 1, guestCopiesHeld: 0, exportCoverage: 'identical' });
  });

  it('an export from before the register hash existed holds', async () => {
    const f = await mealScenario();
    await db.companyExport.create({ data: { authTenantId: f.ws.tenantId, fileCount: 3, sha256: 'a'.repeat(64) } });
    const counts = await settleContact(f);
    expect(counts).toMatchObject({ guestCopies: 0, guestCopiesHeld: 1, exportCoverage: 'no_hash' });
  });

  it('a register that cannot be read, and an erasure without workspace ids, both hold', async () => {
    const failing = await mealScenario();
    await failing.takeExport();
    const counts = await settleContact(failing, undefined, async () => {
      throw new Error('data layer unreachable');
    });
    expect(counts).toMatchObject({ guestCopies: 0, guestCopiesHeld: 1, exportCoverage: 'recompute_failed' });

    const noScope = await mealScenario();
    await noScope.takeExport();
    const held = await settleContact(noScope, []);
    expect(held).toMatchObject({ guestCopies: 0, guestCopiesHeld: 1, exportCoverage: 'no_workspaces' });
  });

  it('repeat-safe after a removal: the second run finds nothing', async () => {
    const f = await mealScenario();
    await f.takeExport();
    await settleContact(f);
    const again = await settleContact(f);
    // The copy is gone, so the register differs from the export now: nothing is left to hold or remove.
    expect(again).toMatchObject({ guestCopies: 0, guestCopiesHeld: 0 });
  });
});

describe('eraseCompanyContacts against the real databases (the whole company is erased)', () => {
  it('without an export: the contact goes and the printed copy goes with it, nothing is held; a repeat finds nothing', async () => {
    const f = await scenario();
    const first = await eraseCompanyContacts(db, f.tenant, [f.ws]);
    expect(first).toEqual({ guestCopies: 1, sharedContacts: 1, guestLinksCleared: 0 });
    expect(await f.store.list({ includeArchived: true })).toEqual([]);
    expect(await db.mealGuest.count({ where: { rowId: f.rowId } })).toBe(0);

    expect(await eraseCompanyContacts(db, f.tenant, [f.ws])).toEqual({ guestCopies: 0, sharedContacts: 0, guestLinksCleared: 0 });
  });
});

describe('held copies and the purge (one contact erased, no identical export)', () => {
  it('the copy is held for ten years with its link cleared, and a repeat does not move the date', async () => {
    const f = await scenario();
    const hold = (now: Date) => settleGuestCopies(db, [{ contactId: f.contactId }], false, now);
    expect(await hold(new Date('2026-10-09T10:00:00Z'))).toEqual({ removed: 0, held: 1 });

    const held = await db.mealGuest.findFirstOrThrow({ where: { rowId: f.rowId } });
    expect(held).toMatchObject({ contactId: null, displayName: 'Printed Name', displayCompany: 'Printed Co' });
    expect(held.retainUntil?.toISOString()).toBe('2036-10-09T10:00:00.000Z');

    // Later, by the company's scope: a held copy is neither held again nor removed by an identical export.
    const scope = [{ authTenantId: f.tenant }];
    expect(await settleGuestCopies(db, scope, false, new Date('2027-03-01T00:00:00Z'))).toEqual({ removed: 0, held: 0 });
    expect(await settleGuestCopies(db, scope, true, new Date('2027-03-01T00:00:00Z'))).toEqual({ removed: 0, held: 0 });
    const still = await db.mealGuest.findFirstOrThrow({ where: { rowId: f.rowId } });
    expect(still.retainUntil?.toISOString()).toBe('2036-10-09T10:00:00.000Z');
  });

  it('the purge removes only held copies past their date, never a copy still linked to a contact', async () => {
    const f = await scenario();
    await settleGuestCopies(db, [{ contactId: f.contactId }], false, new Date('2026-01-01T00:00:00Z'));
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
