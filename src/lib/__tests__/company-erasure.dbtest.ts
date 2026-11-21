import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Prisma, PrismaClient } from '@prisma/client';
import { safeTableName } from '@marlinjai/data-table-adapter-shared';
import { createWorkspace, db, plainMealReceipt, type TestWorkspace } from '../../../test/db-helpers';
import { ensureContactsLayout } from '../../../test/contacts-db';
import { companyContacts, contactsDb } from '../contacts/db';
import { SharedContactStore } from '../contacts/shared-store';
import {
  ErasureChangedError,
  ErasureConflictError,
  ErasureIncompleteError,
  StoredFileEraseError,
  UNSTAMPED_MODELS,
  classifyModels,
  countCompanyRemainder,
  eraseCompany,
  type CompanyErasureDeps,
} from '../company-erasure';
import { currentRegisterHash } from '../company-export';
import { receiveErasureDelivery, settleGuestCopies } from '../erasure';
import { erasureLedger } from '../erasure-ledger';
import { stampedModels } from '../workspace-move';

/**
 * The whole erasure of a company against the real receipts tables, the real
 * data-table layout (one physical table per receipts table) and the real
 * contacts database. The file store is a stand-in that records what it was
 * asked to remove. Four paths: forward, repeat, a run that stops half way and
 * is finished by the next, and a delivery after completion.
 */

beforeAll(async () => {
  await ensureContactsLayout();
});

afterAll(async () => {
  await contactsDb().close();
  await db.$disconnect();
});

async function attach(ws: TestWorkspace, rowId: string, fileId: string) {
  const image = (await ws.adapter.getColumns(ws.tableId)).find((c) => c.name === 'Receipt Image')!;
  await ws.adapter.addFileReference({ rowId, columnId: image.id, fileId, fileUrl: `/api/files/${fileId}`, originalName: 'beleg.jpg', mimeType: 'image/jpeg', metadata: { source: 'ocr-upload' } });
}

async function tableExists(tableId: string): Promise<boolean> {
  const [{ present }] = await db.$queryRaw<Array<{ present: boolean }>>`SELECT to_regclass(${`public.${safeTableName(tableId)}`}::text) IS NOT NULL AS present`;
  return present;
}

/** One receipt with a stored file and the records that hang off its row id. */
async function receiptWithRecords(ws: TestWorkspace, tenantId: string | null) {
  const rowId = await ws.addReceipt(plainMealReceipt());
  const fileId = `file-${randomUUID()}`;
  await attach(ws, rowId, fileId);
  const stamp = { authWorkspaceId: ws.workspaceId, authTenantId: tenantId };
  await db.receiptReview.create({ data: { ...stamp, rowId, flags: ['look_alike'] } });
  await db.receiptItemReading.create({ data: { ...stamp, rowId, outcome: 'read', source: 'model' } });
  await db.receiptAssignmentDecision.create({ data: { ...stamp, rowId, fingerprint: 'f', outcome: 'decided' } });
  return { rowId, fileId };
}

/** A bank account with one imported payment. */
async function accountWithPayment(ws: TestWorkspace, tenantId: string | null) {
  const stamp = { authWorkspaceId: ws.workspaceId, authTenantId: tenantId };
  const account = await db.taxAccount.create({ data: { ...stamp, label: 'Konto', kind: 'bank' } });
  const batch = await db.taxImportBatch.create({ data: { ...stamp, accountId: account.id, contentHash: randomUUID(), format: 'csv', paymentCount: 1, newCount: 1 } });
  await db.taxPayment.create({
    data: { ...stamp, accountId: account.id, batchId: batch.id, bookingDay: '2026-03-01', amountCents: -1190, counterparty: 'Testlokal', counterpartyKey: 'testlokal', reference: 'r', sourceKind: 'bank', sourceHash: randomUUID() },
  });
}

/**
 * A company with two workspaces. The first is stamped with the company. The
 * second carries NO stamp anywhere (rows from before the stamp existed): only
 * the workspace id auth-brain names ties it to the company.
 */
async function company() {
  const first = await createWorkspace();
  const tenantId = first.tenantId;
  const second = await createWorkspace();
  await db.dtTable.updateMany({ where: { workspaceId: second.workspaceId }, data: { authTenantId: null } });

  const a = await receiptWithRecords(first, tenantId);
  const b = await receiptWithRecords(first, tenantId);
  const c = await receiptWithRecords(second, null);
  await accountWithPayment(first, tenantId);
  await db.workspaceNotes.create({ data: { authWorkspaceId: first.workspaceId, authTenantId: tenantId, body: 'x' } });
  const config = await db.sheetImportConfig.create({
    data: { authWorkspaceId: second.workspaceId, authTenantId: null, spreadsheetId: 's', sheetName: 't', columnMapping: {}, dedupKeyFields: [], createdByUserId: 'u' },
  });
  await db.sheetImportRow.create({ data: { configId: config.id, dedupKey: 'k', dtRowId: c.rowId } });
  await db.companyExport.create({ data: { authTenantId: tenantId, fileCount: 1, sha256: 'a'.repeat(64), registerSha256: null } });

  const contact = await new SharedContactStore(companyContacts(tenantId), db).create({ name: `Gast ${randomUUID().slice(0, 8)}` });
  await db.mealGuest.create({
    data: { authWorkspaceId: first.workspaceId, authTenantId: tenantId, rowId: a.rowId, contactId: contact.id, position: 0, displayName: 'Printed Name', displayCompany: '' },
  });

  return { tenantId, first, second, workspaceIds: [first.workspaceId, second.workspaceId], receipts: [a, b, c], files: [a.fileId, b.fileId, c.fileId].sort() };
}

/** Another company, complete, that no erasure of the first may touch. */
async function bystander() {
  const ws = await createWorkspace();
  const receipt = await receiptWithRecords(ws, ws.tenantId);
  await accountWithPayment(ws, ws.tenantId);
  await db.workspaceNotes.create({ data: { authWorkspaceId: ws.workspaceId, authTenantId: ws.tenantId, body: 'y' } });
  await db.companyExport.create({ data: { authTenantId: ws.tenantId, fileCount: 1, sha256: 'b'.repeat(64) } });
  const snapshot = async () => ({
    row: (await ws.adapter.getRow(receipt.rowId))?.id ?? null,
    table: await tableExists(ws.tableId),
    columns: await db.dtColumn.count({ where: { tableId: ws.tableId } }),
    views: await db.dtView.count({ where: { tableId: ws.tableId } }),
    files: (await db.dtFile.findMany({ where: { rowId: receipt.rowId }, select: { fileId: true } })).map((f) => f.fileId),
    reviews: await db.receiptReview.count({ where: { authWorkspaceId: ws.workspaceId } }),
    readings: await db.receiptItemReading.count({ where: { authWorkspaceId: ws.workspaceId } }),
    payments: await db.taxPayment.count({ where: { authWorkspaceId: ws.workspaceId } }),
    notes: await db.workspaceNotes.count({ where: { authWorkspaceId: ws.workspaceId } }),
    exports: await db.companyExport.count({ where: { authTenantId: ws.tenantId } }),
  });
  return { ws, receipt, snapshot };
}

