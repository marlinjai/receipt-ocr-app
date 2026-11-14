import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { PrismaAdapter } from '@marlinjai/data-table-adapter-prisma';
import { withConnectionLimit } from '../../../test/db-workers';

/**
 * What this app relies on from `@marlinjai/data-table-adapter-prisma` 0.2.3, checked against a real
 * Postgres and the adapter alone (none of the app's own workarounds is in play):
 *
 *  1. A column is created and renamed inside a transaction under a table lock and a taken name is refused,
 *     so two requests can no longer double a column.
 *  2. A row is read with the table's current column list, so a column that was added or dropped while the
 *     app runs does not break the read, even on a client that keeps prepared statements (the app's client
 *     no longer switches them off).
 *  3. A write that names a column the table does not have fails loudly and writes nothing.
 */

// A client exactly as Prisma builds it by default: prepared statements on, several connections.
const cached = new PrismaClient({ datasourceUrl: withConnectionLimit(process.env.TEST_DATABASE_URL!) });
const adapter = new PrismaAdapter({ prisma: cached });

afterAll(async () => {
  await cached.$disconnect();
});

async function newTable() {
  const workspaceId = `test-ws-${randomUUID()}`;
  const table = await adapter.createTable({ workspaceId, name: 'Contract' });
  const name = await adapter.createColumn({ tableId: table.id, name: 'Name', type: 'text', isPrimary: true });
  const amount = await adapter.createColumn({ tableId: table.id, name: 'Amount', type: 'number' });
  return { workspaceId, tableId: table.id, name, amount };
}

describe('columns of one table keep their names unique', () => {
  it('lets exactly one of several simultaneous creates of the same name win', async () => {
    const t = await newTable();
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () => adapter.createColumn({ tableId: t.tableId, name: 'Occasion', type: 'text' })),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    for (const r of results) {
      if (r.status === 'rejected') expect(String(r.reason)).toMatch(/already exists/);
    }
    const columns = await adapter.getColumns(t.tableId);
    expect(columns.filter((c) => c.name === 'Occasion')).toHaveLength(1);
  });

  it('refuses a rename onto a taken name and keeps both columns as they were', async () => {
    const t = await newTable();
    await expect(adapter.updateColumn(t.amount.id, { name: 'Name' })).rejects.toThrow(/already exists/);
    const columns = await adapter.getColumns(t.tableId);
    expect(columns.map((c) => c.name).sort()).toEqual(['Amount', 'Name']);
  });

  it('still renames a column to a free name, and to its own name', async () => {
    const t = await newTable();
    await adapter.updateColumn(t.amount.id, { name: 'Amount' });
    await adapter.updateColumn(t.amount.id, { name: 'Total' });
    expect((await adapter.getColumns(t.tableId)).map((c) => c.name).sort()).toEqual(['Name', 'Total']);
  });

  it('lets a name be reused after its column was deleted', async () => {
    const t = await newTable();
    await adapter.deleteColumn(t.amount.id);
    const again = await adapter.createColumn({ tableId: t.tableId, name: 'Amount', type: 'number' });
    expect(again.id).not.toBe(t.amount.id);
  });
});

describe('a table whose shape changes while rows are read on a client that keeps prepared statements', () => {
  const readEverywhere = (rowId: string) => Promise.all(Array.from({ length: 30 }, () => adapter.getRow(rowId)));

  it('finds the row after a column was added and after one was dropped', async () => {
    const t = await newTable();
    const row = await adapter.createRow({ tableId: t.tableId, cells: { [t.name.id]: 'first', [t.amount.id]: 12 } });
    // Warm a prepared statement on every connection of the pool.
    for (const found of await readEverywhere(row.id)) expect(found?.cells[t.amount.id]).toBe(12);

    const note = await adapter.createColumn({ tableId: t.tableId, name: 'Note', type: 'text' });
    for (const found of await readEverywhere(row.id)) expect(found).not.toBeNull();
    await adapter.updateRow(row.id, { [note.id]: 'hello' });
    for (const found of await readEverywhere(row.id)) expect(found?.cells[note.id]).toBe('hello');

    await adapter.deleteColumn(note.id);
    for (const found of await readEverywhere(row.id)) {
      expect(found).not.toBeNull();
      expect(found?.cells[note.id]).toBeUndefined();
      expect(found?.cells[t.amount.id]).toBe(12);
    }
    // A save after the change still lands.
    const saved = await adapter.updateRow(row.id, { [t.amount.id]: 99 });
    expect(saved.cells[t.amount.id]).toBe(99);
  });

  it('reads rows of the table in a list the same way', async () => {
    const t = await newTable();
    await adapter.createRow({ tableId: t.tableId, cells: { [t.name.id]: 'a', [t.amount.id]: 1 } });
    await Promise.all(Array.from({ length: 12 }, () => adapter.getRows(t.tableId, {})));
    const extra = await adapter.createColumn({ tableId: t.tableId, name: 'Extra', type: 'text' });
    const lists = await Promise.all(Array.from({ length: 12 }, () => adapter.getRows(t.tableId, {})));
    for (const list of lists) {
      expect(list.items).toHaveLength(1);
      expect(list.items[0].cells[extra.id] ?? null).toBeNull();
    }
  });
});

describe('a write that names a column the table does not have', () => {
  it('fails with "Unknown column in row cells" on update and leaves the row untouched', async () => {
    const t = await newTable();
    const row = await adapter.createRow({ tableId: t.tableId, cells: { [t.name.id]: 'keep', [t.amount.id]: 5 } });
    const gone = await adapter.createColumn({ tableId: t.tableId, name: 'Gone', type: 'text' });
    await adapter.deleteColumn(gone.id);

    await expect(adapter.updateRow(row.id, { [t.amount.id]: 6, [gone.id]: 'x' })).rejects.toThrow('Unknown column in row cells');
    const after = await adapter.getRow(row.id);
    expect(after?.cells[t.amount.id]).toBe(5);
    expect(after?.cells[t.name.id]).toBe('keep');
  });

  it('fails the same way on create and creates no row', async () => {
    const t = await newTable();
    await expect(adapter.createRow({ tableId: t.tableId, cells: { [t.name.id]: 'x', 'no-such-column': 1 } })).rejects.toThrow(
      'Unknown column in row cells',
    );
    expect((await adapter.getRows(t.tableId, {})).items).toHaveLength(0);
  });

  it('accepts a write of known columns only, including an empty cell set', async () => {
    const t = await newTable();
    const row = await adapter.createRow({ tableId: t.tableId, cells: { [t.name.id]: 'a' } });
    await expect(adapter.updateRow(row.id, {})).resolves.toBeDefined();
    await expect(adapter.updateRow(row.id, { [t.amount.id]: null })).resolves.toBeDefined();
  });
});
