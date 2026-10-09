import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../../../test/db-helpers';
import { ensureContactsLayout } from '../../../../test/contacts-db';
import { companyContacts, contactsDb } from '../db';
import { moveCompany, planMove, type CompanyCounts, type MoveGroup } from '../../../../scripts/lib/contacts-move';

/**
 * The company move against the real receipts tables and the real contacts
 * database. Covers the four paths of the stateful-flow standard for the move:
 * forward, a dry run that changes nothing, re-entry after completion, and resume
 * after a run that stopped part way. Each test uses a fresh company.
 */

beforeAll(async () => {
  await ensureContactsLayout();
});

afterAll(async () => {
  await contactsDb().close();
  await db.$disconnect();
});

interface Fixture {
  tenant: string;
  ws1: string;
  ws2: string;
  ada: string; // winner of the Ada group (has a note the loser lacks)
  adaLoser: string;
  grace: string; // winner of the Grace group: active, later
  graceLoser: string; // archived, earlier
}

/** Two identical-entry groups in one company, plus meals that name the losers. */
async function fixture(): Promise<Fixture> {
  const tenant = `test-mv-${randomUUID()}`;
  const ws1 = `test-ws-${randomUUID()}`;
  const ws2 = `test-ws-${randomUUID()}`;
  const ada = randomUUID();
  const adaLoser = randomUUID();
  const graceLoser = randomUUID();
  const grace = randomUUID();
  const t = (day: number) => new Date(Date.UTC(2026, 0, day));
  await db.contact.createMany({
    data: [
      { id: ada, authWorkspaceId: ws1, authTenantId: tenant, name: 'Ada Move', companyOrRole: 'Engines', note: null, createdAt: t(1) },
      { id: adaLoser, authWorkspaceId: ws2, authTenantId: tenant, name: 'Ada Move', companyOrRole: 'Engines', note: 'Prefers mornings', createdAt: t(2) },
      { id: graceLoser, authWorkspaceId: ws1, authTenantId: tenant, name: 'Grace Move', companyOrRole: '', note: null, archivedAt: t(3), createdAt: t(3) },
      { id: grace, authWorkspaceId: ws2, authTenantId: tenant, name: 'Grace Move', companyOrRole: '', note: null, createdAt: t(4) },
    ],
  });
  // rowA (workspace 1) names the Ada loser and the Grace loser.
  // rowB (workspace 2) names the Ada winner and the Ada loser: the loser's copy must be removed, not repointed.
  const rowA = `row-${randomUUID()}`;
  const rowB = `row-${randomUUID()}`;
  await db.mealGuest.createMany({
    data: [
      { authWorkspaceId: ws1, authTenantId: tenant, rowId: rowA, contactId: adaLoser, position: 0, displayName: 'Ada Move', displayCompany: 'Engines' },
      { authWorkspaceId: ws1, authTenantId: tenant, rowId: rowA, contactId: graceLoser, position: 1, displayName: 'Grace Move', displayCompany: '' },
      { authWorkspaceId: ws2, authTenantId: tenant, rowId: rowB, contactId: ada, position: 0, displayName: 'Ada Move', displayCompany: 'Engines' },
      { authWorkspaceId: ws2, authTenantId: tenant, rowId: rowB, contactId: adaLoser, position: 1, displayName: 'Ada Move', displayCompany: 'Engines' },
    ],
  });
  return { tenant, ws1, ws2, ada, adaLoser, grace, graceLoser };
}

async function groupsFor(tenant: string): Promise<MoveGroup[]> {
  const rows = await db.contact.findMany({
    where: { authTenantId: tenant },
    select: { id: true, authWorkspaceId: true, authTenantId: true, name: true, companyOrRole: true, note: true, archivedAt: true, createdAt: true },
  });
  return planMove(rows, new Map()).groups.get(tenant) ?? [];
}

/** The state the move must leave behind, whichever way it got there. */
async function expectMovedState(f: Fixture) {
  const shared = companyContacts(f.tenant);
  const contacts = await shared.list({ includeArchived: true });
  expect(contacts.map((c) => c.id).sort()).toEqual([f.ada, f.grace].sort());
  // The winner keeps its id and takes the note the loser had.
  expect(contacts.find((c) => c.id === f.ada)?.note).toBe('Prefers mornings');
  // Meals now name the winners. Meal rowA: Ada loser became Ada, Grace loser became Grace.
  // Meal rowB: the Ada loser's copy was removed because the Ada winner was already on the meal.
  const guests = await db.mealGuest.findMany({ where: { authTenantId: f.tenant }, select: { rowId: true, contactId: true } });
  const byRow = new Map<string, string[]>();
  for (const g of guests) byRow.set(g.rowId, [...(byRow.get(g.rowId) ?? []), g.contactId].sort());
  const rowsWithGuests = [...byRow.values()].sort((a, b) => a.join().localeCompare(b.join()));
  expect(rowsWithGuests).toEqual(
    [[f.ada, f.grace].sort(), [f.ada]].sort((a, b) => a.join().localeCompare(b.join())),
  );
}

