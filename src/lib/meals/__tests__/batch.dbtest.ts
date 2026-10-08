import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { MealDetailsInput } from '../input';
import { incompleteQueue } from '../register';
import { isDismissedMeal, mealStatus } from '../rules';
import {
  contactStore,
  deleteReceiptRows,
  loadMealRecord,
  loadMealRecords,
  saveMealDetails,
  setMealTypeForRows,
  type MealContext,
} from '../service';
import { createWorkspace, db, plainMealReceipt, type TestWorkspace } from '../../../../test/db-helpers';

/**
 * The batch actions of the meals page against a real database: "Keine
 * Bewirtung" and its way back, and deleting receipts with their stored
 * files. The file store is the only thing replaced (a recorder that can be
 * told to fail). Run with `pnpm test:db`.
 */

let ws: TestWorkspace;
let other: TestWorkspace;
let ctx: MealContext;
let otherCtx: MealContext;
let imageColumnId: string;
let otherImageColumnId: string;

beforeAll(async () => {
  ws = await createWorkspace();
  other = await createWorkspace();
  ctx = { workspaceId: ws.workspaceId, tenantId: ws.tenantId };
  otherCtx = { workspaceId: other.workspaceId, tenantId: other.tenantId };
  const imageColumn = async (w: TestWorkspace) => {
    const column = (await w.adapter.getColumns(w.tableId)).find((c) => c.name === 'Receipt Image');
    if (!column) throw new Error('no Receipt Image column');
    return column.id;
  };
  imageColumnId = await imageColumn(ws);
  otherImageColumnId = await imageColumn(other);
});

afterAll(async () => {
  await db.$disconnect();
});

function details(overrides: Partial<MealDetailsInput> = {}): MealDetailsInput {
  return {
    mealType: 'business_meal_external',
    occasion: 'Abstimmung Relaunch Webshop',
    place: 'Testlokal, Musterstraße 1, 12345 Musterstadt',
    host: 'Inhaber Beispiel',
    tip: 11,
    consumption: 'dine_in',
    taxLines: null,
    guestContactIds: [],
    date: null,
    gross: null,
    ...overrides,
  };
}

async function attachFile(w: TestWorkspace, columnId: string, rowId: string, fileId: string = randomUUID()): Promise<string> {
  await w.adapter.addFileReference({
    rowId,
    columnId,
    fileId,
    fileUrl: `/api/files/${fileId}`,
    originalName: 'beleg.pdf',
    mimeType: 'application/pdf',
  });
  return fileId;
}

/** A file store that records what it was asked to delete and fails for the given ids. */
function fileStore(failFor: string[] = []) {
  const deleted: string[] = [];
  const deleteStoredFile = vi.fn(async (fileId: string) => {
    if (failFor.includes(fileId)) throw new Error('file store unavailable');
    deleted.push(fileId);
  });
  return { deleted, deps: { deleteStoredFile } };
}

async function completeMeal(w: TestWorkspace, c: MealContext, contactName: string): Promise<string> {
  const rowId = await w.addReceipt(plainMealReceipt());
  const guest = await contactStore(db, c).create({ name: contactName, companyOrRole: 'Beispiel GmbH' });
  await saveMealDetails(db, c, rowId, details({ guestContactIds: [guest.id] }));
  return rowId;
}

