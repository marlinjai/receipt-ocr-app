import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createWorkspace, db, type TestWorkspace } from '../../../../test/db-helpers';

/**
 * "Set field" on a selection against a real database: every row of a large
 * selection is written and read back, a row that cannot take the value says
 * why, and nothing is counted that did not land. Auth is the only thing
 * replaced. Run with `pnpm test:db`.
 */

const session = { current: null as null | { memberships: Array<{ id: string; tenantId: string }>; activeWorkspace: { id: string } } };

vi.mock('@/lib/prisma', async () => ({ prisma: (await import('../../../../test/db-helpers')).db }));
vi.mock('@/lib/auth', () => ({
  auth: {
    requireAction: vi.fn(async () => session.current),
    getSession: vi.fn(async () => session.current),
  },
}));

import { getRow, setFieldOnRows } from './actions';
import { createGroup } from '@/lib/groups/service';
import { BULK_SET_PART } from './bulk-set';

let ws: TestWorkspace;
let assignmentId: string;
let business: string;
let personal: string;

const base = { Vendor: 'V', Gross: 5, Category: 'Software & Lizenzen', Zuordnung: 'Privat', Currency: 'EUR', 'FX Rate': 1, Date: '2025-03-01' };

beforeAll(async () => {
  ws = await createWorkspace();
  session.current = { memberships: [{ id: ws.workspaceId, tenantId: ws.tenantId }], activeWorkspace: { id: ws.workspaceId } };
  const columns = await ws.adapter.getColumns(ws.tableId);
  assignmentId = columns.find((c) => c.name === 'Zuordnung')!.id;
  const options = await ws.adapter.getSelectOptions(assignmentId);
  business = options.find((o) => o.name === 'Geschäftlich')!.id;
  personal = options.find((o) => o.name === 'Privat')!.id;
});
beforeEach(() => {
  session.current = { memberships: [{ id: ws.workspaceId, tenantId: ws.tenantId }], activeWorkspace: { id: ws.workspaceId } };
});
afterAll(async () => {
  await db.$disconnect();
});

async function receipts(n: number, tag: string): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) ids.push(await ws.addReceipt({ ...base, Name: `${tag} ${i}` }));
  return ids;
}
const stored = async (id: string) => (await getRow(id))?.cells[assignmentId] ?? null;

describe('"Set field" on a selection', () => {
  it('sets every row of a full part and reads each back', async () => {
    const ids = await receipts(BULK_SET_PART, 'full');
    const outcome = await setFieldOnRows(ids, assignmentId, business);
    expect(outcome.failed).toEqual([]);
    expect(outcome.done.sort()).toEqual([...ids].sort());
    for (const id of ids) expect(await stored(id)).toBe(business);
  });

  it('clears the field', async () => {
    const [id] = await receipts(1, 'clear');
    expect(await setFieldOnRows([id], assignmentId, null)).toEqual({ done: [id], failed: [] });
    expect(await stored(id)).toBeNull();
  });

  it('says why a row was not set and sets the others', async () => {
    const [a, b] = await receipts(2, 'mixed');
    const other = await createWorkspace();
    const foreign = await other.addReceipt({ ...base, Name: 'foreign' });
    const outcome = await setFieldOnRows([a, 'no-such-row', foreign, b], assignmentId, business);
    expect(outcome.done.sort()).toEqual([a, b].sort());
    expect(outcome.failed).toEqual([
      { rowId: 'no-such-row', reason: 'not_found' },
      { rowId: foreign, reason: 'not_found' },
    ]);
    // The row of the other workspace was never written.
    session.current = { memberships: [{ id: other.workspaceId, tenantId: other.tenantId }], activeWorkspace: { id: other.workspaceId } };
    const otherAssignment = (await other.adapter.getColumns(other.tableId)).find((c) => c.name === 'Zuordnung')!.id;
    const otherPersonal = (await other.adapter.getSelectOptions(otherAssignment)).find((o) => o.name === 'Privat')!.id;
    expect((await getRow(foreign))?.cells[otherAssignment]).toBe(otherPersonal);
  });

  it('refuses a value that is no option of the column, writing nothing', async () => {
    const [id] = await receipts(1, 'badvalue');
    const outcome = await setFieldOnRows([id], assignmentId, 'not-an-option');
    expect(outcome).toEqual({ done: [], failed: [{ rowId: id, reason: 'invalid_value' }] });
    expect(await stored(id)).toBe(personal);
  });

  it('refuses a column the bar does not set', async () => {
    const [id] = await receipts(1, 'text');
    const nameId = (await ws.adapter.getColumns(ws.tableId)).find((c) => c.name === 'Name')!.id;
    expect(await setFieldOnRows([id], nameId, 'x')).toEqual({ done: [], failed: [{ rowId: id, reason: 'not_writable' }] });
  });

  it('a group takes the assignment like a receipt', async () => {
    const [id] = await receipts(1, 'grouped');
    const group = await createGroup(db, ws.workspaceId, 'Gruppe bulk', [id]);
    expect(await setFieldOnRows([group], assignmentId, business)).toEqual({ done: [group], failed: [] });
  });

  it('refuses more rows than one part, and a call without rows', async () => {
    const many = Array.from({ length: BULK_SET_PART + 1 }, (_, i) => `r${i}`);
    await expect(setFieldOnRows(many, assignmentId, business)).rejects.toThrow();
    await expect(setFieldOnRows([], assignmentId, business)).rejects.toThrow();
  });

  it('a second run on the same rows changes them again (re-entry)', async () => {
    const ids = await receipts(3, 'again');
    await setFieldOnRows(ids, assignmentId, business);
    const outcome = await setFieldOnRows(ids, assignmentId, personal);
    expect(outcome.done.sort()).toEqual([...ids].sort());
    for (const id of ids) expect(await stored(id)).toBe(personal);
  });

  it('is refused without write access', async () => {
    const [id] = await receipts(1, 'noaccess');
    session.current = { memberships: [{ id: 'another-ws', tenantId: 't' }], activeWorkspace: { id: 'another-ws' } };
    await expect(setFieldOnRows([id], assignmentId, business)).rejects.toThrow();
  });
});