function deps(over: Partial<CompanyErasureDeps> = {}) {
  const removed: string[] = [];
  const all: CompanyErasureDeps = {
    deleteStoredFile: vi.fn(async (fileId: string) => {
      removed.push(fileId);
    }),
    endBankConnections: vi.fn(async () => ({ connections: 0, sessionsLeftOpen: 0 })),
    endAccountShares: vi.fn(async () => ({ shares: 0, links: 0, records: 0 })),
    ...over,
  };
  return { all, removed };
}

/** Everything of a company that an erasure must not leave, counted directly. */
async function leftOf(c: Awaited<ReturnType<typeof company>>) {
  const tables = [c.first.tableId, c.second.tableId];
  const rows = c.receipts.map((r) => r.rowId);
  return {
    physicalTables: (await Promise.all(tables.map(tableExists))).filter(Boolean).length,
    dtTables: await db.dtTable.count({ where: { id: { in: tables } } }),
    columns: await db.dtColumn.count({ where: { tableId: { in: tables } } }),
    views: await db.dtView.count({ where: { tableId: { in: tables } } }),
    fileRefs: await db.dtFile.count({ where: { rowId: { in: rows } } }),
    selectValues: await db.dtRowSelectValue.count({ where: { rowId: { in: rows } } }),
    reviews: await db.receiptReview.count({ where: { rowId: { in: rows } } }),
    readings: await db.receiptItemReading.count({ where: { rowId: { in: rows } } }),
    decisions: await db.receiptAssignmentDecision.count({ where: { rowId: { in: rows } } }),
    accounts: await db.taxAccount.count({ where: { authWorkspaceId: { in: c.workspaceIds } } }),
    payments: await db.taxPayment.count({ where: { authWorkspaceId: { in: c.workspaceIds } } }),
    notes: await db.workspaceNotes.count({ where: { authWorkspaceId: { in: c.workspaceIds } } }),
    importConfigs: await db.sheetImportConfig.count({ where: { authWorkspaceId: { in: c.workspaceIds } } }),
    importRows: await db.sheetImportRow.count({ where: { dtRowId: { in: rows } } }),
    exports: await db.companyExport.count({ where: { authTenantId: c.tenantId } }),
  };
}

const NOTHING = {
  physicalTables: 0, dtTables: 0, columns: 0, views: 0, fileRefs: 0, selectValues: 0, reviews: 0, readings: 0, decisions: 0,
  accounts: 0, payments: 0, notes: 0, importConfigs: 0, importRows: 0, exports: 0,
};

describe('every model is classified', () => {
  it('covers the whole data model: stamped models are erased, the rest is named with its reason', () => {
    const classes = classifyModels();
    expect(Object.keys(classes).sort()).toEqual(Prisma.dmmf.datamodel.models.map((m) => m.name).sort());
    expect(classes.DtTable).toBe('table');
    expect(classes.MealGuest).toBe('guest_rule');
    expect(classes.ErasureEvent).toBe('ledger');
    expect(classes.ReceiptReview).toBe('erased');
    // No entry of the list is stale: each names a model that exists and carries no stamp.
    const stamped = new Set(stampedModels().map((m) => m.model));
    for (const name of Object.keys(UNSTAMPED_MODELS)) {
      expect(Prisma.dmmf.datamodel.models.some((m) => m.name === name), name).toBe(true);
      expect(stamped.has(name), name).toBe(false);
    }
  });

  it('a model nobody classified stops the erasure instead of being skipped', () => {
    const models = [...Prisma.dmmf.datamodel.models, { name: 'SomethingNew', dbName: 'something_new', fields: [{ name: 'id' }] }];
    expect(() => classifyModels(models)).toThrow(/SomethingNew is not classified/);
  });
});

