import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createWorkspace, db, plainMealReceipt, type TestWorkspace } from '../../../../test/db-helpers';

/**
 * The dashboard's row deletes against a real database. Until now they removed
 * the row and left its stored file behind with nothing pointing at it; they
 * now go through the same safe delete as the meals page. Auth and the file
 * store are the only things replaced. Run with `pnpm test:db`.
 */

const session = { current: null as null | { memberships: Array<{ id: string; tenantId: string }>; activeWorkspace: { id: string } } };
const store = { deleted: [] as string[], failFor: new Set<string>() };

vi.mock('@/lib/prisma', async () => ({ prisma: (await import('../../../../test/db-helpers')).db }));
vi.mock('@/lib/auth', () => ({
  auth: {
    requireAction: vi.fn(async () => session.current),
    getSession: vi.fn(async () => session.current),
  },
}));
vi.mock('@/lib/stored-files', () => ({
  deleteStoredFile: vi.fn(async (fileId: string) => {
    if (store.failFor.has(fileId)) throw new Error('file store unavailable');
    store.deleted.push(fileId);
  }),
}));

import { bulkDeleteRows, deleteReceiptsForGood, deleteRow } from './actions';

let ws: TestWorkspace;
let other: TestWorkspace;
let imageColumnId: string;

async function attach(w: TestWorkspace, columnId: string, rowId: string, fileId: string = randomUUID()): Promise<string> {
  await w.adapter.addFileReference({ rowId, columnId, fileId, fileUrl: `/api/files/${fileId}`, originalName: 'beleg.jpg', mimeType: 'image/jpeg', metadata: { source: 'ocr-upload' } });
  return fileId;
}

const imageColumn = async (w: TestWorkspace) => (await w.adapter.getColumns(w.tableId)).find((c) => c.name === 'Receipt Image')!.id;

beforeAll(async () => {
  ws = await createWorkspace();
  other = await createWorkspace();
  imageColumnId = await imageColumn(ws);
});
beforeEach(() => {
  store.deleted = [];
  store.failFor = new Set();
  // A member of `ws` only.
  session.current = { memberships: [{ id: ws.workspaceId, tenantId: ws.tenantId }], activeWorkspace: { id: ws.workspaceId } };
});
afterAll(async () => {
  await db.$disconnect();
});

describe('deleteRow (the table adapter contract)', () => {
  it('removes the stored file, then the row with its file reference, guests, tax decision and review state', async () => {
    const rowId = await ws.addReceipt(plainMealReceipt());
    const fileId = await attach(ws, imageColumnId, rowId);
    await db.taxItemDecision.create({ data: { authWorkspaceId: ws.workspaceId, rowId, allocations: [{ purpose: 'business', shareBp: 10000 }] } });
    await db.receiptReview.create({ data: { rowId, authWorkspaceId: ws.workspaceId, flags: ['total_unconfirmed'] } });

    await deleteRow(rowId);

    expect(store.deleted).toEqual([fileId]);
    expect(await ws.adapter.getRow(rowId)).toBeNull();
    expect(await db.dtFile.count({ where: { rowId } })).toBe(0);
    expect(await db.taxItemDecision.count({ where: { rowId } })).toBe(0);
    expect(await db.receiptReview.count({ where: { rowId } })).toBe(0);
  });

  it('keeps the receipt complete and says so when the file store refuses', async () => {
    const rowId = await ws.addReceipt(plainMealReceipt());
    const fileId = await attach(ws, imageColumnId, rowId);
    store.failFor.add(fileId);

    await expect(deleteRow(rowId)).rejects.toThrow(/stored file could not be deleted/);

    expect(await ws.adapter.getRow(rowId)).not.toBeNull();
    expect(await db.dtFile.count({ where: { rowId, fileId } })).toBe(1);
    // Trying again once the store is back removes it: the first attempt left nothing half-done.
    store.failFor.clear();
    await deleteRow(rowId);
    expect(await ws.adapter.getRow(rowId)).toBeNull();
    expect(store.deleted).toEqual([fileId]);
  });

  it('keeps a stored file that another receipt still shows', async () => {
    const a = await ws.addReceipt(plainMealReceipt());
    const b = await ws.addReceipt(plainMealReceipt());
    const shared = await attach(ws, imageColumnId, a);
    await attach(ws, imageColumnId, b, shared);

    await deleteRow(a);

    expect(store.deleted).toEqual([]);
    expect(await ws.adapter.getRow(a)).toBeNull();
    expect(await db.dtFile.count({ where: { rowId: b, fileId: shared } })).toBe(1);
    // The last receipt that shows the file takes it along.
    await deleteRow(b);
    expect(store.deleted).toEqual([shared]);
  });

  it('a row without a file is simply removed', async () => {
    const rowId = await ws.addReceipt(plainMealReceipt());
    await deleteRow(rowId);
    expect(await ws.adapter.getRow(rowId)).toBeNull();
    expect(store.deleted).toEqual([]);
  });

  it("refuses another workspace's receipt and an unknown id, and removes nothing", async () => {
    const foreign = await other.addReceipt(plainMealReceipt());
    const foreignFile = await attach(other, await imageColumn(other), foreign);

    await expect(deleteRow(foreign)).rejects.toMatchObject({ status: 403 });
    await expect(deleteRow(randomUUID())).rejects.toMatchObject({ status: 404 });

    expect(await other.adapter.getRow(foreign)).not.toBeNull();
    expect(await db.dtFile.count({ where: { rowId: foreign, fileId: foreignFile } })).toBe(1);
    expect(store.deleted).toEqual([]);
  });
});

