import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createWorkspace, db, type TestWorkspace } from '../../../../test/db-helpers';

/**
 * The list narrowed to years and the year counts, against a real database:
 * only receipts of the years come back, the groups that hold them come with the
 * last page, and a table whose dates cannot be read is not narrowed. Auth is
 * the only thing replaced. Run with `pnpm test:db`.
 */

const session = { current: null as null | { memberships: Array<{ id: string; tenantId: string }>; activeWorkspace: { id: string } } };

vi.mock('@/lib/prisma', async () => ({ prisma: (await import('../../../../test/db-helpers')).db }));
vi.mock('@/lib/auth', () => ({
  auth: {
    requireAction: vi.fn(async () => session.current),
    getSession: vi.fn(async () => session.current),
  },
}));

import { getReceiptYear, getRows, getYearCounts } from './actions';
import { createGroup } from '@/lib/groups/service';

let ws: TestWorkspace;
let dateColumnId: string;
let nameColumnId: string;

const base = { Vendor: 'V', Gross: 5, Category: 'Software & Lizenzen', Zuordnung: 'Geschäftlich', Currency: 'EUR', 'FX Rate': 1 };

beforeAll(async () => {
  ws = await createWorkspace();
  const columns = await ws.adapter.getColumns(ws.tableId);
  dateColumnId = columns.find((c) => c.name === 'Date')!.id;
  nameColumnId = columns.find((c) => c.name === 'Name')!.id;
});
beforeEach(() => {
  session.current = { memberships: [{ id: ws.workspaceId, tenantId: ws.tenantId }], activeWorkspace: { id: ws.workspaceId } };
});
afterAll(async () => {
  await db.$disconnect();
});

const ids = (rows: Array<{ id: string }>) => rows.map((r) => r.id);

describe('a list narrowed to years', () => {
  it('counts receipts per year without loading rows, newest first, and groups are no receipts', async () => {
    const w = await createWorkspace();
    session.current = { memberships: [{ id: w.workspaceId, tenantId: w.tenantId }], activeWorkspace: { id: w.workspaceId } };
    const a = await w.addReceipt({ ...base, Name: 'a', Date: '2024-05-01T00:00:00.000Z' });
    await w.addReceipt({ ...base, Name: 'b', Date: '2024-06-01T00:00:00.000Z' });
    await w.addReceipt({ ...base, Name: 'c', Date: '2022-06-01T00:00:00.000Z' });
    await w.addReceipt({ ...base, Name: 'undated' });
    await createGroup(db, w.workspaceId, 'Gruppe', [a]);

    const counts = await getYearCounts(w.tableId);
    expect(counts.years).toEqual([
      { year: 2024, count: 2 },
      { year: 2022, count: 1 },
    ]);
    expect(counts.undated).toBe(1);
  });

  it('returns only the receipts of the years, with the groups that hold some of them', async () => {
    const tag = randomUUID().slice(0, 6);
    const in24 = await ws.addReceipt({ ...base, Name: `in24 ${tag}`, Date: '2024-05-01T00:00:00.000Z' });
    const in24b = await ws.addReceipt({ ...base, Name: `in24b ${tag}`, Date: '2024-07-01T00:00:00.000Z' });
    const in23 = await ws.addReceipt({ ...base, Name: `in23 ${tag}`, Date: '2023-05-01T00:00:00.000Z' });
    const in22 = await ws.addReceipt({ ...base, Name: `in22 ${tag}`, Date: '2022-05-01T00:00:00.000Z' });
    const g24 = await createGroup(db, ws.workspaceId, `Gruppe 2024 ${tag}`, [in24, in24b]);
    const g22 = await createGroup(db, ws.workspaceId, `Gruppe 2022 ${tag}`, [in22]);

    const result = await getRows(ws.tableId, { years: [2024], limit: 500 } as never);
    const got = ids(result.items);
    expect(got).toEqual(expect.arrayContaining([in24, in24b, g24]));
    for (const id of [in23, in22, g22]) expect(got).not.toContain(id);
    // Every receipt of the result lies in the year asked for.
    for (const row of result.items) {
      const day = row.cells[dateColumnId];
      if (typeof day === 'string') expect(day.startsWith('2024')).toBe(true);
    }

    // Several years: exactly those, with the groups of both (a year in between is not loaded).
    const wide = await getRows(ws.tableId, { years: [2022, 2024], limit: 500 } as never);
    expect(ids(wide.items)).toEqual(expect.arrayContaining([in24, in22, g24, g22]));
    expect(ids(wide.items)).not.toContain(in23);
  });

  it('is not narrowed when it is asked for every receipt', async () => {
    const all = await getRows(ws.tableId, { limit: 500 });
    expect(all.items.length).toBeGreaterThan(0);
    const none = await getRows(ws.tableId, { years: [], limit: 500 } as never);
    expect(none.items.length).toBe(all.items.length);
    expect(all.items.some((r) => typeof r.cells[nameColumnId] === 'string')).toBe(true);
  });

  it('keeps a receipt whose date cannot be read out of a narrowed list but never fails on it', async () => {
    const w = await createWorkspace();
    session.current = { memberships: [{ id: w.workspaceId, tenantId: w.tenantId }], activeWorkspace: { id: w.workspaceId } };
    const good = await w.addReceipt({ ...base, Name: 'good', Date: '2024-05-01T00:00:00.000Z' });
    const bad = await w.addReceipt({ ...base, Name: 'bad', Date: 'letzten Sommer' });
    const narrowed = await getRows(w.tableId, { years: [2024], limit: 500 } as never);
    expect(ids(narrowed.items)).toContain(good);
    expect(ids(narrowed.items)).not.toContain(bad);
    // Asked for every receipt it is there.
    expect(ids((await getRows(w.tableId, { limit: 500 })).items)).toEqual(expect.arrayContaining([good, bad]));
  });

  it('answers everything at once and nothing on a further page', async () => {
    const more = await getRows(ws.tableId, { years: [2024], limit: 1, offset: 1 } as never);
    expect(more).toMatchObject({ items: [], hasMore: false });
  });

  it('is not narrowed when the list is sorted: a sort across the years could not be right', async () => {
    const tag = randomUUID().slice(0, 6);
    const a = await ws.addReceipt({ ...base, Name: `sort24 ${tag}`, Date: '2024-05-01T00:00:00.000Z' });
    const b = await ws.addReceipt({ ...base, Name: `sort23 ${tag}`, Date: '2023-05-01T00:00:00.000Z' });
    const result = await getRows(ws.tableId, { years: [2024], sorts: [{ columnId: nameColumnId, direction: 'asc' }], limit: 5000 } as never);
    expect(ids(result.items)).toEqual(expect.arrayContaining([a, b]));
  });

  it('says in which year a receipt lies, for a link that names it', async () => {
    const id = await ws.addReceipt({ ...base, Name: 'year of', Date: '2021-12-31T00:00:00.000Z' });
    const undated = await ws.addReceipt({ ...base, Name: 'no date' });
    expect(await getReceiptYear(id)).toBe(2021);
    expect(await getReceiptYear(undated)).toBeNull();
  });
});
