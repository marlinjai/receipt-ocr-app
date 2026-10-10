import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Row } from '@marlinjai/data-table-core';

/**
 * The life of a group, along all four paths a person can take: forward, back
 * and changed, reloaded, and again after the end. The service and the delete
 * path are the real ones; the table sits in memory, with a stand-in that
 * carries out the three statements the link module issues. The same paths run
 * against a real database in `service.dbtest.ts`.
 */

const state = vi.hoisted(() => ({ adapter: null as unknown }));
vi.mock('@marlinjai/data-table-adapter-prisma', () => ({
  PrismaAdapter: class {
    constructor() {
      return state.adapter as object;
    }
  },
}));

import { GROUP_KIND, ROW_KIND_COLUMN, receiptsOnly } from '@/lib/receipts-kind';
import { deleteReceiptRows } from '@/lib/meals/service';
import { groupCellValue, receiptsInGroup } from '../view';
import { createGroup, moveIntoGroup, removeFromGroup } from '../service';
import { GroupError } from '../rules';
import { RECEIPT_IDS, RECEIPT_TOTAL, TABLE_ID, WORKSPACE_ID, columnId, columns, dinner, fakeAdapter, hotel, licence, orphan } from './fixture';
import { sumOf } from '../view';

/** The receipts table in memory: the adapter for rows, the database client for the links. */
function memoryTable(initial: Row[]) {
  const store = new Map<string, Row>(initial.map((r) => [r.id, { ...r, cells: { ...r.cells } }]));
  let created = 0;
  let failNextMove = false;
  let failNextDelete = false;
  const rows = () => [...store.values()];
  const adapter = {
    ...fakeAdapter(),
    getRows: async () => ({ items: rows(), total: store.size, hasMore: false }),
    getRow: async (id: string) => store.get(id) ?? null,
    createRow: async (input: { tableId: string; cells?: Record<string, unknown>; parentRowId?: string }) => {
      const row = { id: `new_${++created}`, tableId: TABLE_ID, cells: { ...(input.cells ?? {}) }, parentRowId: input.parentRowId, archived: false } as unknown as Row;
      store.set(row.id, row);
      return row;
    },
    deleteRow: async (id: string) => {
      if (failNextDelete) {
        failNextDelete = false;
        throw new Error('connection lost');
      }
      store.delete(id);
    },
  };
  const kindId = columnId(ROW_KIND_COLUMN);
  const model = new Proxy({}, { get: (_t, method: string) => async () => (method === 'findMany' ? [] : { count: 0 }) });
  const db: Record<string, unknown> = {
    $transaction: async (run: (tx: unknown) => Promise<unknown>) => run(dbProxy),
    $queryRawUnsafe: async (sql: string, ...ids: string[]) => {
      if (sql.includes('SET parent_row_id = NULL') && sql.includes('RETURNING id')) {
        const children = rows().filter((r) => r.parentRowId === ids[1]);
        for (const child of children) store.set(child.id, { ...child, parentRowId: undefined } as Row);
        return children.map((c) => ({ id: c.id }));
      }
      if (!sql.startsWith('SELECT id, parent_row_id')) throw new Error(`unexpected query: ${sql}`);
      return ids
        .filter((id) => store.has(id))
        .map((id) => {
          const row = store.get(id)!;
          return { id, parent_row_id: row.parentRowId ?? null, archived: row.archived ? 1 : 0, kind: (row.cells[kindId] as string | undefined) ?? null };
        });
    },
    $executeRawUnsafe: async (sql: string, ...params: Array<string | null>) => {
      if (sql.includes('SET parent_row_id = $1::text')) {
        if (failNextMove) {
          failNextMove = false;
          throw new Error('connection lost');
        }
        const [parentId, , ...ids] = params;
        let written = 0;
        for (const id of ids) {
          const row = id ? store.get(id) : undefined;
          if (!row || (row.parentRowId ?? null) === parentId) continue;
          store.set(row.id, { ...row, parentRowId: parentId ?? undefined } as Row);
          written++;
        }
        return written;
      }
      throw new Error(`unexpected statement: ${sql}`);
    },
  };
  const dbProxy = new Proxy(db, { get: (target, prop: string) => (prop in target ? target[prop] : model) }) as never;
  return { adapter, db: dbProxy, rows, row: (id: string) => store.get(id), failNextMove: () => (failNextMove = true), failNextDelete: () => (failNextDelete = true) };
}

