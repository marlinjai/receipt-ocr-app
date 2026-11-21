import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';
import { safeTableName } from '@marlinjai/data-table-adapter-shared';
import { createWorkspace, db, plainMealReceipt, type TestWorkspace } from '../../../test/db-helpers';
import { ensureContactsLayout } from '../../../test/contacts-db';
import { companyContacts, contactsDb } from '../contacts/db';
import { SharedContactStore } from '../contacts/shared-store';
import {
  ErasureConflictError,
  StoredFileEraseError,
  UNSTAMPED_MODELS,
  classifyModels,
  countCompanyRemainder,
  eraseCompany,
  type CompanyErasureDeps,
} from '../company-erasure';
import { receiveErasureDelivery } from '../erasure';
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
    endBankConnections: vi.fn(async () => 0),
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
    expect(counts.register).toEqual({ tables: 0, receipts: 0, storedFiles: 0, storedFilesKept: 0, records: {}, companyExports: 0 });
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

  it('a stored file a receipt of another company still shows is kept, with that receipt\'s reference, and the answer counts it', async () => {
    const c = await company();
    const other = await bystander();
    await attach(other.ws, other.receipt.rowId, c.files[0]);
    const d = deps();

    const counts = await eraseCompany(db, c.tenantId, c.workspaceIds, d.all);

    expect([...d.removed].sort()).toEqual(c.files.slice(1));
    expect(counts.register).toMatchObject({ storedFiles: 2, storedFilesKept: 1 });
    expect(counts.notErased).toContainEqual({ what: 'stored_files_shown_by_another_company', count: 1 });
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
    expect((error as ErasureConflictError).tables).toEqual(['workspace_notes']);
    expect(d.removed).toEqual([]);
    expect(await leftOf(c)).toMatchObject({ physicalTables: 2, dtTables: 2, reviews: 3, payments: 1, notes: 1, exports: 1 });
    expect((await companyContacts(c.tenantId).list({ includeArchived: true })).length).toBe(1);
  });

  it('without workspace ids only the stamped rows go: rows without a stamp cannot be told to be the company\'s', async () => {
    const c = await company();
    const d = deps();
    const counts = await eraseCompany(db, c.tenantId, [], d.all);
    expect(counts.register).toMatchObject({ tables: 1, receipts: 2, storedFiles: 2 });
    expect(await db.dtTable.count({ where: { id: c.second.tableId } })).toBe(1);
    expect(await db.sheetImportConfig.count({ where: { authWorkspaceId: c.second.workspaceId } })).toBe(1);
  });
});

describe('a signed delivery, with the real ledger', () => {
  const secret = randomBytes(16).toString('hex');
  const sign = (body: string) => `sha256=${createHmac('sha256', secret).update(body, 'utf8').digest('hex')}`;

  function deliver(c: { tenantId: string }, eventId: string, workspaceIds: string[], d: CompanyErasureDeps) {
    const rawBody = JSON.stringify({ event_id: eventId, kind: 'tenant.erased', tenant_id: c.tenantId, workspace_ids: workspaceIds, requested_at: '2026-11-21T00:00:00Z' });
    return receiveErasureDelivery({
      rawBody,
      signature: sign(rawBody),
      secret,
      ledger: erasureLedger(db),
      erase: (tenantId, ids) => eraseCompany(db, tenantId, ids, d),
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

    // The ledger remembers the workspaces of the first delivery, so the rows without a stamp are still reached.
    const working = deps();
    const done = await deliver(c, eventId, [], working.all);
    expect(done.status).toBe(200);
    expect([...working.removed].sort()).toEqual(c.files);
    expect(await leftOf(c)).toEqual(NOTHING);
    const row = await db.erasureEvent.findUniqueOrThrow({ where: { eventId } });
    expect(row).toMatchObject({ status: 'completed', attempts: 2 });
    expect((row.runs as Array<{ outcome: string; reason?: string }>).map((r) => [r.outcome, r.reason])).toEqual([['failed', 'stored_file_not_removed'], ['completed', undefined]]);
  });

  it('a conflict answers 502 with the table names in the ledger, and nothing is erased', async () => {
    const c = await company();
    const other = await bystander();
    await db.workspaceNotes.update({ where: { authWorkspaceId: c.first.workspaceId }, data: { authTenantId: other.ws.tenantId } });
    const eventId = `evt-${randomUUID()}`;

    const res = await deliver(c, eventId, c.workspaceIds, deps().all);

    expect(res).toEqual({ status: 502, body: { error: 'Erasure failed; will retry', reason: 'rows_of_another_company' } });
    const row = await db.erasureEvent.findUniqueOrThrow({ where: { eventId } });
    expect(row.runs).toEqual([expect.objectContaining({ outcome: 'failed', reason: 'rows_of_another_company', detail: { tables: ['workspace_notes'] } })]);
    expect(await db.dtTable.count({ where: { id: c.first.tableId } })).toBe(1);
  });
});
