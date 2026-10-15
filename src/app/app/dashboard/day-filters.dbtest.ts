import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { QueryFilter } from '@marlinjai/data-table-core';
import { createWorkspace, db, type TestWorkspace } from '../../../../test/db-helpers';

/**
 * The filter bar's date comparisons ("is", "after", "before") against a real
 * database: the adapter's own comparison fails here, the list's answers on the
 * day each date names, across years, in a list narrowed to years and in one that
 * is not, with groups. Auth is the only thing replaced. Run with `pnpm test:db`.
 */

const session = { current: null as null | { memberships: Array<{ id: string; tenantId: string }>; activeWorkspace: { id: string } } };

vi.mock('@/lib/prisma', async () => ({ prisma: (await import('../../../../test/db-helpers')).db }));
vi.mock('@/lib/auth', () => ({
  auth: {
    requireAction: vi.fn(async () => session.current),
    getSession: vi.fn(async () => session.current),
  },
}));

import { getRows } from './actions';
import { createGroup } from '@/lib/groups/service';

let ws: TestWorkspace;
let dateId: string;
const rows: Record<string, string> = {};
let group: string;

const base = { Vendor: 'V', Gross: 5, Category: 'Software & Lizenzen', Zuordnung: 'Geschäftlich', Currency: 'EUR', 'FX Rate': 1 };

beforeAll(async () => {
  ws = await createWorkspace();
  session.current = { memberships: [{ id: ws.workspaceId, tenantId: ws.tenantId }], activeWorkspace: { id: ws.workspaceId } };
  dateId = (await ws.adapter.getColumns(ws.tableId)).find((c) => c.name === 'Date')!.id;
  // Dates as the app stores them: a full timestamp from the reader, a plain day from an import, one it cannot read.
  rows.dec31 = await ws.addReceipt({ ...base, Name: 'dec31', Date: '2024-12-31T00:00:00.000Z' });
  rows.jan1 = await ws.addReceipt({ ...base, Name: 'jan1', Date: '2025-01-01' });
  rows.jan2 = await ws.addReceipt({ ...base, Name: 'jan2', Date: '2025-01-02T00:00:00.000Z' });
  rows.jun = await ws.addReceipt({ ...base, Name: 'jun', Date: '2025-06-15T00:00:00.000Z' });
  rows.old = await ws.addReceipt({ ...base, Name: 'old', Date: '2023-03-01T00:00:00.000Z' });
  rows.bad = await ws.addReceipt({ ...base, Name: 'bad', Date: 'letzten Sommer' });
  rows.none = await ws.addReceipt({ ...base, Name: 'none' });
  group = await createGroup(db, ws.workspaceId, 'Gruppe', [rows.jun, rows.old]);
});
beforeEach(() => {
  session.current = { memberships: [{ id: ws.workspaceId, tenantId: ws.tenantId }], activeWorkspace: { id: ws.workspaceId } };
});
afterAll(async () => {
  await db.$disconnect();
});

const on = (operator: QueryFilter['operator'], value: string): QueryFilter[] => [{ columnId: dateId, operator, value }];
const names = (items: Array<{ id: string }>) => {
  const byId = new Map(Object.entries(rows).map(([name, id]) => [id, name]));
  byId.set(group, 'group');
  return items.map((r) => byId.get(r.id) ?? r.id).sort();
};

describe('the filter bar on the date', () => {
  it('fails in the table adapter itself: the reason the list answers it', async () => {
    await expect(ws.adapter.getRows(ws.tableId, { filters: on('greaterThan', '2025-01-01') })).rejects.toThrow();
  });

  it('"after" a day, across the turn of the year, with every year loaded', async () => {
    const result = await getRows(ws.tableId, { filters: on('greaterThan', '2024-12-31'), limit: 200 });
    expect(names(result.items)).toEqual(['group', 'jan1', 'jan2', 'jun']);
    expect(result).toMatchObject({ total: 4, hasMore: false });
  });

  it('"before" a day, across the turn of the year', async () => {
    const result = await getRows(ws.tableId, { filters: on('lessThan', '2025-01-01'), limit: 200 });
    expect(names(result.items)).toEqual(['dec31', 'group', 'old']);
  });

  it('"is" a day, whatever time is stored with it', async () => {
    expect(names((await getRows(ws.tableId, { filters: on('equals', '2025-01-02'), limit: 200 })).items)).toEqual(['jan2']);
    expect(names((await getRows(ws.tableId, { filters: on('equals', '2025-01-01'), limit: 200 })).items)).toEqual(['jan1']);
  });

  it('answers in the years chosen above the table too', async () => {
    const result = await getRows(ws.tableId, { filters: on('greaterThan', '2025-01-01'), years: [2024, 2025], limit: 200 } as never);
    expect(names(result.items)).toEqual(['group', 'jan2', 'jun']);
    const before = await getRows(ws.tableId, { filters: on('lessThan', '2025-01-02'), years: [2025], limit: 200 } as never);
    expect(names(before.items)).toEqual(['jan1']);
  });

  it('answers on a sorted list, in its order', async () => {
    const nameId = (await ws.adapter.getColumns(ws.tableId)).find((c) => c.name === 'Name')!.id;
    const result = await getRows(ws.tableId, { filters: on('greaterThan', '2024-12-31'), sorts: [{ columnId: nameId, direction: 'desc' }], limit: 200 });
    expect(result.items.map((r) => r.cells[nameId])).toEqual(['jun', 'jan2', 'jan1', 'Gruppe']);
  });

  it('comes in one answer: a further page is empty', async () => {
    const more = await getRows(ws.tableId, { filters: on('greaterThan', '2024-12-31'), limit: 200, offset: 200 });
    expect(more).toMatchObject({ items: [], hasMore: false });
  });

  it('a date comparison without a value yet filters nothing', async () => {
    const all = await getRows(ws.tableId, { limit: 200 });
    const blank = await getRows(ws.tableId, { filters: [{ columnId: dateId, operator: 'equals', value: null }], limit: 200 });
    expect(names(blank.items)).toEqual(names(all.items));
  });

  it('goes together with the adapter\'s own filters', async () => {
    const nameId = (await ws.adapter.getColumns(ws.tableId)).find((c) => c.name === 'Name')!.id;
    const result = await getRows(ws.tableId, {
      filters: [...on('greaterThan', '2024-12-31'), { columnId: nameId, operator: 'startsWith', value: 'jan' }],
      limit: 200,
    });
    expect(names(result.items)).toEqual(['jan1', 'jan2']);
  });
});