const code = async (run: Promise<unknown>): Promise<string> => {
  try {
    await run;
  } catch (e) {
    if (e instanceof GroupError) return e.code;
    throw e;
  }
  return 'no error';
};

const plain = (r: Row) => ({ ...r, parentRowId: undefined }) as Row;
let table: ReturnType<typeof memoryTable>;
const ctx = { workspaceId: WORKSPACE_ID, tenantId: null };

/** What the table shows for a group: the gross sum of the receipts under it. */
const shownSum = (groupId: string) => {
  const group = table.row(groupId)!;
  return groupCellValue(group, receiptsInGroup(groupId, table.rows(), columns), columns.find((c) => c.name === 'Gross')!, columns);
};
/** What every total of the app is built from: the receipts, whatever group they lie in. */
const receiptTotal = () => sumOf(receiptsOnly(table.rows(), columns), columnId('Gross'));
const receiptIds = () => receiptsOnly(table.rows(), columns).map((r) => r.id).sort();

beforeEach(() => {
  table = memoryTable([plain(hotel), plain(dinner), licence, plain(orphan)]);
  state.adapter = table.adapter;
});

describe('forward: create a group and put receipts in', () => {
  it('the group shows the sum of its receipts, and no total of the app changes', async () => {
    const groupId = await createGroup(table.db, WORKSPACE_ID, '  Messe  ', ['hotel', 'dinner']);
    const group = table.row(groupId)!;
    expect(group.cells[columnId('Name')]).toBe('Messe');
    expect(group.cells[columnId(ROW_KIND_COLUMN)]).toBe(GROUP_KIND);
    expect(table.row('hotel')!.parentRowId).toBe(groupId);
    expect(table.row('dinner')!.parentRowId).toBe(groupId);
    expect(shownSum(groupId)).toBe(140);
    // The group is a row of the table now, and still nothing counts it.
    expect(receiptIds()).toEqual([...RECEIPT_IDS].sort());
    expect(receiptTotal()).toBe(RECEIPT_TOTAL);
  });

  it('the group never stores an amount', async () => {
    const groupId = await createGroup(table.db, WORKSPACE_ID, 'Messe', ['hotel', 'dinner']);
    const cells = table.row(groupId)!.cells;
    for (const name of ['Gross', 'Net', 'EUR Equivalent', 'Attributed EUR', 'Business Share %', 'Date']) {
      expect(cells[columnId(name)], name).toBeUndefined();
    }
  });

  it('takes over the category its receipts share, and none when they differ', async () => {
    const same = await createGroup(table.db, WORKSPACE_ID, 'Reise', ['hotel', 'orphan']);
    expect(table.row(same)!.cells[columnId('Category')]).toBe('opt_reisekosten');
    const mixed = await createGroup(table.db, WORKSPACE_ID, 'Gemischt', ['dinner', 'licence']);
    expect(table.row(mixed)!.cells[columnId('Category')]).toBeUndefined();
  });

  it('an empty group is created empty and shows 0', async () => {
    const groupId = await createGroup(table.db, WORKSPACE_ID, 'Leer');
    expect(shownSum(groupId)).toBe(0);
    expect(receiptTotal()).toBe(RECEIPT_TOTAL);
  });

  it('refuses a name that is empty, a row that does not exist and a group as a member, and creates nothing', async () => {
    const before = table.rows().length;
    expect(await code(createGroup(table.db, WORKSPACE_ID, '  ', ['hotel']))).toBe('invalid_name');
    expect(await code(createGroup(table.db, WORKSPACE_ID, 'Messe', ['hotel', 'elsewhere']))).toBe('row_not_found');
    const groupId = await createGroup(table.db, WORKSPACE_ID, 'Messe', ['hotel']);
    expect(await code(createGroup(table.db, WORKSPACE_ID, 'Obergruppe', [groupId]))).toBe('group_in_group');
    expect(table.rows()).toHaveLength(before + 1);
    expect(table.row('hotel')!.parentRowId).toBe(groupId);
  });

  it('leaves no empty group behind when the receipts could not be moved', async () => {
    const before = table.rows().length;
    table.failNextMove();
    await expect(createGroup(table.db, WORKSPACE_ID, 'Messe', ['hotel'])).rejects.toThrow('connection lost');
    expect(table.rows()).toHaveLength(before);
    expect(table.row('hotel')!.parentRowId).toBeUndefined();
  });
});

