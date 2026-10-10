import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { createWorkspace, db } from '../../../test/db-helpers';
import { ensureContactsLayout } from '../../../test/contacts-db';
import { companyContacts, contactsDb } from '../contacts/db';
import {
  WorkspaceMoveIncompleteError,
  moveWorkspace,
  stampedModels,
  type WorkspaceMoveRequest,
} from '../workspace-move';

/**
 * The workspace move against the real receipts tables and the real contacts
 * database. Covers the four paths of a stateful flow: forward, back (the same call
 * with the companies swapped), resume after a half-finished move, and a repeat
 * after completion, plus the dry run, the neighbours that must stay untouched and
 * every blocker.
 */

beforeAll(async () => {
  await ensureContactsLayout();
});

afterAll(async () => {
  await contactsDb().close();
  await db.$disconnect();
});

const tenant = () => `test-tenant-${randomUUID()}`;
const person = (label: string) => ({ name: `${label} ${randomUUID().slice(0, 8)}` });

async function addGuest(workspaceId: string, stamp: string | null, contactId: string): Promise<string> {
  const rowId = `row-${randomUUID()}`;
  await db.mealGuest.create({
    data: { authWorkspaceId: workspaceId, authTenantId: stamp, rowId, contactId, position: 0, displayName: 'Printed Name', displayCompany: 'Printed Co' },
  });
  return rowId;
}

/** Rows in several stamped tables of one workspace. The notes row is unstamped, as rows from before the stamp are. */
async function addRows(workspaceId: string, stamp: string): Promise<void> {
  await db.workspaceTaxSettings.create({ data: { authWorkspaceId: workspaceId, authTenantId: stamp } });
  await db.workspaceNotes.create({ data: { authWorkspaceId: workspaceId, authTenantId: null, body: 'note' } });
  await db.receiptReview.create({ data: { rowId: `row-${randomUUID()}`, authWorkspaceId: workspaceId, authTenantId: stamp } });
  await db.taxVendorRule.create({
    data: { authWorkspaceId: workspaceId, authTenantId: stamp, vendorKey: 'vendor', vendorLabel: 'Vendor', allocations: [] },
  });
  await db.taxAccount.create({ data: { authWorkspaceId: workspaceId, authTenantId: stamp, label: 'Konto', kind: 'bank' } });
  await db.overviewSelection.create({ data: { authWorkspaceId: workspaceId, authTenantId: stamp, name: 'view', definition: {} } });
}

/** The company stamp of every row of a workspace, per table. */
async function stamps(workspaceId: string): Promise<Record<string, (string | null)[]>> {
  const out: Record<string, (string | null)[]> = {};
  for (const model of stampedModels()) {
    const delegate = (db as unknown as Record<string, { findMany(args: unknown): Promise<{ authTenantId: string | null }[]> }>)[model.delegate];
    const rows = await delegate.findMany({ where: { [model.workspaceField]: workspaceId }, select: { authTenantId: true } });
    if (rows.length > 0) out[model.table] = rows.map((r) => r.authTenantId).sort();
  }
  return out;
}

/** Which contacts a company holds, with their versions: a write shows as a changed version. */
async function contactsOf(tenantId: string): Promise<Record<string, number>> {
  const all = await companyContacts(tenantId).list({ includeArchived: true });
  return Object.fromEntries(all.map((c) => [c.id, c.version]));
}

async function guestRows(workspaceId: string) {
  return db.mealGuest.findMany({
    where: { authWorkspaceId: workspaceId },
    select: { rowId: true, contactId: true, displayName: true, displayCompany: true },
    orderBy: { rowId: 'asc' },
  });
}

/**
 * A workspace of company `from` with rows in seven stamped tables, two guests on
 * meals and one contact no meal names, and an empty company `to`.
 */
async function scenario(opts: { realTable?: boolean } = {}) {
  let workspaceId = `test-ws-${randomUUID()}`;
  let from = tenant();
  if (opts.realTable) {
    // A real Receipts table: its `dt_tables` row carries the stamp too.
    const ws = await createWorkspace();
    workspaceId = ws.workspaceId;
    from = ws.tenantId;
  }
  const to = tenant();
  const source = companyContacts(from);
  const guestA = await source.create(person('Gast A'));
  const guestB = await source.create(person('Gast B'));
  const unplaced = await source.create(person('Ohne Essen'));
  await addRows(workspaceId, from);
  await addGuest(workspaceId, from, guestA.id);
  await addGuest(workspaceId, from, guestB.id);
  const req: WorkspaceMoveRequest = { workspaceId, fromTenantId: from, toTenantId: to, alsoContactIds: [unplaced.id] };
  const back: WorkspaceMoveRequest = { ...req, fromTenantId: to, toTenantId: from };
  return { workspaceId, from, to, req, back, ids: [guestA.id, guestB.id, unplaced.id].sort() };
}

