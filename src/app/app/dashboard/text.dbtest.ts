import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createWorkspace, db, plainMealReceipt, type TestWorkspace } from '../../../../test/db-helpers';

/**
 * The recognized text stays out of the list and is served per receipt: the
 * list of a workspace, the text of one receipt, and a search in the text, each
 * against a real database. Auth is the only thing replaced. Run with `pnpm test:db`.
 */

const session = { current: null as null | { memberships: Array<{ id: string; tenantId: string }>; activeWorkspace: { id: string } } };

vi.mock('@/lib/prisma', async () => ({ prisma: (await import('../../../../test/db-helpers')).db }));
vi.mock('@/lib/auth', () => ({
  auth: {
    requireAction: vi.fn(async () => session.current),
    getSession: vi.fn(async () => session.current),
  },
}));

import { getReceiptText, getRow, getRows, searchReceiptText, updateRow } from './actions';

let ws: TestWorkspace;
let other: TestWorkspace;
let textColumnId: string;
let vendorColumnId: string;

const PAGE = 'Rechnung Nr. 4711\nLinode Cloud Computing\nSumme 59,57 USD';

beforeAll(async () => {
  ws = await createWorkspace();
  other = await createWorkspace();
  const columns = await ws.adapter.getColumns(ws.tableId);
  textColumnId = columns.find((c) => c.name === 'OCR Text')!.id;
  vendorColumnId = columns.find((c) => c.name === 'Vendor')!.id;
});
beforeEach(() => {
  session.current = { memberships: [{ id: ws.workspaceId, tenantId: ws.tenantId }], activeWorkspace: { id: ws.workspaceId } };
});
afterAll(async () => {
  await db.$disconnect();
});

describe('the recognized text of a receipt', () => {
  it('is left out of the list, of one row and of an edit, and is served by its own action', async () => {
    const rowId = await ws.addReceipt(plainMealReceipt({ 'OCR Text': PAGE }));

    const list = await getRows(ws.tableId);
    expect(list.items.find((r) => r.id === rowId)!.cells[textColumnId]).toBe('');
    expect((await getRow(rowId))!.cells[textColumnId]).toBe('');
    const edited = await updateRow(rowId, { [vendorColumnId]: 'Linode' });
    expect(edited.cells[textColumnId]).toBe('');
    expect(edited.cells[vendorColumnId]).toBe('Linode');

    expect(await getReceiptText(rowId)).toBe(PAGE);
    // The stored text itself is untouched by all of this.
    expect((await ws.adapter.getRow(rowId))!.cells[textColumnId]).toBe(PAGE);
  });

  it('is empty for a receipt that has none', async () => {
    const rowId = await ws.addReceipt(plainMealReceipt());
    expect(await getReceiptText(rowId)).toBe('');
  });
});

describe('the search in the recognized text', () => {
  it('finds receipts by a word of their text, ignoring case, and only of this workspace', async () => {
    // A marker no other test of this workspace has written.
    const marker = `Zebrastreifen-${randomUUID().slice(0, 8)}`;
    const page = `Rechnung\n${marker} Cloud Computing\nSumme 59,57 USD`;
    const hit = await ws.addReceipt(plainMealReceipt({ 'OCR Text': page }));
    await ws.addReceipt(plainMealReceipt({ 'OCR Text': 'Etwas ganz anderes' }));
    await other.addReceipt(plainMealReceipt({ 'OCR Text': page }));

    expect(await searchReceiptText(ws.tableId, `${marker.toLowerCase()} cloud`)).toEqual([hit]);
    expect(await searchReceiptText(ws.tableId, 'nichts davon')).toEqual([]);
    // Another company's table is not reachable with this session.
    await expect(searchReceiptText(other.tableId, marker)).rejects.toBeTruthy();
  });

  it('takes the characters of a pattern literally and refuses a term that is too short', async () => {
    const marker = randomUUID().slice(0, 8);
    const rowId = await ws.addReceipt(plainMealReceipt({ 'OCR Text': `Rabatt ${marker} 50% auf alles` }));
    await ws.addReceipt(plainMealReceipt({ 'OCR Text': `Rabatt ${marker} 50 Euro` }));

    expect(await searchReceiptText(ws.tableId, `${marker} 50% auf`)).toEqual([rowId]);
    expect(await searchReceiptText(ws.tableId, '%%%')).toEqual([]);
    expect(await searchReceiptText(ws.tableId, 'Ra')).toEqual([]);
  });
});