describe('back and changed: take a receipt out, move it, change its amount', () => {
  it('taking a receipt out lowers the sum and leaves the receipt at the top level', async () => {
    const groupId = await createGroup(table.db, WORKSPACE_ID, 'Messe', ['hotel', 'dinner']);
    expect(await removeFromGroup(table.db, WORKSPACE_ID, ['dinner'])).toBe(1);
    expect(table.row('dinner')!.parentRowId).toBeUndefined();
    expect(shownSum(groupId)).toBe(100);
    expect(receiptTotal()).toBe(RECEIPT_TOTAL);
  });

  it('moving a receipt into another group takes it out of the first: it is never in two', async () => {
    const first = await createGroup(table.db, WORKSPACE_ID, 'Messe', ['hotel', 'dinner']);
    const second = await createGroup(table.db, WORKSPACE_ID, 'Kunde', ['licence']);
    expect(await moveIntoGroup(table.db, WORKSPACE_ID, second, ['dinner'])).toBe(1);
    expect(shownSum(first)).toBe(100);
    expect(shownSum(second)).toBe(50);
    expect(receiptTotal()).toBe(RECEIPT_TOTAL);
  });

  it('putting a receipt into the group it is already in writes nothing', async () => {
    const groupId = await createGroup(table.db, WORKSPACE_ID, 'Messe', ['hotel']);
    expect(await moveIntoGroup(table.db, WORKSPACE_ID, groupId, ['hotel'])).toBe(0);
    expect(await removeFromGroup(table.db, WORKSPACE_ID, ['licence'])).toBe(0);
    expect(shownSum(groupId)).toBe(100);
  });

  it('the sum follows a receipt whose amount is changed, because it is never stored', async () => {
    const groupId = await createGroup(table.db, WORKSPACE_ID, 'Messe', ['hotel', 'dinner']);
    table.row('hotel')!.cells[columnId('Gross')] = 250;
    expect(shownSum(groupId)).toBe(290);
  });

  it('a move is all or nothing: one row that does not exist moves none', async () => {
    const groupId = await createGroup(table.db, WORKSPACE_ID, 'Messe');
    expect(await code(moveIntoGroup(table.db, WORKSPACE_ID, groupId, ['hotel', 'elsewhere']))).toBe('row_not_found');
    expect(table.row('hotel')!.parentRowId).toBeUndefined();
  });

  it('a group does not go into a group, and a receipt is not a group to put rows into', async () => {
    const first = await createGroup(table.db, WORKSPACE_ID, 'Messe');
    const second = await createGroup(table.db, WORKSPACE_ID, 'Kunde');
    expect(await code(moveIntoGroup(table.db, WORKSPACE_ID, first, [second]))).toBe('group_in_group');
    expect(await code(moveIntoGroup(table.db, WORKSPACE_ID, first, [first]))).toBe('group_in_group');
    expect(await code(moveIntoGroup(table.db, WORKSPACE_ID, 'licence', ['hotel']))).toBe('group_not_found');
    expect(await code(moveIntoGroup(table.db, WORKSPACE_ID, 'gone', ['hotel']))).toBe('group_not_found');
    expect(table.row('hotel')!.parentRowId).toBeUndefined();
  });
});

describe('reload: everything is read back from the rows', () => {
  it('a fresh look at the table finds the same groups, links and sums', async () => {
    const groupId = await createGroup(table.db, WORKSPACE_ID, 'Messe', ['hotel', 'dinner']);
    // Nothing but the rows is kept: a copy of them is all a reload has.
    const reloaded = JSON.parse(JSON.stringify(table.rows())) as Row[];
    const group = reloaded.find((r) => r.id === groupId)!;
    const inGroup = receiptsInGroup(groupId, reloaded, columns);
    expect(inGroup.map((r) => r.id)).toEqual(['hotel', 'dinner']);
    expect(groupCellValue(group, inGroup, columns.find((c) => c.name === 'Gross')!, columns)).toBe(140);
    expect(receiptsOnly(reloaded, columns).map((r) => r.id).sort()).toEqual([...RECEIPT_IDS].sort());
  });
});