describe('"Keine Bewirtung" for several receipts', () => {
  it('takes them out of the queue, keeps them as receipts, and is the same state the form sets', async () => {
    const w = await createWorkspace();
    const c: MealContext = { workspaceId: w.workspaceId, tenantId: w.tenantId };
    const a = await w.addReceipt(plainMealReceipt({ Name: 'Einkauf A' }));
    const b = await w.addReceipt(plainMealReceipt({ Name: 'Einkauf B' }));
    const stays = await w.addReceipt(plainMealReceipt({ Name: 'Echte Bewirtung' }));
    expect(incompleteQueue(await loadMealRecords(db, w.workspaceId))).toHaveLength(3);

    const result = await setMealTypeForRows(db, c, [a, b], 'not_a_meal');
    expect(result.done).toEqual([a, b]);
    expect(result.skipped).toEqual([]);
    expect(result.records.map((r) => r.mealType)).toEqual(['not_a_meal', 'not_a_meal']);

    // Out of the queue and the register's records; the rows themselves are still there.
    const meals = await loadMealRecords(db, w.workspaceId);
    expect(meals.map((r) => r.rowId)).toEqual([stays]);
    expect(await w.adapter.getRow(a)).not.toBeNull();
    expect(mealStatus((await loadMealRecord(db, w.workspaceId, a))!)).toEqual({ kind: 'not_a_meal' });

    // The meals page can still find them, to take one back.
    const withDismissed = await loadMealRecords(db, w.workspaceId, { includeDismissed: true });
    expect(withDismissed.filter(isDismissedMeal).map((r) => r.rowId).sort()).toEqual([a, b].sort());

    // Exactly what saving the form with "Keine Bewirtung" stores.
    const viaForm = await w.addReceipt(plainMealReceipt({ Name: 'Einkauf A' }));
    await saveMealDetails(db, c, viaForm, {
      mealType: 'not_a_meal', occasion: '', place: '', host: '', tip: null, consumption: null,
      taxLines: null, guestContactIds: [], date: null, gross: null,
    });
    const strip = (r: Awaited<ReturnType<typeof loadMealRecord>>) => ({ ...r!, rowId: '', detailsAt: '' });
    expect(strip(await loadMealRecord(db, w.workspaceId, a))).toEqual(strip(await loadMealRecord(db, w.workspaceId, viaForm)));
  });

  it('is reversible: details and guests are kept, and taking the receipt back restores the complete entry', async () => {
    const rowId = await completeMeal(ws, ctx, 'Erika Rueckweg');
    const before = (await loadMealRecord(db, ws.workspaceId, rowId))!;
    expect(mealStatus(before)).toEqual({ kind: 'complete' });

    await setMealTypeForRows(db, ctx, [rowId], 'not_a_meal');
    const dismissed = (await loadMealRecord(db, ws.workspaceId, rowId))!;
    expect(mealStatus(dismissed)).toEqual({ kind: 'not_a_meal' });
    expect(dismissed).toMatchObject({ occasion: before.occasion, place: before.place, host: before.host, tip: 11 });
    expect(dismissed.guests).toEqual(before.guests);

    const back = await setMealTypeForRows(db, ctx, [rowId], 'business_meal_external');
    expect(back.done).toEqual([rowId]);
    expect(mealStatus(back.records[0])).toEqual({ kind: 'complete' });
    expect({ ...back.records[0], detailsAt: null }).toEqual({ ...before, detailsAt: null });
  });

  it('a repeated request changes nothing, not even the timestamp', async () => {
    const rowId = await ws.addReceipt(plainMealReceipt());
    const first = await setMealTypeForRows(db, ctx, [rowId], 'not_a_meal', () => new Date('2025-04-01T08:00:00.000Z'));
    const second = await setMealTypeForRows(db, ctx, [rowId, rowId], 'not_a_meal', () => new Date('2025-04-02T08:00:00.000Z'));
    expect(second.done).toEqual([rowId]);
    expect(second.records[0].detailsAt).toBe(first.records[0].detailsAt);
  });

  it('one receipt was deleted in another tab: the others are done, the missing one is reported', async () => {
    const a = await ws.addReceipt(plainMealReceipt());
    const gone = await ws.addReceipt(plainMealReceipt());
    const c = await ws.addReceipt(plainMealReceipt());
    await ws.adapter.deleteRow(gone);

    const result = await setMealTypeForRows(db, ctx, [a, gone, c], 'not_a_meal');
    expect(result.done).toEqual([a, c]);
    expect(result.skipped).toEqual([{ rowId: gone, reason: 'not_found' }]);
  });

  it('workspace isolation: a receipt of another workspace is refused and left exactly as it was', async () => {
    const mine = await ws.addReceipt(plainMealReceipt());
    const foreign = await completeMeal(other, otherCtx, 'Fremder Gast');
    const before = await loadMealRecord(db, other.workspaceId, foreign);

    const result = await setMealTypeForRows(db, ctx, [foreign, mine], 'not_a_meal');
    expect(result.done).toEqual([mine]);
    expect(result.skipped).toEqual([{ rowId: foreign, reason: 'not_found' }]);
    expect(await loadMealRecord(db, other.workspaceId, foreign)).toEqual(before);
  });
});