describe('moveCompany against the real databases', () => {
  it('a dry run reports the work and writes nothing', async () => {
    const f = await fixture();
    const counts = await moveCompany(await groupsFor(f.tenant), {
      shared: companyContacts(f.tenant),
      db,
      apply: false,
    });
    expect(counts).toMatchObject({ groups: 2, merged: 2, created: 0, guestRowsPending: 3 });
    expect(await companyContacts(f.tenant).list({ includeArchived: true })).toEqual([]);
    expect(await db.mealGuest.count({ where: { contactId: f.adaLoser } })).toBe(2);
  });

  it('forward: moves the company, keeps the winners ids, repoints meals and removes the duplicate copy', async () => {
    const f = await fixture();
    const counts: CompanyCounts = await moveCompany(await groupsFor(f.tenant), {
      shared: companyContacts(f.tenant),
      db,
      apply: true,
    });
    expect(counts).toMatchObject({
      created: 2,
      alreadyMoved: 0,
      merged: 2,
      noteFilled: 1,
      guestRowsRepointed: 2,
      guestRowsDeduplicated: 1,
    });
    await expectMovedState(f);
  });

  it('re-entry: a finished company reports no new work and changes nothing', async () => {
    const f = await fixture();
    await moveCompany(await groupsFor(f.tenant), { shared: companyContacts(f.tenant), db, apply: true });
    const again = await moveCompany(await groupsFor(f.tenant), { shared: companyContacts(f.tenant), db, apply: true });
    expect(again).toMatchObject({
      created: 0,
      alreadyMoved: 2,
      noteFilled: 0,
      guestRowsRepointed: 0,
      guestRowsDeduplicated: 0,
    });
    await expectMovedState(f);
  });

  it('resume: a run that stopped after the first group is completed by the next run, to the same state', async () => {
    const f = await fixture();
    const stop = new Error('stopped on purpose');
    let groupsDone = 0;
    await expect(
      moveCompany(await groupsFor(f.tenant), {
        shared: companyContacts(f.tenant),
        db,
        apply: true,
        afterGroup: () => {
          groupsDone++;
          if (groupsDone === 1) throw stop;
        },
      }),
    ).rejects.toBe(stop);
    // Half-done: one group in the shared database, the other still in the old table only.
    expect((await companyContacts(f.tenant).list({ includeArchived: true })).length).toBe(1);

    const resumed = await moveCompany(await groupsFor(f.tenant), {
      shared: companyContacts(f.tenant),
      db,
      apply: true,
    });
    expect(resumed).toMatchObject({ created: 1, alreadyMoved: 1 });
    await expectMovedState(f);
  });

  it('reports entries that the move will re-spell on old meals (dry run, nothing written)', async () => {
    const tenant = `test-mv-${randomUUID()}`;
    const ws1 = `test-ws-${randomUUID()}`;
    const ws2 = `test-ws-${randomUUID()}`;
    const winner = randomUUID();
    const loser = randomUUID();
    const t = (day: number) => new Date(Date.UTC(2026, 1, day));
    await db.contact.createMany({
      data: [
        { id: winner, authWorkspaceId: ws1, authTenantId: tenant, name: 'Ada Respell', companyOrRole: 'Engines', createdAt: t(1) },
        { id: loser, authWorkspaceId: ws2, authTenantId: tenant, name: 'ada respell', companyOrRole: 'Engines', createdAt: t(2) },
      ],
    });
    await db.mealGuest.create({
      data: { authWorkspaceId: ws2, authTenantId: tenant, rowId: `row-${randomUUID()}`, contactId: loser, position: 0, displayName: 'ada respell', displayCompany: 'Engines' },
    });
    const counts = await moveCompany(await groupsFor(tenant), { shared: companyContacts(tenant), db, apply: false });
    expect(counts).toMatchObject({ merged: 1, spellingDiffers: 1, guestCopiesRespelled: 1, guestRowsPending: 1 });
    expect(await companyContacts(tenant).list({ includeArchived: true })).toEqual([]);
  });
});
