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
    // The adapter finds a row by looking through every table of the database, which a long-used test database
    // has many of: a generous limit, so the time of that lookup does not fail the test.
  }, 180_000);

  it('a row that already holds the value is done without a write, so a retry never writes twice', async () => {
    const ids = await receipts(3, 'already');
    await setFieldOnRows(ids.slice(0, 2), assignmentId, business);
    const stamp = async (id: string) => (await getRow(id))?.updatedAt?.valueOf();
    const before = await Promise.all(ids.slice(0, 2).map(stamp));
    const outcome = await setFieldOnRows(ids, assignmentId, business);
    expect(outcome.done.sort()).toEqual([...ids].sort());
    expect(await Promise.all(ids.slice(0, 2).map(stamp))).toEqual(before);
  });

  it('sets a column no rule changes for the whole part in one go, and a group only where it may', async () => {
    const [a, b, inside] = await receipts(3, 'plain');
    const group = await createGroup(db, ws.workspaceId, 'Gruppe plain', [inside]);
    const columns = await ws.adapter.getColumns(ws.tableId);
    const categoryId = columns.find((c) => c.name === 'Category')!.id;
    const options = await ws.adapter.getSelectOptions(categoryId);
    const other = options.find((o) => o.name !== 'Software & Lizenzen')!.id;
    const outcome = await setFieldOnRows([a, b, group], categoryId, other);
    expect(outcome.failed).toEqual([]);
    expect(outcome.done.sort()).toEqual([a, b, group].sort());
    for (const id of [a, b, group]) expect((await getRow(id))?.cells[categoryId]).toBe(other);
    // Clearing goes the same way.
    expect((await setFieldOnRows([a], categoryId, null)).done).toEqual([a]);
    expect((await getRow(a))?.cells[categoryId] ?? null).toBeNull();
  });

  it('a group refuses a plain column it may not take', async () => {
    const [inside] = await receipts(1, 'status');
    const group = await createGroup(db, ws.workspaceId, 'Gruppe status', [inside]);
    const statusId = (await ws.adapter.getColumns(ws.tableId)).find((c) => c.name === 'Status')!.id;
    const option = (await ws.adapter.getSelectOptions(statusId))[0].id;
    expect(await setFieldOnRows([group, inside], statusId, option)).toEqual({ done: [inside], failed: [{ rowId: group, reason: 'not_writable' }], left: [] });
  });

  it('hands back the rows it did not touch when its time budget runs out, after writing at least one', async () => {
    const ids = await receipts(3, 'budget');
    const real = Date.now.bind(Date);
    let clock = real();
    // Every look at the clock is ten seconds later: the budget is spent after the first row.
    const now = vi.spyOn(Date, 'now').mockImplementation(() => (clock += 10_000));
    try {
      const outcome = await setFieldOnRows(ids, assignmentId, business);
      expect(outcome.done).toEqual([ids[0]]);
      expect(outcome.left).toEqual(ids.slice(1));
      expect(outcome.failed).toEqual([]);
    } finally {
      now.mockRestore();
    }
    for (const id of ids.slice(1)) expect(await stored(id)).toBe(personal);
  });

  it('clears the field', async () => {
    const [id] = await receipts(1, 'clear');
    expect(await setFieldOnRows([id], assignmentId, null)).toEqual({ done: [id], failed: [], left: [] });
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
    expect(outcome).toEqual({ done: [], failed: [{ rowId: id, reason: 'invalid_value' }], left: [] });
    expect(await stored(id)).toBe(personal);
  });

  it('refuses a column the bar does not set', async () => {
    const [id] = await receipts(1, 'text');
    const nameId = (await ws.adapter.getColumns(ws.tableId)).find((c) => c.name === 'Name')!.id;
    expect(await setFieldOnRows([id], nameId, 'x')).toEqual({ done: [], failed: [{ rowId: id, reason: 'not_writable' }], left: [] });
  });

  it('a group takes the assignment like a receipt', async () => {
    const [id] = await receipts(1, 'grouped');
    const group = await createGroup(db, ws.workspaceId, 'Gruppe bulk', [id]);
    expect(await setFieldOnRows([group], assignmentId, business)).toEqual({ done: [group], failed: [], left: [] });
  });

  it('a group refuses a column it may not take, and the receipts beside it are set', async () => {
    const [inside, beside] = await receipts(2, 'currency');
    const group = await createGroup(db, ws.workspaceId, 'Gruppe currency', [inside]);
    const currencyId = (await ws.adapter.getColumns(ws.tableId)).find((c) => c.name === 'Currency')!.id;
    const usd = (await ws.adapter.getSelectOptions(currencyId)).find((o) => o.name === 'USD')!.id;
    const outcome = await setFieldOnRows([group, beside], currencyId, usd);
    expect(outcome).toEqual({ done: [beside], failed: [{ rowId: group, reason: 'not_writable' }], left: [] });
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

  it('is refused for a session that is no member of the workspace', async () => {
    const [id] = await receipts(1, 'noaccess');
    session.current = { memberships: [{ id: 'another-ws', tenantId: 't' }], activeWorkspace: { id: 'another-ws' } };
    await expect(setFieldOnRows([id], assignmentId, business)).rejects.toThrow();
  });
});