const apply = (req: WorkspaceMoveRequest, client: PrismaClient = db) => moveWorkspace(client, req, { apply: true });
const dryRun = (req: WorkspaceMoveRequest) => moveWorkspace(db, req, { apply: false });

describe('which tables carry the company stamp', () => {
  it('the tables derived from the Prisma data model are exactly the tables that have the column', async () => {
    const rows = await db.$queryRaw<{ table_name: string }[]>`
      select table_name from information_schema.columns
      where table_schema = current_schema() and column_name = 'auth_tenant_id'`;
    const inDatabase = rows.map((r) => r.table_name).sort();
    const derived = [...stampedModels().map((m) => m.table), 'company_exports'].sort();
    expect(inDatabase).toEqual(derived);
  });
});

describe('moveWorkspace: forward, dry run, repeat and back', () => {
  it('a dry run reports the move and writes nothing in either database', async () => {
    const f = await scenario({ realTable: true });
    const before = { stamps: await stamps(f.workspaceId), from: await contactsOf(f.from), to: await contactsOf(f.to), guests: await guestRows(f.workspaceId) };

    const report = await dryRun(f.req);

    expect(report).toMatchObject({ dryRun: true, written: false, blocked: [] });
    expect(report.rows).toMatchObject({ rows: 9, restamp: 9, alreadyAtTarget: 0, otherCompany: 0 });
    expect(report.rows.tables.dt_tables).toMatchObject({ rows: 1, restamp: 1 });
    expect(report.rows.tables.meal_guests).toMatchObject({ rows: 2, restamp: 2 });
    expect(report.rows.tables.workspace_notes).toMatchObject({ rows: 1, restamp: 1 });
    expect(report.rows.tables.tax_payments).toEqual({ rows: 0, restamp: 0, alreadyAtTarget: 0, otherCompany: 0 });
    expect(Object.keys(report.rows.tables)).toHaveLength(stampedModels().length);
    expect(report.contacts).toMatchObject({
      guests: 2,
      alsoRequested: 1,
      move: 3,
      linkedAlong: 0,
      alreadyAtTarget: 0,
      identityConflicts: 0,
      sourceBefore: 3,
      targetBefore: 0,
      sourceAfter: 0,
      targetAfter: 3,
    });

    expect(await stamps(f.workspaceId)).toEqual(before.stamps);
    expect(await contactsOf(f.from)).toEqual(before.from);
    expect(await contactsOf(f.to)).toEqual(before.to);
    expect(await guestRows(f.workspaceId)).toEqual(before.guests);
  });

  it('forward: every row carries the target company and the contacts are there under the same ids', async () => {
    const f = await scenario({ realTable: true });
    const guestsBefore = await guestRows(f.workspaceId);

    const report = await apply(f.req);

    expect(report).toMatchObject({ dryRun: false, written: true, blocked: [] });
    expect(report.rows).toMatchObject({ rows: 9, restamp: 9 });
    expect(report.contacts).toMatchObject({ move: 3, sourceAfter: 0, targetAfter: 3 });
    const after = await stamps(f.workspaceId);
    expect(Object.keys(after).sort()).toEqual(
      ['dt_tables', 'meal_guests', 'overview_selections', 'receipt_reviews', 'tax_accounts', 'tax_vendor_rules', 'workspace_notes', 'workspace_tax_settings'],
    );
    for (const table of Object.keys(after)) expect(new Set(after[table]), table).toEqual(new Set([f.to]));
    expect(Object.keys(await contactsOf(f.to)).sort()).toEqual(f.ids);
    expect(await contactsOf(f.from)).toEqual({});
    // The meals still name the same contacts, and the printed copies are untouched.
    expect(await guestRows(f.workspaceId)).toEqual(guestsBefore);
  });

  it('repeat after completion: nothing is written a second time', async () => {
    const f = await scenario();
    await apply(f.req);
    const before = { stamps: await stamps(f.workspaceId), to: await contactsOf(f.to) };

    const again = await apply(f.req);

    expect(again).toMatchObject({ dryRun: false, written: false, blocked: [] });
    expect(again.rows).toMatchObject({ rows: 8, restamp: 0, alreadyAtTarget: 8 });
    expect(again.contacts).toMatchObject({ move: 0, alreadyAtTarget: 3, notFound: 0, sourceAfter: 0, targetAfter: 3 });
    expect(await stamps(f.workspaceId)).toEqual(before.stamps);
    // Same versions: the contacts were not written again.
    expect(await contactsOf(f.to)).toEqual(before.to);
  });

  it('back: the same call with the companies swapped returns the rows and the contacts', async () => {
    const f = await scenario({ realTable: true });
    const guestsBefore = await guestRows(f.workspaceId);
    await apply(f.req);

    const report = await apply(f.back);

    expect(report).toMatchObject({ written: true, blocked: [] });
    expect(report.rows).toMatchObject({ rows: 9, restamp: 9 });
    expect(report.contacts).toMatchObject({ move: 3, sourceAfter: 0, targetAfter: 3 });
    const after = await stamps(f.workspaceId);
    // Every row is back under the source company, the formerly unstamped one included.
    for (const table of Object.keys(after)) expect(new Set(after[table]), table).toEqual(new Set([f.from]));
    expect(Object.keys(await contactsOf(f.from)).sort()).toEqual(f.ids);
    expect(await contactsOf(f.to)).toEqual({});
    expect(await guestRows(f.workspaceId)).toEqual(guestsBefore);
  });

  it('resume: when the rows fail after the contacts moved, a repeat finishes the move', async () => {
    const f = await scenario();
    const failing = new Proxy(db, {
      get(target, prop) {
        if (prop === '$transaction') {
          return async () => {
            throw new Error('receipts database went away');
          };
        }
        return Reflect.get(target, prop);
      },
    });

    await expect(apply(f.req, failing)).rejects.toBeInstanceOf(WorkspaceMoveIncompleteError);
    // Half way: the contacts are in the target company, the rows still carry the source.
    expect(Object.keys(await contactsOf(f.to)).sort()).toEqual(f.ids);
    expect(new Set((await stamps(f.workspaceId)).meal_guests)).toEqual(new Set([f.from]));

    const resumed = await apply(f.req);

    expect(resumed).toMatchObject({ written: true, blocked: [] });
    expect(resumed.rows).toMatchObject({ rows: 8, restamp: 8 });
    expect(resumed.contacts).toMatchObject({ move: 0, alreadyAtTarget: 3 });
    const after = await stamps(f.workspaceId);
    for (const table of Object.keys(after)) expect(new Set(after[table]), table).toEqual(new Set([f.to]));
  });

  it('a person moves together with its organization and that organization’s other persons', async () => {
    const workspaceId = `test-ws-${randomUUID()}`;
    const from = tenant();
    const to = tenant();
    const source = companyContacts(from);
    const organization = await source.create({ kind: 'organization', name: `Firma ${randomUUID().slice(0, 8)}` });
    const guest = await source.create({ ...person('Gast'), organizationId: organization.id });
    const colleague = await source.create({ ...person('Kollegin'), organizationId: organization.id });
    const stranger = await source.create(person('Fremd'));
    await addGuest(workspaceId, from, guest.id);

    const report = await apply({ workspaceId, fromTenantId: from, toTenantId: to, alsoContactIds: [] });

    expect(report.contacts).toMatchObject({ guests: 1, move: 3, linkedAlong: 2, sourceAfter: 1, targetAfter: 3 });
    expect(Object.keys(await contactsOf(to)).sort()).toEqual([organization.id, guest.id, colleague.id].sort());
    expect(Object.keys(await contactsOf(from))).toEqual([stranger.id]);
    expect((await companyContacts(to).get(guest.id))?.organizationId).toBe(organization.id);
  });
});