describe('eraseCompany against the real databases', () => {
  it('forward: the tables, rows, stored files and stamped rows are gone, also in the workspace without a stamp, and another company keeps everything', async () => {
    const c = await company();
    const other = await bystander();
    const before = await other.snapshot();
    const d = deps();

    const counts = await eraseCompany(db, c.tenantId, c.workspaceIds, d.all);

    expect([...d.removed].sort()).toEqual(c.files);
    expect(counts.register).toMatchObject({ tables: 2, receipts: 3, storedFiles: 3, storedFilesKept: 0, companyExports: 1 });
    expect(counts.register?.records).toMatchObject({
      receipt_reviews: 3, receipt_item_readings: 3, receipt_assignment_decisions: 3, tax_accounts: 1, tax_import_batches: 1, tax_payments: 1, workspace_notes: 1, sheet_import_configs: 1,
    });
    expect(await leftOf(c)).toEqual(NOTHING);
    expect(await countCompanyRemainder(db, c.tenantId, c.workspaceIds)).toEqual({ remaining: {}, heldGuestCopies: 1 });
    expect(await companyContacts(c.tenantId).list({ includeArchived: true })).toEqual([]);

    // No export covered the printed name, so it is held with a date and the answer says so.
    expect(counts).toMatchObject({ guestCopies: 0, guestCopiesHeld: 1, sharedContacts: 1, exportCoverage: 'no_hash' });
    expect(counts.notErased?.map((n) => n.what)).toEqual(['guest_copies_held', 'database_backups', 'uploads_never_attached_to_a_receipt']);
    expect(counts.notErased?.[0]).toMatchObject({ count: 1, until: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) });

    expect(await other.snapshot()).toEqual(before);
    expect(d.removed).not.toContain(other.receipt.fileId);
  });

  it('repeat: a second run finds nothing, asks the file store for nothing and does not move the date of a held name', async () => {
    const c = await company();
    const first = deps();
    await eraseCompany(db, c.tenantId, c.workspaceIds, { ...first.all, now: new Date('2026-11-21T10:00:00Z') });
    const heldBefore = await db.mealGuest.findMany({ where: { authTenantId: c.tenantId }, select: { retainUntil: true } });

    const second = deps();
    const counts = await eraseCompany(db, c.tenantId, c.workspaceIds, { ...second.all, now: new Date('2027-01-01T10:00:00Z') });

    expect(second.removed).toEqual([]);
    expect(counts.register).toEqual({ tables: 0, receipts: 0, storedFiles: 0, storedFilesAlreadyGone: 0, storedFilesKept: 0, records: {}, companyExports: 0 });
    expect(counts).toMatchObject({ guestCopies: 0, guestCopiesHeld: 1, sharedContacts: 0 });
    expect(await db.mealGuest.findMany({ where: { authTenantId: c.tenantId }, select: { retainUntil: true } })).toEqual(heldBefore);
    expect(heldBefore[0].retainUntil?.toISOString()).toBe('2036-11-21T10:00:00.000Z');
  });

  it('a file store that refuses surfaces: the run throws, no row is gone, and the next run finishes without asking for the removed file again', async () => {
    const c = await company();
    const [gone, refused, later] = c.files;
    const failing = deps({
      deleteStoredFile: vi.fn(async (fileId: string) => {
        if (fileId !== gone) throw new Error('file store answered 503');
      }),
    });

    await expect(eraseCompany(db, c.tenantId, c.workspaceIds, failing.all)).rejects.toBeInstanceOf(StoredFileEraseError);

    // Every table and row is still there, so the repeat finds them. Only the file that went lost its reference.
    const left = await leftOf(c);
    expect(left).toMatchObject({ physicalTables: 2, dtTables: 2, reviews: 3, payments: 1, exports: 1 });
    expect((await db.dtFile.findMany({ where: { fileId: { in: c.files } }, select: { fileId: true } })).map((f) => f.fileId).sort()).toEqual([refused, later].sort());

    const working = deps();
    const counts = await eraseCompany(db, c.tenantId, c.workspaceIds, working.all);
    expect([...working.removed].sort()).toEqual([refused, later].sort());
    expect(counts.register).toMatchObject({ tables: 2, receipts: 3, storedFiles: 2 });
    expect(await leftOf(c)).toEqual(NOTHING);
  });

  it('a stored file a living receipt of another company still shows is kept, with that receipt\'s reference, and the answer counts it', async () => {
    const c = await company();
    const other = await bystander();
    await attach(other.ws, other.receipt.rowId, c.files[0]);
    const d = deps();

    const counts = await eraseCompany(db, c.tenantId, c.workspaceIds, d.all);

    expect([...d.removed].sort()).toEqual(c.files.slice(1));
    expect(counts.register).toMatchObject({ storedFiles: 2, storedFilesKept: 1 });
    expect(counts.notErased).toContainEqual({ what: 'stored_files_shown_elsewhere', count: 1 });
    expect((await db.dtFile.findMany({ where: { fileId: c.files[0] }, select: { rowId: true } })).map((f) => f.rowId)).toEqual([other.receipt.rowId]);
    expect(await leftOf(c)).toEqual(NOTHING);
  });

  it('a row of a named workspace stamped with another company stops the run before anything is touched', async () => {
    const c = await company();
    const other = await bystander();
    await db.workspaceNotes.update({ where: { authWorkspaceId: c.first.workspaceId }, data: { authTenantId: other.ws.tenantId } });
    const d = deps();

    const error = await eraseCompany(db, c.tenantId, c.workspaceIds, d.all).catch((e) => e);

    expect(error).toBeInstanceOf(ErasureConflictError);
    expect(error).toMatchObject({ kind: 'rows_of_another_company', tables: ['workspace_notes'], workspaces: [c.first.workspaceId] });
    expect(d.removed).toEqual([]);
    expect(await leftOf(c)).toMatchObject({ physicalTables: 2, dtTables: 2, reviews: 3, payments: 1, notes: 1, exports: 1 });
    expect((await companyContacts(c.tenantId).list({ includeArchived: true })).length).toBe(1);
  });

});

/** Runs `work` with a trigger on one table, and removes the trigger and its function afterwards whatever happens. */
async function withTrigger(table: string, timing: 'BEFORE' | 'AFTER', body: string, work: () => Promise<void>) {
  const name = `test_trg_${randomUUID().replace(/-/g, '')}`;
  await db.$executeRawUnsafe(`CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN ${body} END $$`);
  await db.$executeRawUnsafe(`CREATE TRIGGER ${name} ${timing} DELETE ON ${table} FOR EACH ROW EXECUTE FUNCTION ${name}()`);
  try {
    await work();
  } finally {
    await db.$executeRawUnsafe(`DROP TRIGGER IF EXISTS ${name} ON ${table}`);
    await db.$executeRawUnsafe(`DROP FUNCTION IF EXISTS ${name}()`);
  }
}