describe('deleting receipts', () => {
  it('removes the stored file, the row, its file references and its guests', async () => {
    const rowId = await completeMeal(ws, ctx, 'Erika Loeschen');
    const fileId = await attachFile(ws, imageColumnId, rowId);
    const store = fileStore();

    const result = await deleteReceiptRows(db, ctx, [rowId], store.deps);
    expect(result).toEqual({ done: [rowId], records: [], skipped: [] });
    expect(store.deleted).toEqual([fileId]);
    expect(await ws.adapter.getRow(rowId)).toBeNull();
    expect(await db.dtFile.count({ where: { rowId } })).toBe(0);
    expect(await db.mealGuest.count({ where: { rowId } })).toBe(0);
    expect(await loadMealRecord(db, ws.workspaceId, rowId)).toBeNull();
  });

  it('takes the receipt\'s tax decision with it', async () => {
    const rowId = await completeMeal(ws, ctx, 'Erika Entscheidung');
    await db.taxItemDecision.create({
      data: { authWorkspaceId: ws.workspaceId, rowId, allocations: [{ purpose: 'business', shareBp: 10000 }] },
    });

    const result = await deleteReceiptRows(db, ctx, [rowId], fileStore().deps);
    expect(result.done).toEqual([rowId]);
    expect(await db.taxItemDecision.count({ where: { rowId } })).toBe(0);
  });

  it('deleting every open receipt leaves an empty queue', async () => {
    const w = await createWorkspace();
    const c: MealContext = { workspaceId: w.workspaceId, tenantId: w.tenantId };
    const ids = [await w.addReceipt(plainMealReceipt()), await w.addReceipt(plainMealReceipt())];
    const result = await deleteReceiptRows(db, c, ids, fileStore().deps);
    expect(result.done).toEqual(ids);
    expect(await loadMealRecords(db, w.workspaceId, { includeDismissed: true })).toEqual([]);
  });

  it('partial failure: one receipt already deleted in another tab, the rest is deleted and the missing one reported', async () => {
    const a = await ws.addReceipt(plainMealReceipt());
    const gone = await ws.addReceipt(plainMealReceipt());
    const c = await ws.addReceipt(plainMealReceipt());
    const fileA = await attachFile(ws, imageColumnId, a);
    await ws.adapter.deleteRow(gone);
    const store = fileStore();

    const result = await deleteReceiptRows(db, ctx, [a, gone, c], store.deps);
    expect(result.done).toEqual([a, c]);
    expect(result.skipped).toEqual([{ rowId: gone, reason: 'not_found' }]);
    expect(store.deleted).toEqual([fileA]);
    expect(await ws.adapter.getRow(a)).toBeNull();
    expect(await ws.adapter.getRow(c)).toBeNull();
  });

  it('the stored file cannot be deleted: the row, its file reference and its guests all stay, the others are deleted', async () => {
    const stuck = await completeMeal(ws, ctx, 'Erika Bleibt');
    const fine = await ws.addReceipt(plainMealReceipt());
    const stuckFile = await attachFile(ws, imageColumnId, stuck);
    const fineFile = await attachFile(ws, imageColumnId, fine);
    const failing = fileStore([stuckFile]);

    const result = await deleteReceiptRows(db, ctx, [stuck, fine], failing.deps);
    expect(result.done).toEqual([fine]);
    expect(result.skipped).toEqual([{ rowId: stuck, reason: 'file_delete_failed' }]);
    expect(failing.deleted).toEqual([fineFile]);

    // Nothing of the stuck receipt was touched: it is still a complete meal with its file.
    const record = (await loadMealRecord(db, ws.workspaceId, stuck))!;
    expect(mealStatus(record)).toEqual({ kind: 'complete' });
    expect(record.files.map((f) => f.fileId)).toEqual([stuckFile]);
    expect(record.guests).toHaveLength(1);
    expect(await ws.adapter.getRow(fine)).toBeNull();

    // A retry once the file store works again deletes it.
    const retry = fileStore();
    expect((await deleteReceiptRows(db, ctx, [stuck], retry.deps)).done).toEqual([stuck]);
    expect(retry.deleted).toEqual([stuckFile]);
    expect(await ws.adapter.getRow(stuck)).toBeNull();
  });

  it('a receipt with two files where the second cannot be deleted is kept, without a reference to the file already gone', async () => {
    const rowId = await ws.addReceipt(plainMealReceipt());
    const first = await attachFile(ws, imageColumnId, rowId);
    const second = await attachFile(ws, imageColumnId, rowId);
    const failing = fileStore([second]);

    const result = await deleteReceiptRows(db, ctx, [rowId], failing.deps);
    expect(result.skipped).toEqual([{ rowId, reason: 'file_delete_failed' }]);
    expect(failing.deleted).toEqual([first]);
    expect(await ws.adapter.getRow(rowId)).not.toBeNull();
    const refs = await db.dtFile.findMany({ where: { rowId }, select: { fileId: true } });
    expect(refs.map((r) => r.fileId)).toEqual([second]);

    // A retry once the file store works again deletes the remaining file and the receipt.
    const retry = fileStore();
    expect((await deleteReceiptRows(db, ctx, [rowId], retry.deps)).done).toEqual([rowId]);
    expect(retry.deleted).toEqual([second]);
  });

  it('a stored file another receipt still uses is kept; it goes with the last receipt that uses it', async () => {
    const a = await ws.addReceipt(plainMealReceipt());
    const b = await ws.addReceipt(plainMealReceipt());
    const shared = await attachFile(ws, imageColumnId, a);
    await attachFile(ws, imageColumnId, b, shared);

    const first = fileStore();
    expect((await deleteReceiptRows(db, ctx, [a], first.deps)).done).toEqual([a]);
    expect(first.deleted).toEqual([]);
    expect((await loadMealRecord(db, ws.workspaceId, b))!.files.map((f) => f.fileId)).toEqual([shared]);

    const second = fileStore();
    expect((await deleteReceiptRows(db, ctx, [b], second.deps)).done).toEqual([b]);
    expect(second.deleted).toEqual([shared]);
  });

  it('both receipts sharing a file in one batch: the file is deleted once, with the second', async () => {
    const a = await ws.addReceipt(plainMealReceipt());
    const b = await ws.addReceipt(plainMealReceipt());
    const shared = await attachFile(ws, imageColumnId, a);
    await attachFile(ws, imageColumnId, b, shared);
    const store = fileStore();
    expect((await deleteReceiptRows(db, ctx, [a, b], store.deps)).done).toEqual([a, b]);
    expect(store.deleted).toEqual([shared]);
  });

  it('workspace isolation: a selection spanning another workspace deletes only the own receipt', async () => {
    const mine = await ws.addReceipt(plainMealReceipt());
    const foreign = await completeMeal(other, otherCtx, 'Fremder Gast Zwei');
    const foreignFile = await attachFile(other, otherImageColumnId, foreign);
    const before = await loadMealRecord(db, other.workspaceId, foreign);
    const store = fileStore();

    const result = await deleteReceiptRows(db, ctx, [foreign, mine], store.deps);
    expect(result.done).toEqual([mine]);
    expect(result.skipped).toEqual([{ rowId: foreign, reason: 'not_found' }]);
    // Neither the foreign row, nor its file, nor its guests were touched.
    expect(store.deleted).toEqual([]);
    expect(store.deps.deleteStoredFile).not.toHaveBeenCalledWith(foreignFile);
    expect(await loadMealRecord(db, other.workspaceId, foreign)).toEqual(before);
    expect(await db.mealGuest.count({ where: { rowId: foreign } })).toBe(1);
    expect(await db.dtFile.count({ where: { rowId: foreign } })).toBe(1);
  });

  it('a file of the own receipt that a receipt of another workspace also references is not destroyed', async () => {
    const mine = await ws.addReceipt(plainMealReceipt());
    const foreign = await other.addReceipt(plainMealReceipt());
    const shared = await attachFile(ws, imageColumnId, mine);
    await attachFile(other, otherImageColumnId, foreign, shared);
    const store = fileStore();
    expect((await deleteReceiptRows(db, ctx, [mine], store.deps)).done).toEqual([mine]);
    expect(store.deleted).toEqual([]);
    expect(await db.dtFile.count({ where: { rowId: foreign, fileId: shared } })).toBe(1);
  });

  it('deleting the same receipt twice: the second request reports it as gone and deletes nothing', async () => {
    const rowId = await ws.addReceipt(plainMealReceipt());
    const fileId = await attachFile(ws, imageColumnId, rowId);
    const store = fileStore();
    await deleteReceiptRows(db, ctx, [rowId], store.deps);
    const again = await deleteReceiptRows(db, ctx, [rowId, rowId], store.deps);
    expect(again).toEqual({ done: [], records: [], skipped: [{ rowId, reason: 'not_found' }] });
    expect(store.deleted).toEqual([fileId]);
  });
});