describe('bulkDeleteRows', () => {
  it('removes every receipt with its file', async () => {
    const ids = [await ws.addReceipt(plainMealReceipt()), await ws.addReceipt(plainMealReceipt())];
    const fileIds = [await attach(ws, imageColumnId, ids[0]), await attach(ws, imageColumnId, ids[1])];

    await bulkDeleteRows(ids);

    expect(store.deleted.sort()).toEqual([...fileIds].sort());
    for (const id of ids) expect(await ws.adapter.getRow(id)).toBeNull();
  });

  it('finishes the rest and fails loudly when one stored file cannot be deleted', async () => {
    const ok = await ws.addReceipt(plainMealReceipt());
    const stuck = await ws.addReceipt(plainMealReceipt());
    const okFile = await attach(ws, imageColumnId, ok);
    const stuckFile = await attach(ws, imageColumnId, stuck);
    store.failFor.add(stuckFile);

    await expect(bulkDeleteRows([ok, stuck])).rejects.toThrow(/1 of 2 receipts could not be deleted/);

    expect(await ws.adapter.getRow(ok)).toBeNull();
    expect(await ws.adapter.getRow(stuck)).not.toBeNull();
    expect(store.deleted).toEqual([okFile]);
  });

  it('refuses the whole batch when one id belongs to another workspace', async () => {
    const mine = await ws.addReceipt(plainMealReceipt());
    const foreign = await other.addReceipt(plainMealReceipt());

    await expect(bulkDeleteRows([mine, foreign])).rejects.toMatchObject({ status: 403 });

    expect(await ws.adapter.getRow(mine)).not.toBeNull();
    expect(await other.adapter.getRow(foreign)).not.toBeNull();
  });
});

describe('deleteReceiptsForGood (the dashboard page)', () => {
  it('reports what was deleted and what was kept, with the reason', async () => {
    const ok = await ws.addReceipt(plainMealReceipt());
    const stuck = await ws.addReceipt(plainMealReceipt());
    await attach(ws, imageColumnId, ok);
    const stuckFile = await attach(ws, imageColumnId, stuck);
    store.failFor.add(stuckFile);
    const gone = randomUUID();

    const outcome = await deleteReceiptsForGood([ok, stuck, gone]);

    expect(outcome.deleted).toEqual([ok]);
    expect(outcome.kept).toEqual(
      expect.arrayContaining([
        { rowId: stuck, reason: 'file_delete_failed' },
        { rowId: gone, reason: 'not_found' },
      ]),
    );
    expect(await ws.adapter.getRow(stuck)).not.toBeNull();
  });

  it('asking twice is harmless: the second call finds nothing left to delete', async () => {
    const rowId = await ws.addReceipt(plainMealReceipt());
    await attach(ws, imageColumnId, rowId);
    expect((await deleteReceiptsForGood([rowId])).deleted).toEqual([rowId]);
    expect(await deleteReceiptsForGood([rowId])).toEqual({ deleted: [], kept: [{ rowId, reason: 'not_found' }] });
  });

  it('refuses an empty or oversized request', async () => {
    await expect(deleteReceiptsForGood([])).rejects.toMatchObject({ status: 404 });
  });
});