describe('a name that was held stays held', () => {
  it('the rule itself: "covered" removes only names without a date', async () => {
    const ws = `test-ws-${randomUUID()}`;
    const row = { authWorkspaceId: ws, authTenantId: null, rowId: `row-${randomUUID()}`, displayName: 'Printed Name' };
    await db.mealGuest.create({ data: { ...row, position: 0, contactId: null, retainUntil: new Date('2036-01-01T00:00:00Z') } });
    await db.mealGuest.create({ data: { ...row, position: 1, contactId: `c-${randomUUID()}` } });
    expect(await settleGuestCopies(db, [{ authWorkspaceId: { in: [ws] } }], true)).toEqual({ removed: 1, held: 0 });
    expect(await db.mealGuest.findMany({ where: { authWorkspaceId: ws }, select: { position: true } })).toEqual([{ position: 0 }]);
  });

  it('a company that exported an empty register, then recorded meals: the first run holds the names and stops after the tables are gone, the second reads "identical" and still removes none', async () => {
    const ws = await createWorkspace();
    // The export of a register without meals: its hash is the hash of no files at all.
    await db.companyExport.create({
      data: { authTenantId: ws.tenantId, fileCount: 1, sha256: 'c'.repeat(64), registerSha256: await currentRegisterHash(db, [ws.workspaceId]) },
    });
    const contact = await new SharedContactStore(companyContacts(ws.tenantId), db).create({ name: `Gast ${randomUUID().slice(0, 8)}` });
    const rowId = await ws.addReceipt(plainMealReceipt());
    const guest = { authWorkspaceId: ws.workspaceId, authTenantId: ws.tenantId, rowId, displayCompany: '' };
    await db.mealGuest.create({ data: { ...guest, position: 0, contactId: contact.id, displayName: contact.name } });
    await db.mealGuest.create({ data: { ...guest, position: 1, contactId: null, displayName: 'Printed Name' } });
    await db.workspaceNotes.create({ data: { authWorkspaceId: ws.workspaceId, authTenantId: ws.tenantId, body: 'x' } });

    // Run 1: the register changed since the export, so the names are held. It then stops after the
    // receipts table is dropped and before the export record goes (the database refuses one delete).
    await withTrigger('workspace_notes', 'BEFORE', `IF OLD.auth_workspace_id = '${ws.workspaceId}' THEN RAISE EXCEPTION 'refused for the test'; END IF; RETURN OLD;`, async () => {
      const error = await eraseCompany(db, ws.tenantId, [ws.workspaceId], { ...deps().all, now: new Date('2026-11-21T10:00:00Z') }).catch((e) => e);
      expect(error).toBeInstanceOf(Error);
      expect((error as { partial?: { exportCoverage?: string; guestCopiesHeld?: number; register?: { tables: number } } }).partial).toMatchObject({
        exportCoverage: 'changed', guestCopiesHeld: 2, register: { tables: 1 },
      });
    });
    expect(await db.dtTable.count({ where: { id: ws.tableId } })).toBe(0);
    expect(await db.companyExport.count({ where: { authTenantId: ws.tenantId } })).toBe(1);
    const held = await db.mealGuest.findMany({ where: { authWorkspaceId: ws.workspaceId }, select: { position: true, contactId: true, retainUntil: true }, orderBy: { position: 'asc' } });
    expect(held.map((g) => [g.contactId, g.retainUntil?.toISOString()])).toEqual([[null, '2036-11-21T10:00:00.000Z'], [null, '2036-11-21T10:00:00.000Z']]);

    // Run 2: the register is empty now and equals the export again. The held names stay, with their date.
    const counts = await eraseCompany(db, ws.tenantId, [ws.workspaceId], { ...deps().all, now: new Date('2027-01-01T10:00:00Z') });
    expect(counts).toMatchObject({ exportCoverage: 'identical', guestCopies: 0, guestCopiesHeld: 2 });
    expect(await db.mealGuest.findMany({ where: { authWorkspaceId: ws.workspaceId }, select: { position: true, contactId: true, retainUntil: true }, orderBy: { position: 'asc' } })).toEqual(held);
  });
});

describe('a printed guest name outside the company that names one of its contacts', () => {
  it('another company\'s meal keeps its printed name: it is neither removed nor held, only its link to the erased contact goes', async () => {
    const c = await company();
    const other = await bystander();
    const contactId = (await companyContacts(c.tenantId).list({ includeArchived: true }))[0].id;
    const foreign = await db.mealGuest.create({
      data: { authWorkspaceId: other.ws.workspaceId, authTenantId: other.ws.tenantId, rowId: other.receipt.rowId, contactId, position: 0, displayName: 'Printed Name', displayCompany: 'Printed Co' },
    });
    // The same in a workspace nobody names and that carries no stamp: not provably the company's either.
    const unnamed = await db.mealGuest.create({
      data: { authWorkspaceId: `test-ws-${randomUUID()}`, authTenantId: null, rowId: `row-${randomUUID()}`, contactId, position: 0, displayName: 'Printed Name', displayCompany: '' },
    });

    const counts = await eraseCompany(db, c.tenantId, c.workspaceIds, deps().all);

    expect(counts).toMatchObject({ guestCopiesHeld: 1, guestLinksCleared: 2, sharedContacts: 1 });
    for (const id of [foreign.id, unnamed.id]) {
      expect(await db.mealGuest.findUniqueOrThrow({ where: { id } })).toMatchObject({ contactId: null, retainUntil: null, displayName: 'Printed Name' });
    }
  });
});

describe('the stamps and the delivery must agree', () => {
  it('rows with the company\'s stamp in a workspace the delivery does not name stop the run: nothing is deleted there or anywhere', async () => {
    const c = await company();
    const d = deps();
    // The delivery names only the second workspace. The first, stamped with the company, is not named:
    // auth-brain says it is not the company's (moved to another company, the restamp here never happened).
    const error = await eraseCompany(db, c.tenantId, [c.second.workspaceId], d.all).catch((e) => e);

    expect(error).toBeInstanceOf(ErasureConflictError);
    // The workspace the rows lie in is named, so nobody has to query for it.
    expect(error).toMatchObject({ kind: 'rows_outside_named_workspaces', workspaces: [c.first.workspaceId] });
    expect((error as ErasureConflictError).tables).toEqual(expect.arrayContaining(['dt_tables', 'receipt_reviews', 'tax_payments', 'workspace_notes']));
    expect(d.removed).toEqual([]);
    expect(await leftOf(c)).toMatchObject({ physicalTables: 2, dtTables: 2, fileRefs: 3, reviews: 3, payments: 1, notes: 1, importConfigs: 1, exports: 1 });
    expect((await companyContacts(c.tenantId).list({ includeArchived: true })).length).toBe(1);
  });

  it('a delivery that names no workspace does not erase by stamp alone: rows of the company stop the run', async () => {
    const c = await company();
    const d = deps();
    const error = await eraseCompany(db, c.tenantId, [], d.all).catch((e) => e);
    expect(error).toMatchObject({ name: 'ErasureConflictError', kind: 'rows_outside_named_workspaces' });
    expect(d.removed).toEqual([]);
    expect(await leftOf(c)).toMatchObject({ physicalTables: 2, dtTables: 2, reviews: 3, payments: 1, exports: 1 });
  });

  it('a company that has nothing here is acknowledged, with or without named workspaces', async () => {
    const d = deps();
    const none = await eraseCompany(db, `test-tenant-${randomUUID()}`, [], d.all);
    const named = await eraseCompany(db, `test-tenant-${randomUUID()}`, [`test-ws-${randomUUID()}`], d.all);
    for (const counts of [none, named]) expect(counts.register).toMatchObject({ tables: 0, receipts: 0, storedFiles: 0, records: {} });
    expect(d.removed).toEqual([]);
  });

  it('rows without a stamp in a workspace the delivery does not name are not the company\'s to erase', async () => {
    const c = await company();
    // Only the first (stamped) workspace is named: the second carries no stamp and is left alone.
    const counts = await eraseCompany(db, c.tenantId, [c.first.workspaceId], deps().all);
    expect(counts.register).toMatchObject({ tables: 1, receipts: 2, storedFiles: 2 });
    expect(await db.dtTable.count({ where: { id: c.second.tableId } })).toBe(1);
    expect(await db.sheetImportConfig.count({ where: { authWorkspaceId: c.second.workspaceId } })).toBe(1);
  });
});

