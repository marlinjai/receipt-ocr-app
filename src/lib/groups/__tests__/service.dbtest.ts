import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Column, Row } from '@marlinjai/data-table-core';
import { deleteReceiptRows, loadMealRecords } from '@/lib/meals/service';
import { loadReviewQueue } from '@/lib/review/service';
import { GROUP_KIND, ROW_KIND_COLUMN, isGroupRow, receiptsOnly } from '@/lib/receipts-kind';
import { GroupError } from '../rules';
import { createGroup, moveIntoGroup, removeFromGroup, rowKind } from '../service';
import { groupCellValue, receiptsInGroup, sumOf } from '../view';
import { createWorkspace, db, plainMealReceipt, type TestWorkspace } from '../../../../test/db-helpers';

/**
 * Groups against a real database: the link is the table's own `parent_row_id`,
 * written by this app with its own statements, so the statements themselves
 * are what this file proves. The four paths of the flow, and that a row id
 * from another workspace behaves like one that does not exist. Run with
 * `pnpm test:db`.
 */

let ws: TestWorkspace;
let other: TestWorkspace;
let columns: Column[];
let hotel: string;
let dinner: string;
let licence: string;

const deps = { deleteStoredFile: async () => {} };
const rows = async (): Promise<Row[]> => (await ws.adapter.getRows(ws.tableId, { limit: 500 })).items;
const byId = async (id: string) => (await rows()).find((r) => r.id === id);
const columnId = (name: string) => columns.find((c) => c.name === name)!.id;
const shownSum = async (groupId: string) => {
  const all = await rows();
  return groupCellValue(all.find((r) => r.id === groupId)!, receiptsInGroup(groupId, all, columns), columns.find((c) => c.name === 'Gross')!, columns);
};
const receiptTotal = async () => sumOf(receiptsOnly(await rows(), columns), columnId('Gross'));

const code = async (run: Promise<unknown>): Promise<string> => {
  try {
    await run;
  } catch (e) {
    if (e instanceof GroupError) return e.code;
    throw e;
  }
  return 'no error';
};

beforeAll(async () => {
  ws = await createWorkspace();
  other = await createWorkspace();
  columns = await ws.adapter.getColumns(ws.tableId);
  hotel = await ws.addReceipt({ Name: 'Hotel', Vendor: 'Hotel Nordlicht', Gross: 100, Date: '2026-03-10', Category: 'Reisekosten', Currency: 'EUR', 'FX Rate': 1 });
  dinner = await ws.addReceipt(plainMealReceipt({ Name: 'Abendessen', Vendor: 'Gasthaus Linde', Gross: 40, Date: '2026-03-11' }));
  licence = await ws.addReceipt({ Name: 'Lizenz', Vendor: 'Softwarehaus Beispiel', Gross: 10, Date: '2026-03-12', Category: 'Software & Lizenzen', Currency: 'EUR', 'FX Rate': 1 });
});

afterAll(async () => {
  await db.$disconnect();
});

describe('groups in the receipts table, against the database', () => {
  it('the table has the kind column, and no receipt has a kind', async () => {
    expect(columns.some((c) => c.name === ROW_KIND_COLUMN)).toBe(true);
    expect(await rowKind(db, ws.tableId, columns, hotel)).toBeNull();
    expect(receiptsOnly(await rows(), columns)).toHaveLength(3);
  });

  it('forward, back and changed, reloaded, and after the end', async () => {
    // Forward.
    const groupId = await createGroup(db, ws.workspaceId, 'Messe', [hotel, dinner]);
    expect(await rowKind(db, ws.tableId, columns, groupId)).toBe(GROUP_KIND);
    expect((await byId(hotel))!.parentRowId).toBe(groupId);
    expect((await byId(dinner))!.parentRowId).toBe(groupId);
    expect(isGroupRow((await byId(groupId))!, columns)).toBe(true);
    expect((await byId(groupId))!.cells[columnId('Gross')] ?? null).toBeNull();
    expect(await shownSum(groupId)).toBe(140);
    expect(await receiptTotal()).toBe(150);

    // Nothing that reads receipts sees the group; the meal inside it is listed once.
    expect((await loadMealRecords(db, ws.workspaceId)).map((r) => r.rowId)).toEqual([dinner]);
    expect((await loadReviewQueue(db, ws.workspaceId)).map((e) => e.rowId)).not.toContain(groupId);

    // Back and changed.
    expect(await moveIntoGroup(db, ws.workspaceId, groupId, [hotel])).toBe(0);
    expect(await removeFromGroup(db, ws.workspaceId, [dinner])).toBe(1);
    expect((await byId(dinner))!.parentRowId ?? null).toBeNull();
    expect(await shownSum(groupId)).toBe(100);
    const second = await createGroup(db, ws.workspaceId, 'Kunde', [licence]);
    expect(await moveIntoGroup(db, ws.workspaceId, second, [hotel])).toBe(1);
    expect(await shownSum(groupId)).toBe(0);
    expect(await shownSum(second)).toBe(110);
    expect(await receiptTotal()).toBe(150);

    // Refusals write nothing.
    expect(await code(moveIntoGroup(db, ws.workspaceId, groupId, [second]))).toBe('group_in_group');
    expect(await code(moveIntoGroup(db, ws.workspaceId, hotel, [dinner]))).toBe('group_not_found');
    expect(await code(moveIntoGroup(db, ws.workspaceId, groupId, [dinner, 'no-such-row']))).toBe('row_not_found');
    expect((await byId(dinner))!.parentRowId ?? null).toBeNull();

    // After the end: the group goes, its receipts stay at the top level.
    const result = await deleteReceiptRows(db, { workspaceId: ws.workspaceId, tenantId: ws.tenantId }, [second], deps);
    expect(result.done).toEqual([second]);
    expect(await byId(second)).toBeUndefined();
    expect((await byId(hotel))!.parentRowId ?? null).toBeNull();
    expect((await byId(licence))!.parentRowId ?? null).toBeNull();
    expect(await receiptTotal()).toBe(150);
    expect(await code(moveIntoGroup(db, ws.workspaceId, second, [hotel]))).toBe('group_not_found');
  });

  it('a group of one workspace takes no row of another, and cannot be reached from it', async () => {
    const groupId = await createGroup(db, ws.workspaceId, 'Nur hier');
    const foreign = await other.addReceipt({ Name: 'Fremd', Gross: 5 });
    expect(await code(moveIntoGroup(db, ws.workspaceId, groupId, [foreign]))).toBe('row_not_found');
    expect(await code(moveIntoGroup(db, other.workspaceId, groupId, [foreign]))).toBe('group_not_found');
    expect(await code(removeFromGroup(db, other.workspaceId, [hotel]))).toBe('row_not_found');
  });
});