describe('moveWorkspace: what must stay untouched', () => {
  it('another workspace of the same company and a workspace of a third company keep their rows and contacts', async () => {
    const f = await scenario();
    // A sibling under the same source company, with its own guest.
    const sibling = `test-ws-${randomUUID()}`;
    const siblingGuest = await companyContacts(f.from).create(person('Nachbar'));
    await addRows(sibling, f.from);
    await addGuest(sibling, f.from, siblingGuest.id);
    // A workspace of an unrelated company.
    const other = tenant();
    const otherWorkspace = `test-ws-${randomUUID()}`;
    const otherGuest = await companyContacts(other).create(person('Andere'));
    await addRows(otherWorkspace, other);
    await addGuest(otherWorkspace, other, otherGuest.id);
    const before = {
      sibling: await stamps(sibling),
      siblingGuests: await guestRows(sibling),
      other: await stamps(otherWorkspace),
      otherGuests: await guestRows(otherWorkspace),
      otherContacts: await contactsOf(other),
    };

    const report = await apply(f.req);

    expect(report).toMatchObject({ written: true, blocked: [] });
    expect(report.contacts).toMatchObject({ move: 3, sourceAfter: 1, usedByOtherWorkspaces: 0 });
    expect(await stamps(sibling)).toEqual(before.sibling);
    expect(await guestRows(sibling)).toEqual(before.siblingGuests);
    expect(Object.keys(await contactsOf(f.from))).toEqual([siblingGuest.id]);
    expect(await stamps(otherWorkspace)).toEqual(before.other);
    expect(await guestRows(otherWorkspace)).toEqual(before.otherGuests);
    expect(await contactsOf(other)).toEqual(before.otherContacts);
  });
});