describe('files the store no longer has', () => {
  it('a file the store no longer has is counted apart, not as removed again', async () => {
    const c = await company();
    const d = deps({ deleteStoredFile: vi.fn(async (fileId: string) => (fileId === c.files[0] ? ('already_gone' as const) : ('removed' as const))) });
    expect((await eraseCompany(db, c.tenantId, c.workspaceIds, d.all)).register).toMatchObject({ storedFiles: 2, storedFilesAlreadyGone: 1 });
  });
});

describe('what changes while a run goes on', () => {
  it('a receipt written after the rows were listed is removed with the table', async () => {
    const c = await company();
    let added = false;
    const d = deps({
      deleteStoredFile: vi.fn(async () => {
        if (added) return;
        added = true;
        await c.first.addReceipt(plainMealReceipt());
      }),
    });
    const counts = await eraseCompany(db, c.tenantId, c.workspaceIds, d.all);
    expect(counts.register).toMatchObject({ tables: 2, receipts: 4 });
    expect(await leftOf(c)).toEqual(NOTHING);
  });

  it('a file attached after the files were removed stops the run before its table goes; the next run removes that file too', async () => {
    const c = await company();
    const late = `file-${randomUUID()}`;
    let attached = false;
    const d = deps({
      deleteStoredFile: vi.fn(async () => {
        if (attached) return;
        attached = true;
        await attach(c.first, c.receipts[0].rowId, late);
      }),
    });

    await expect(eraseCompany(db, c.tenantId, c.workspaceIds, d.all)).rejects.toBeInstanceOf(ErasureChangedError);
    // The table that holds the late file is still there, with the reference that names it.
    expect(await db.dtTable.count({ where: { id: c.first.tableId } })).toBe(1);
    expect(await db.dtFile.count({ where: { fileId: late } })).toBe(1);

    const next = deps();
    const counts = await eraseCompany(db, c.tenantId, c.workspaceIds, next.all);
    expect(next.removed).toContain(late);
    expect(counts.register?.storedFiles).toBeGreaterThanOrEqual(1);
    expect(await leftOf(c)).toEqual(NOTHING);
    expect(await db.dtFile.count({ where: { fileId: late } })).toBe(0);
  });
});

describe('a file reference that lands after its table is gone', () => {
  it('a writer that waited for the table to go leaves a reference to a row that no longer exists: its stored file and the reference are removed in the same run', async () => {
    const c = await company();
    const late = `file-${randomUUID()}`;
    const image = (await c.first.adapter.getColumns(c.first.tableId)).find((col) => col.name === 'Receipt Image')!;
    let landed = false;
    const d = deps();
    const counts = await eraseCompany(db, c.tenantId, c.workspaceIds, {
      ...d.all,
      // The step boundary after the last table went: the moment such a writer gets through.
      checkpoint: async () => {
        if (landed || (await db.dtTable.count({ where: { id: { in: [c.first.tableId, c.second.tableId] } } })) > 0) return;
        landed = true;
        await db.dtFile.create({ data: { rowId: c.receipts[0].rowId, columnId: image.id, fileId: late, fileUrl: `/api/files/${late}`, originalName: 'beleg.jpg', mimeType: 'image/jpeg' } });
      },
    });

    expect(landed).toBe(true);
    expect(d.removed).toContain(late);
    expect(counts.register).toMatchObject({ tables: 2, receipts: 3, storedFiles: 4 });
    expect(await db.dtFile.count({ where: { fileId: late } })).toBe(0);
    expect(await leftOf(c)).toEqual(NOTHING);
  });
});

describe('the older row layout and references without a row', () => {
  it('a receipts table whose rows live in the shared dt_rows is erased with its rows and files', async () => {
    const tenantId = `test-tenant-${randomUUID()}`;
    const workspaceId = `test-ws-${randomUUID()}`;
    const table = await db.dtTable.create({ data: { workspaceId, authTenantId: tenantId, name: 'Receipts', migrated: false } });
    const column = await db.dtColumn.create({ data: { tableId: table.id, name: 'Name', type: 'text', position: 0 } });
    await db.dtView.create({ data: { tableId: table.id, name: 'All' } });
    const at = new Date().toISOString();
    const row = await db.dtRow.create({ data: { tableId: table.id, cells: {}, createdAt: at, updatedAt: at } });
    const fileId = `file-${randomUUID()}`;
    await db.dtFile.create({ data: { rowId: row.id, columnId: column.id, fileId, fileUrl: `/api/files/${fileId}`, originalName: 'beleg.jpg', mimeType: 'image/jpeg' } });
    const d = deps();

    const counts = await eraseCompany(db, tenantId, [workspaceId], d.all);

    expect(d.removed).toEqual([fileId]);
    expect(counts.register).toMatchObject({ tables: 1, receipts: 1, storedFiles: 1 });
    expect(await db.dtRow.count({ where: { tableId: table.id } })).toBe(0);
    expect(await db.dtColumn.count({ where: { tableId: table.id } })).toBe(0);
    expect(await db.dtView.count({ where: { tableId: table.id } })).toBe(0);
    expect(await db.dtFile.count({ where: { fileId } })).toBe(0);
    expect(await db.dtTable.count({ where: { id: table.id } })).toBe(0);
  });

  it('a reference whose row is in no table any more does not keep a file: the file goes and the stray reference with it', async () => {
    const c = await company();
    const image = (await c.first.adapter.getColumns(c.first.tableId)).find((col) => col.name === 'Receipt Image')!;
    await db.dtFile.create({
      data: { rowId: `gone-${randomUUID()}`, columnId: image.id, fileId: c.files[0], fileUrl: `/api/files/${c.files[0]}`, originalName: 'beleg.jpg', mimeType: 'image/jpeg' },
    });
    const d = deps();

    const counts = await eraseCompany(db, c.tenantId, c.workspaceIds, d.all);

    expect([...d.removed].sort()).toEqual(c.files);
    expect(counts.register).toMatchObject({ storedFiles: 3, storedFilesKept: 0 });
    expect(counts.notErased?.map((n) => n.what)).not.toContain('stored_files_shown_elsewhere');
    expect(await db.dtFile.count({ where: { fileId: c.files[0] } })).toBe(0);
  });
});