describe('after the end: delete the group', () => {
  const deps = { deleteStoredFile: async () => {} };

  it('its receipts are released to the top level and none is deleted', async () => {
    const groupId = await createGroup(table.db, WORKSPACE_ID, 'Messe', ['hotel', 'dinner']);
    const result = await deleteReceiptRows(table.db, ctx, [groupId], deps);
    expect(result.done).toEqual([groupId]);
    expect(table.row(groupId)).toBeUndefined();
    expect(table.row('hotel')!.parentRowId).toBeUndefined();
    expect(table.row('dinner')!.parentRowId).toBeUndefined();
    expect(receiptIds()).toEqual([...RECEIPT_IDS].sort());
    expect(receiptTotal()).toBe(RECEIPT_TOTAL);
  });

  it('a delete that fails leaves the group and its receipts linked as they were', async () => {
    const groupId = await createGroup(table.db, WORKSPACE_ID, 'Messe', ['hotel', 'dinner']);
    table.failNextDelete();
    const failed = await deleteReceiptRows(table.db, ctx, [groupId], deps);
    expect(failed.done).toEqual([]);
    expect(failed.skipped).toEqual([{ rowId: groupId, reason: 'failed' }]);
    expect(table.row(groupId)).toBeDefined();
    expect(table.row('hotel')!.parentRowId).toBe(groupId);
    expect(table.row('dinner')!.parentRowId).toBe(groupId);
    // A retry deletes it as usual.
    expect((await deleteReceiptRows(table.db, ctx, [groupId], deps)).done).toEqual([groupId]);
  });

  it('a receipt selected together with its group is deleted, the others stay', async () => {
    const groupId = await createGroup(table.db, WORKSPACE_ID, 'Messe', ['hotel', 'dinner']);
    const result = await deleteReceiptRows(table.db, ctx, [groupId, 'dinner'], deps);
    expect(result.done.sort()).toEqual([groupId, 'dinner'].sort());
    expect(table.row('dinner')).toBeUndefined();
    expect(table.row('hotel')!.parentRowId).toBeUndefined();
  });

  it('an empty group is deleted like any row', async () => {
    const groupId = await createGroup(table.db, WORKSPACE_ID, 'Leer');
    expect((await deleteReceiptRows(table.db, ctx, [groupId], deps)).done).toEqual([groupId]);
    expect(receiptTotal()).toBe(RECEIPT_TOTAL);
  });

  it('a new group of the same name starts empty: nothing of the old one comes back', async () => {
    const first = await createGroup(table.db, WORKSPACE_ID, 'Messe', ['hotel', 'dinner']);
    await deleteReceiptRows(table.db, ctx, [first], deps);
    const second = await createGroup(table.db, WORKSPACE_ID, 'Messe');
    expect(second).not.toBe(first);
    expect(shownSum(second)).toBe(0);
    expect(receiptsInGroup(second, table.rows(), columns)).toEqual([]);
  });

  it('a receipt cannot be put into a group that was deleted meanwhile', async () => {
    const groupId = await createGroup(table.db, WORKSPACE_ID, 'Messe');
    await deleteReceiptRows(table.db, ctx, [groupId], deps);
    expect(await code(moveIntoGroup(table.db, WORKSPACE_ID, groupId, ['hotel']))).toBe('group_not_found');
    expect(table.row('hotel')!.parentRowId).toBeUndefined();
  });

  it('a link left pointing at a group that is gone still counts the receipt once', async () => {
    table = memoryTable([hotel, dinner, licence, orphan]);
    state.adapter = table.adapter;
    // "hotel" and "dinner" point at "group", "orphan" at "deleted-group"; neither row exists.
    expect(receiptIds()).toEqual([...RECEIPT_IDS].sort());
    expect(receiptTotal()).toBe(RECEIPT_TOTAL);
  });
});