describe('moveWorkspace: a guest the target company already has', () => {
  it('the meal is pointed at the target’s contact, the source contact stays, and the swap points it back', async () => {
    const workspaceId = `test-ws-${randomUUID()}`;
    const from = tenant();
    const to = tenant();
    const same = person('Doppelt');
    const inSource = await companyContacts(from).create(same);
    const inTarget = await companyContacts(to).create(same);
    const rowId = await addGuest(workspaceId, from, inSource.id);
    const req: WorkspaceMoveRequest = { workspaceId, fromTenantId: from, toTenantId: to, alsoContactIds: [] };

    const preview = await dryRun(req);
    expect(preview.contacts).toMatchObject({ move: 0, identityConflicts: 1, guestRowsRepointed: 1 });
    expect(preview.blocked).toEqual([]);
    expect((await guestRows(workspaceId))[0].contactId).toBe(inSource.id);

    const report = await apply(req);

    expect(report).toMatchObject({ written: true, blocked: [] });
    expect(report.contacts).toMatchObject({ move: 0, identityConflicts: 1, guestRowsRepointed: 1, guestRowsFolded: 0, sourceAfter: 1, targetAfter: 1 });
    expect(await guestRows(workspaceId)).toEqual([{ rowId, contactId: inTarget.id, displayName: 'Printed Name', displayCompany: 'Printed Co' }]);
    expect(Object.keys(await contactsOf(from))).toEqual([inSource.id]);
    expect(Object.keys(await contactsOf(to))).toEqual([inTarget.id]);

    const back = await apply({ ...req, fromTenantId: to, toTenantId: from });

    expect(back.contacts).toMatchObject({ move: 0, identityConflicts: 1, guestRowsRepointed: 1 });
    expect((await guestRows(workspaceId))[0].contactId).toBe(inSource.id);
    expect(Object.keys(await contactsOf(to))).toEqual([inTarget.id]);
  });
});

describe('moveWorkspace: blockers write nothing', () => {
  /** Runs a dry run and an apply, and asserts both name the blocker and neither wrote. */
  async function expectBlocked(workspaceId: string, req: WorkspaceMoveRequest, blocker: string) {
    const before = { stamps: await stamps(workspaceId), from: await contactsOf(req.fromTenantId), to: await contactsOf(req.toTenantId) };
    const preview = await dryRun(req);
    const attempt = await apply(req);
    expect(preview.blocked).toEqual([blocker]);
    expect(attempt).toMatchObject({ dryRun: false, written: false, blocked: [blocker] });
    expect(await stamps(workspaceId)).toEqual(before.stamps);
    expect(await contactsOf(req.fromTenantId)).toEqual(before.from);
    expect(await contactsOf(req.toTenantId)).toEqual(before.to);
    return attempt;
  }

  it('a row stamped with a third company: the source company given is not the workspace’s', async () => {
    const f = await scenario();
    await db.taxAccount.create({ data: { authWorkspaceId: f.workspaceId, authTenantId: tenant(), label: 'Fremd', kind: 'bank' } });
    const attempt = await expectBlocked(f.workspaceId, f.req, 'rows_of_another_company');
    expect(attempt.rows).toMatchObject({ otherCompany: 1 });
    expect(attempt.rows.tables.tax_accounts).toMatchObject({ rows: 2, restamp: 1, otherCompany: 1 });
  });

  it('a guest that another workspace of the source company also names', async () => {
    const f = await scenario();
    await addGuest(`test-ws-${randomUUID()}`, f.from, f.ids[0]);
    const attempt = await expectBlocked(f.workspaceId, f.req, 'contacts_used_by_another_workspace');
    expect(attempt.contacts).toMatchObject({ usedByOtherWorkspaces: 1 });
  });

  it('a guest row naming a contact that exists in neither company', async () => {
    const f = await scenario();
    await addGuest(f.workspaceId, f.from, randomUUID());
    const attempt = await expectBlocked(f.workspaceId, f.req, 'contacts_not_found');
    expect(attempt.contacts).toMatchObject({ notFound: 1 });
  });

  it('a contact the package refuses for a reason the move does not resolve (a taken customer number)', async () => {
    const f = await scenario();
    await companyContacts(f.from).setCustomerNumber(f.ids[0], 7);
    const holder = await companyContacts(f.to).create(person('Kunde'));
    await companyContacts(f.to).setCustomerNumber(holder.id, 7);
    const attempt = await expectBlocked(f.workspaceId, f.req, 'contacts_refused');
    expect(attempt.contacts).toMatchObject({ move: 0, refused: { customer_number_conflict: 1 }, sourceAfter: 3, targetAfter: 1 });
  });
});