describe('the answer covers what it says', () => {
  it('rows that are still there after the run fail it: the recount, not the deletes, decides', async () => {
    const c = await company();
    // The database quietly keeps one row (a trigger turns its delete into nothing): the delete reports no error.
    await withTrigger('workspace_notes', 'BEFORE', `IF OLD.auth_workspace_id = '${c.first.workspaceId}' THEN RETURN NULL; END IF; RETURN OLD;`, async () => {
      const error = await eraseCompany(db, c.tenantId, c.workspaceIds, deps().all).catch((e) => e);
      expect(error).toBeInstanceOf(ErasureIncompleteError);
      expect((error as ErasureIncompleteError).remaining).toEqual({ workspace_notes: 1 });
    });
    // Without the obstacle the next run finishes.
    await eraseCompany(db, c.tenantId, c.workspaceIds, deps().all);
    expect(await leftOf(c)).toEqual(NOTHING);
  });

  it('a row left in a table below an erased receipt fails the run, although that table carries no stamp', async () => {
    const c = await company();
    const rowId = c.receipts[0].rowId;
    // The choices of a receipt (several options in one cell) hang below the row without a stamp and without a foreign key.
    await db.dtRowSelectValue.create({ data: { rowId, columnId: `col-${randomUUID()}`, optionId: `opt-${randomUUID()}` } });
    const choices = 1;
    await withTrigger('dt_row_select_values', 'BEFORE', `IF OLD.row_id = '${rowId}' THEN RETURN NULL; END IF; RETURN OLD;`, async () => {
      const error = await eraseCompany(db, c.tenantId, c.workspaceIds, deps().all).catch((e) => e);
      expect(error).toBeInstanceOf(ErasureIncompleteError);
      expect((error as ErasureIncompleteError).remaining).toEqual({ dt_row_select_values: choices });
    });
  });

  it('contacts still in the shared contacts database fail the run', async () => {
    const c = await company();
    const error = await eraseCompany(db, c.tenantId, c.workspaceIds, { ...deps().all, countContacts: async () => 2 }).catch((e) => e);
    expect(error).toBeInstanceOf(ErasureIncompleteError);
    expect((error as ErasureIncompleteError).remaining).toEqual({ shared_contacts: 2 });
  });

  it('the real count of the contacts database is used when nothing is injected', async () => {
    const c = await company();
    await eraseCompany(db, c.tenantId, c.workspaceIds, deps().all);
    expect(await companyContacts(c.tenantId).list({ includeArchived: true })).toEqual([]);
  });

  it('a bank session that could not be closed is said in the answer', async () => {
    const c = await company();
    const counts = await eraseCompany(db, c.tenantId, c.workspaceIds, { ...deps().all, endBankConnections: async () => ({ connections: 2, sessionsLeftOpen: 1 }) });
    expect(counts.bankConnections).toBe(2);
    expect(counts.notErased).toContainEqual({ what: 'bank_sessions_not_closed', count: 1 });
  });
});

describe('a signed delivery, with the real ledger', () => {
  const secret = randomBytes(16).toString('hex');
  const sign = (body: string) => `sha256=${createHmac('sha256', secret).update(body, 'utf8').digest('hex')}`;

  function deliver(c: { tenantId: string }, eventId: string, workspaceIds: string[], d: CompanyErasureDeps, options: { db?: typeof db; ledger?: ReturnType<typeof erasureLedger> } = {}) {
    const rawBody = JSON.stringify({ event_id: eventId, kind: 'tenant.erased', tenant_id: c.tenantId, workspace_ids: workspaceIds, requested_at: '2026-11-21T00:00:00Z' });
    return receiveErasureDelivery({
      rawBody,
      signature: sign(rawBody),
      secret,
      ledger: options.ledger ?? erasureLedger(options.db ?? db),
      erase: (tenantId, ids, checkpoint) => eraseCompany(options.db ?? db, tenantId, ids, { ...d, checkpoint }),
      log: () => {},
    });
  }

  it('forward and a delivery after completion: 200 both times, one ledger row that survives the erasure and keeps the first run\'s counts', async () => {
    const c = await company();
    const eventId = `evt-${randomUUID()}`;

    const first = await deliver(c, eventId, c.workspaceIds, deps().all);
    expect(first.status).toBe(200);
    expect(first.body.notErased).toEqual(expect.arrayContaining([expect.objectContaining({ what: 'database_backups', days: 30 })]));

    const again = await deliver(c, eventId, c.workspaceIds, deps().all);
    expect(again.status).toBe(200);

    const row = await db.erasureEvent.findUniqueOrThrow({ where: { eventId } });
    expect(row).toMatchObject({ kind: 'tenant.erased', companyId: c.tenantId, status: 'completed', attempts: 2, workspaceIds: [...c.workspaceIds].sort() });
    expect(row.completedAt).not.toBeNull();
    const runs = row.runs as Array<{ outcome: string; counts: { register: { receipts: number; storedFiles: number } }; notErased: unknown[] }>;
    expect(runs.map((r) => r.outcome)).toEqual(['completed', 'completed']);
    expect(runs[0].counts.register).toMatchObject({ receipts: 3, storedFiles: 3 });
    expect(runs[1].counts.register).toMatchObject({ receipts: 0, storedFiles: 0 });
    expect(runs[0].notErased.length).toBeGreaterThan(0);
    // Ids, counts and codes only.
    expect(JSON.stringify(row)).not.toContain('Printed Name');
  });

  it('a run that stops at the file store answers 502 and is recorded as failed; the next delivery finishes it, even when it names no workspace', async () => {
    const c = await company();
    const eventId = `evt-${randomUUID()}`;
    const refusing = deps({ deleteStoredFile: vi.fn(async () => { throw new Error('file store answered 503'); }) });

    const failed = await deliver(c, eventId, c.workspaceIds, refusing.all);
    expect(failed).toEqual({ status: 502, body: { error: 'Erasure failed; will retry', reason: 'stored_file_not_removed' } });
    expect(await db.erasureEvent.findUniqueOrThrow({ where: { eventId } })).toMatchObject({ status: 'failed', attempts: 1, completedAt: null });
    expect(await db.dtTable.count({ where: { id: { in: [c.first.tableId, c.second.tableId] } } })).toBe(2);

    // The ledger remembers the workspaces this event named before, so the rows without a stamp are still reached.
    const working = deps();
    const done = await deliver(c, eventId, [], working.all);
    expect(done.status).toBe(200);
    expect([...working.removed].sort()).toEqual(c.files);
    expect(await leftOf(c)).toEqual(NOTHING);
    const row = await db.erasureEvent.findUniqueOrThrow({ where: { eventId } });
    expect(row).toMatchObject({ status: 'completed', attempts: 2 });
    const runs = row.runs as Array<{ outcome: string; reason?: string; detail?: { partial?: { sharedContacts?: number; register?: { storedFiles: number } } } }>;
    expect(runs.map((r) => [r.outcome, r.reason])).toEqual([['failed', 'stored_file_not_removed'], ['completed', undefined]]);
    // The failed run says what it had removed before it stopped: the contact was gone, no file yet.
    expect(runs[0].detail?.partial).toMatchObject({ sharedContacts: 1, register: { storedFiles: 0 } });
  });

  it('the workspace list belongs to the event: another event for the same company starts from its own', async () => {
    const c = await company();
    const ledger = erasureLedger(db);
    const one = `evt-${randomUUID()}`;
    expect(await ledger.begin({ eventId: one, kind: 'tenant.erased', companyId: c.tenantId, workspaceIds: ['ws-b', 'ws-a'] })).toEqual({ workspaceIds: ['ws-a', 'ws-b'] });
    expect(await ledger.begin({ eventId: one, kind: 'tenant.erased', companyId: c.tenantId, workspaceIds: ['ws-c'] })).toEqual({ workspaceIds: ['ws-a', 'ws-b', 'ws-c'] });
    expect(await ledger.begin({ eventId: `evt-${randomUUID()}`, kind: 'tenant.erased', companyId: c.tenantId, workspaceIds: ['ws-d'] })).toEqual({ workspaceIds: ['ws-d'] });
  });

  it('an event id recorded for one company is refused for another: 409, nothing erased, the record unchanged', async () => {
    const c = await company();
    const other = await company();
    const eventId = `evt-${randomUUID()}`;
    expect((await deliver(c, eventId, c.workspaceIds, deps().all)).status).toBe(200);

    const d = deps();
    const res = await deliver(other, eventId, other.workspaceIds, d.all);

    expect(res).toEqual({ status: 409, body: { error: 'Erasure refused', reason: 'event_of_another_company' } });
    expect(d.removed).toEqual([]);
    expect(await db.dtTable.count({ where: { id: other.first.tableId } })).toBe(1);
    expect(await db.erasureEvent.findUniqueOrThrow({ where: { eventId } })).toMatchObject({ companyId: c.tenantId, attempts: 1, workspaceIds: [...c.workspaceIds].sort() });
  });

  /** A file store that waits until it is told to go on, so a run can be caught in the middle. */
  function gatedStore() {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let entered!: () => void;
    const atWork = new Promise<void>((resolve) => (entered = resolve));
    const store = deps({ deleteStoredFile: vi.fn(async () => { entered(); await gate; }) });
    return { store, atWork, release };
  }

  it('a delivery while an erasure is at work answers 409 and touches nothing; the event keeps its status, and the run in progress completes', async () => {
    const c = await company();
    const eventId = `evt-${randomUUID()}`;
    const first = gatedStore();
    const running = deliver(c, eventId, c.workspaceIds, first.store.all);
    await first.atWork;

    const second = deps();
    expect(await deliver(c, eventId, c.workspaceIds, second.all)).toEqual({ status: 409, body: { error: 'Erasure failed; will retry', reason: 'already_running' } });
    expect(second.removed).toEqual([]);
    expect(second.all.endBankConnections).not.toHaveBeenCalled();
    // The busy answer is noted, but the event is neither failed nor completed: the first run still decides that.
    const during = await db.erasureEvent.findUniqueOrThrow({ where: { eventId } });
    expect(during).toMatchObject({ status: 'received', attempts: 2 });
    expect(during.leaseToken).not.toBeNull();
    expect((during.runs as Array<{ outcome: string }>).map((r) => r.outcome)).toEqual(['busy']);

    first.release();
    expect((await running).status).toBe(200);
    const row = await db.erasureEvent.findUniqueOrThrow({ where: { eventId } });
    expect(row).toMatchObject({ status: 'completed', attempts: 2, leaseToken: null, leaseUntil: null });
    const runs = row.runs as Array<{ outcome: string; counts?: { register: { storedFiles: number; storedFilesAlreadyGone: number } } }>;
    expect(runs.map((r) => r.outcome)).toEqual(['busy', 'completed']);
    expect(runs[1].counts?.register).toMatchObject({ storedFiles: 3, storedFilesAlreadyGone: 0 });
  });

  it('several companies erased at once on a small connection pool: one works, the others answer 409 at once, nothing waits for a connection, and each completes on its retry', async () => {
    // Two connections for everything: with a lock that kept one open per run, three runs could not all proceed.
    const url = new URL(process.env.TEST_DATABASE_URL!);
    url.searchParams.set('connection_limit', '2');
    url.searchParams.set('pool_timeout', '5');
    const small = new PrismaClient({ datasourceUrl: url.toString() });
    try {
      const companies = [await company(), await company(), await company()];
      const events = companies.map(() => `evt-${randomUUID()}`);
      const first = gatedStore();
      const running = deliver(companies[0], events[0], companies[0].workspaceIds, first.store.all, { db: small });
      await first.atWork;

      const started = Date.now();
      const others = await Promise.all([1, 2].map((i) => deliver(companies[i], events[i], companies[i].workspaceIds, deps().all, { db: small })));
      expect(others.map((r) => [r.status, r.body.reason])).toEqual([[409, 'already_running'], [409, 'already_running']]);
      expect(Date.now() - started).toBeLessThan(4000);
      // The app can still be used meanwhile: an ordinary query gets a connection.
      expect(await small.dtTable.count({ where: { id: companies[1].first.tableId } })).toBe(1);

      first.release();
      expect((await running).status).toBe(200);
      // The retries, as auth-brain sends them later, one after the other.
      for (const i of [1, 2]) expect((await deliver(companies[i], events[i], companies[i].workspaceIds, deps().all, { db: small })).status).toBe(200);
      for (const c of companies) expect(await leftOf(c)).toEqual(NOTHING);
      const rows = await db.erasureEvent.findMany({ where: { eventId: { in: events } }, select: { status: true, leaseToken: true } });
      expect(rows).toEqual([1, 2, 3].map(() => ({ status: 'completed', leaseToken: null })));
    } finally {
      await small.$disconnect();
    }
  });

  it('a lease that ran out and was taken by another run stops the first at its next step: recorded as failed with what it had removed, and the other run\'s lease is left alone', async () => {
    const c = await company();
    const other = await company();
    const eventId = `evt-${randomUUID()}`;
    const otherEvent = `evt-${randomUUID()}`;
    const ledger = erasureLedger(db);
    await ledger.begin({ eventId: otherEvent, kind: 'tenant.erased', companyId: other.tenantId, workspaceIds: other.workspaceIds });
    let taken = false;
    const d = deps({
      deleteStoredFile: vi.fn(async () => {
        if (taken) return;
        taken = true;
        // The first run stalls past its lease (set into the past here), and another delivery takes over.
        await db.$executeRaw`UPDATE erasure_events SET lease_until = (now() AT TIME ZONE 'UTC') - interval '1 second' WHERE event_id = ${eventId}`;
        expect(await ledger.acquire(otherEvent)).not.toBeNull();
      }),
    });

    const res = await deliver(c, eventId, c.workspaceIds, d.all);

    expect(res).toEqual({ status: 502, body: { error: 'Erasure failed; will retry', reason: 'lease_lost' } });
    // It stopped before any table went.
    expect(await db.dtTable.count({ where: { id: { in: [c.first.tableId, c.second.tableId] } } })).toBe(2);
    const row = await db.erasureEvent.findUniqueOrThrow({ where: { eventId } });
    expect(row.status).toBe('failed');
    const runs = row.runs as Array<{ outcome: string; reason: string; detail: { partial: { sharedContacts: number; register: { storedFiles: number } } } }>;
    expect(runs[0]).toMatchObject({ outcome: 'failed', reason: 'lease_lost' });
    expect(runs[0].detail.partial.sharedContacts).toBe(1);
    expect(runs[0].detail.partial.register.storedFiles).toBeGreaterThanOrEqual(1);
    // The run that took over still holds its lease.
    expect((await db.erasureEvent.findUniqueOrThrow({ where: { eventId: otherEvent } })).leaseToken).not.toBeNull();
    // Give it back so later tests of this file find no lease in force.
    await db.erasureEvent.update({ where: { eventId: otherEvent }, data: { leaseToken: null, leaseUntil: null } });
  });

  it('a lease that runs out after the last step does not lose the run: the completion and its counts are recorded', async () => {
    const c = await company();
    const eventId = `evt-${randomUUID()}`;
    const ledger = erasureLedger(db);
    // The lease runs out while the run counts what is left (after its last checkpoint).
    const expiring = { ...deps().all, countContacts: async () => {
      await db.$executeRaw`UPDATE erasure_events SET lease_until = (now() AT TIME ZONE 'UTC') - interval '1 second' WHERE event_id = ${eventId}`;
      return 0;
    } };

    const res = await deliver(c, eventId, c.workspaceIds, expiring, { ledger });

    expect(res.status).toBe(200);
    const row = await db.erasureEvent.findUniqueOrThrow({ where: { eventId } });
    expect(row).toMatchObject({ status: 'completed', leaseToken: null });
    const runs = row.runs as Array<{ outcome: string; counts: { register: { receipts: number; storedFiles: number } } }>;
    expect(runs).toHaveLength(1);
    expect(runs[0].counts.register).toMatchObject({ receipts: 3, storedFiles: 3 });
    expect(await leftOf(c)).toEqual(NOTHING);
  });

  it('a lease nobody renewed runs out by itself: a run whose process died does not block erasures for good', async () => {
    const c = await company();
    const dead = `evt-${randomUUID()}`;
    const ledger = erasureLedger(db);
    await ledger.begin({ eventId: dead, kind: 'tenant.erased', companyId: `test-tenant-${randomUUID()}`, workspaceIds: [] });
    expect(await ledger.acquire(dead)).not.toBeNull();
    const eventId = `evt-${randomUUID()}`;
    expect((await deliver(c, eventId, c.workspaceIds, deps().all)).status).toBe(409);

    await db.$executeRaw`UPDATE erasure_events SET lease_until = (now() AT TIME ZONE 'UTC') - interval '1 second' WHERE event_id = ${dead}`;
    expect((await deliver(c, eventId, c.workspaceIds, deps().all)).status).toBe(200);
  });

  it('rows that remain answer 502 "rows_remain" with the table and count in the ledger', async () => {
    const c = await company();
    const eventId = `evt-${randomUUID()}`;
    await withTrigger('workspace_notes', 'BEFORE', `IF OLD.auth_workspace_id = '${c.first.workspaceId}' THEN RETURN NULL; END IF; RETURN OLD;`, async () => {
      expect(await deliver(c, eventId, c.workspaceIds, deps().all)).toEqual({ status: 502, body: { error: 'Erasure failed; will retry', reason: 'rows_remain' } });
    });
    const row = await db.erasureEvent.findUniqueOrThrow({ where: { eventId } });
    expect(row.status).toBe('failed');
    expect(row.runs).toEqual([expect.objectContaining({ outcome: 'failed', reason: 'rows_remain', detail: expect.objectContaining({ remaining: { workspace_notes: 1 } }) })]);
  });

  it('a conflict answers 502 with the table names in the ledger, and nothing is erased', async () => {
    const c = await company();
    const other = await bystander();
    await db.workspaceNotes.update({ where: { authWorkspaceId: c.first.workspaceId }, data: { authTenantId: other.ws.tenantId } });
    const eventId = `evt-${randomUUID()}`;

    const res = await deliver(c, eventId, c.workspaceIds, deps().all);

    expect(res).toEqual({ status: 502, body: { error: 'Erasure failed; will retry', reason: 'rows_of_another_company' } });
    const row = await db.erasureEvent.findUniqueOrThrow({ where: { eventId } });
    expect(row.runs).toEqual([expect.objectContaining({ outcome: 'failed', reason: 'rows_of_another_company', detail: { tables: ['workspace_notes'], workspaces: [c.first.workspaceId] } })]);
    expect(await db.dtTable.count({ where: { id: c.second.tableId } })).toBe(1);
    expect(await db.dtTable.count({ where: { id: c.first.tableId } })).toBe(1);
  });
});
