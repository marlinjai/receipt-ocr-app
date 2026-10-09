import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { PrismaAdapter } from '@marlinjai/data-table-adapter-prisma';
import type { Column } from '@marlinjai/data-table-core';
import { withoutStatementCache } from '../prisma-url';
import { ensureReceiptsTable, receiptsSchemaIsCurrent } from '../receipts-table';
import { loadMealRecord, saveMealDetails, type MealContext } from '../meals/service';
import type { MealDetailsInput } from '../meals/input';
import { createWorkspace, db, plainMealReceipt, type TestWorkspace } from '../../../test/db-helpers';

/**
 * The live Receipts table once held seven meal columns twice: two page loads
 * had each found them missing and each created them. Saves went into one
 * "Occasion" column and reads came from the other, so a saved occasion read
 * back empty while the page said "Gespeichert". These tests hold the three
 * parts of the repair: reads and writes agree, the duplicate is folded back
 * without losing a value, and concurrent calls can no longer create one.
 */

afterAll(async () => {
  await db.$disconnect();
});

const named = (columns: Column[], name: string) => columns.filter((c) => c.name === name);

function details(overrides: Partial<MealDetailsInput> = {}): MealDetailsInput {
  return {
    mealType: 'business_meal_external',
    occasion: 'Abstimmung Relaunch Webshop',
    place: 'Testlokal, Musterstraße 1, 12345 Musterstadt',
    host: 'Inhaber Beispiel',
    tip: null,
    consumption: 'dine_in',
    taxLines: null,
    guestContactIds: [],
    date: null,
    gross: null,
    ...overrides,
  };
}

/** A second column under an existing name, as the race left it: same type, own select options. */
async function duplicate(ws: TestWorkspace, name: string): Promise<Column> {
  const original = named(await ws.adapter.getColumns(ws.tableId), name)[0];
  const copy = await ws.adapter.createColumn({ tableId: ws.tableId, name, type: original.type, config: original.config });
  if (original.type === 'select') {
    for (const option of await ws.adapter.getSelectOptions(original.id)) {
      await ws.adapter.createSelectOption({ columnId: copy.id, name: option.name, color: option.color });
    }
  }
  return copy;
}

const ensure = (ws: TestWorkspace) => ensureReceiptsTable(ws.adapter, ws.workspaceId, { db, tenantId: ws.tenantId });

describe('a table that holds a meal column twice', () => {
  it('a saved occasion reads back, even before the duplicate is repaired', async () => {
    const ws = await createWorkspace();
    const ctx: MealContext = { workspaceId: ws.workspaceId, tenantId: ws.tenantId };
    for (const name of ['Occasion', 'Place', 'Host', 'Consumption', 'Meal Details At']) await duplicate(ws, name);
    const rowId = await ws.addReceipt(plainMealReceipt());

    const saved = await saveMealDetails(db, ctx, rowId, details());
    expect(saved.changed).toBe(true);

    const record = await loadMealRecord(db, ws.workspaceId, rowId);
    expect(record).toMatchObject({
      occasion: 'Abstimmung Relaunch Webshop',
      place: 'Testlokal, Musterstraße 1, 12345 Musterstadt',
      host: 'Inhaber Beispiel',
      consumption: 'dine_in',
    });
    expect(record!.detailsAt).not.toBeNull();
  });

  it('the next page load folds the duplicate into one column and keeps every value', async () => {
    const ws = await createWorkspace();
    const before = await ws.adapter.getColumns(ws.tableId);
    const occasion = named(before, 'Occasion')[0];
    const consumption = named(before, 'Consumption')[0];
    const occasionCopy = await duplicate(ws, 'Occasion');
    const consumptionCopy = await duplicate(ws, 'Consumption');
    const takeawayCopy = (await ws.adapter.getSelectOptions(consumptionCopy.id))[1];

    // One value only in the older column, one only in the newer, one on an archived row.
    const inOlder = await ws.addReceipt(plainMealReceipt());
    const inNewer = await ws.addReceipt(plainMealReceipt());
    const archived = await ws.addReceipt(plainMealReceipt());
    await ws.adapter.updateRow(inOlder, { [occasion.id]: 'Abnahme Fotoproduktion' });
    await ws.adapter.updateRow(inNewer, { [occasionCopy.id]: 'Planung Messeauftritt', [consumptionCopy.id]: takeawayCopy.id });
    await ws.adapter.updateRow(archived, { [occasionCopy.id]: 'Jahresgespräch' });
    await ws.adapter.archiveRow(archived);

    expect(receiptsSchemaIsCurrent(await ws.adapter.getColumns(ws.tableId), await ws.adapter.getViews(ws.tableId))).toBe(false);
    await ensure(ws);

    const after = await ws.adapter.getColumns(ws.tableId);
    expect(named(after, 'Occasion').map((c) => c.id)).toEqual([occasion.id]);
    expect(named(after, 'Consumption').map((c) => c.id)).toEqual([consumption.id]);
    expect(receiptsSchemaIsCurrent(after, await ws.adapter.getViews(ws.tableId))).toBe(true);

    expect((await loadMealRecord(db, ws.workspaceId, inOlder))!.occasion).toBe('Abnahme Fotoproduktion');
    const moved = await loadMealRecord(db, ws.workspaceId, inNewer);
    expect(moved!.occasion).toBe('Planung Messeauftritt');
    // The select value was an option of the removed column: it now points at the kept column's option.
    expect(moved!.consumption).toBe('takeaway');
    expect((await ws.adapter.getRow(archived))!.cells[occasion.id]).toBe('Jahresgespräch');
  });

  it('two different values for one receipt are both kept: the newer column is renamed, never deleted', async () => {
    const ws = await createWorkspace();
    const host = named(await ws.adapter.getColumns(ws.tableId), 'Host')[0];
    const hostCopy = await duplicate(ws, 'Host');
    const rowId = await ws.addReceipt(plainMealReceipt());
    await ws.adapter.updateRow(rowId, { [host.id]: 'Erste Gastgeberin', [hostCopy.id]: 'Zweiter Gastgeber' });

    await ensure(ws);

    const after = await ws.adapter.getColumns(ws.tableId);
    expect(named(after, 'Host').map((c) => c.id)).toEqual([host.id]);
    expect(after.find((c) => c.id === hostCopy.id)?.name).toBe('Host (duplicate 2)');
    const row = await ws.adapter.getRow(rowId);
    expect(row!.cells[host.id]).toBe('Erste Gastgeberin');
    expect(row!.cells[hostCopy.id]).toBe('Zweiter Gastgeber');
    expect((await loadMealRecord(db, ws.workspaceId, rowId))!.host).toBe('Erste Gastgeberin');

    // Settled: a later page load neither renames again nor touches the columns.
    await ensure(ws);
    expect((await ws.adapter.getColumns(ws.tableId)).map((c) => c.name).sort()).toEqual(after.map((c) => c.name).sort());
  });

  it('the same value in both columns is one value: the duplicate goes', async () => {
    const ws = await createWorkspace();
    const place = named(await ws.adapter.getColumns(ws.tableId), 'Place')[0];
    const placeCopy = await duplicate(ws, 'Place');
    const rowId = await ws.addReceipt(plainMealReceipt());
    await ws.adapter.updateRow(rowId, { [place.id]: 'Testlokal, Musterstadt', [placeCopy.id]: 'Testlokal, Musterstadt' });

    await ensure(ws);

    expect(named(await ws.adapter.getColumns(ws.tableId), 'Place').map((c) => c.id)).toEqual([place.id]);
    expect((await loadMealRecord(db, ws.workspaceId, rowId))!.place).toBe('Testlokal, Musterstadt');
  });

  it("a person's own columns that share a name are left alone", async () => {
    const ws = await createWorkspace();
    await ws.adapter.createColumn({ tableId: ws.tableId, name: 'Notiz', type: 'text' });
    await ws.adapter.createColumn({ tableId: ws.tableId, name: 'Notiz', type: 'text' });
    // Force the repair path to run by also duplicating a column the app owns.
    await duplicate(ws, 'Occasion');

    await ensure(ws);

    const after = await ws.adapter.getColumns(ws.tableId);
    expect(named(after, 'Notiz')).toHaveLength(2);
    expect(named(after, 'Occasion')).toHaveLength(1);
  });
});

describe('ensureReceiptsTable called by several requests at once', () => {
  const namesOnce = (names: string[]) => names.length === new Set(names).size;

  it('creates one table with every column and view once', async () => {
    const workspaceId = `test-ws-${randomUUID()}`;
    await Promise.all(
      Array.from({ length: 6 }, () =>
        ensureReceiptsTable(new PrismaAdapter({ prisma: db }), workspaceId, { db, tenantId: 'tenant-a' }),
      ),
    );

    const adapter = new PrismaAdapter({ prisma: db });
    const tables = (await adapter.listTables(workspaceId)).filter((t) => t.name === 'Receipts');
    expect(tables).toHaveLength(1);
    const columns = await adapter.getColumns(tables[0].id);
    const views = await adapter.getViews(tables[0].id);
    expect(namesOnce(columns.map((c) => c.name))).toBe(true);
    expect(namesOnce(views.map((v) => v.name))).toBe(true);
    expect(receiptsSchemaIsCurrent(columns, views)).toBe(true);
  });

  it('does so on a pool of three connections: a waiting request holds none', async () => {
    // Requests that queued on the lock inside a transaction each kept a
    // connection, and the one doing the work ran out of them.
    const address = new URL(process.env.TEST_DATABASE_URL!);
    address.searchParams.set('connection_limit', '3');
    const small = new PrismaClient({ datasourceUrl: withoutStatementCache(address.toString()) });
    try {
      const workspaceId = `test-ws-${randomUUID()}`;
      await Promise.all(
        Array.from({ length: 8 }, () =>
          ensureReceiptsTable(new PrismaAdapter({ prisma: small }), workspaceId, { db: small, tenantId: 'tenant-a' }),
        ),
      );
      const adapter = new PrismaAdapter({ prisma: small });
      const tables = (await adapter.listTables(workspaceId)).filter((t) => t.name === 'Receipts');
      expect(tables).toHaveLength(1);
      const columns = await adapter.getColumns(tables[0].id);
      expect(namesOnce(columns.map((c) => c.name))).toBe(true);
      expect(receiptsSchemaIsCurrent(columns, await adapter.getViews(tables[0].id))).toBe(true);
    } finally {
      await small.$disconnect();
    }
  });

  it('adds a column a live table lacks exactly once', async () => {
    const ws = await createWorkspace();
    for (const name of ['Occasion', 'Place', 'Host']) {
      await ws.adapter.deleteColumn(named(await ws.adapter.getColumns(ws.tableId), name)[0].id);
    }

    await Promise.all(Array.from({ length: 6 }, () => ensure(ws)));

    const columns = await ws.adapter.getColumns(ws.tableId);
    for (const name of ['Occasion', 'Place', 'Host']) expect(named(columns, name)).toHaveLength(1);
    expect(receiptsSchemaIsCurrent(columns, await ws.adapter.getViews(ws.tableId))).toBe(true);
  });
});

describe('a table whose shape changes while the app is running', () => {
  // Postgres refuses a prepared `SELECT *` once the table gained or lost a
  // column, and the adapter reports that as "row not found". The app's client
  // therefore keeps no prepared statements (src/lib/prisma-url.ts).
  const readOnManyConnections = (ws: TestWorkspace, rowId: string) =>
    Promise.all(Array.from({ length: 30 }, () => ws.adapter.getRow(rowId)));

  it('a row is still found, and a save still lands, after a column was added and one was dropped', async () => {
    const ws = await createWorkspace();
    const ctx: MealContext = { workspaceId: ws.workspaceId, tenantId: ws.tenantId };
    const rowId = await ws.addReceipt(plainMealReceipt());
    expect((await readOnManyConnections(ws, rowId)).every((row) => row !== null)).toBe(true);

    const extra = await ws.adapter.createColumn({ tableId: ws.tableId, name: 'Notiz', type: 'text' });
    expect((await readOnManyConnections(ws, rowId)).every((row) => row !== null)).toBe(true);

    await ws.adapter.deleteColumn(extra.id);
    expect((await readOnManyConnections(ws, rowId)).every((row) => row !== null)).toBe(true);

    await saveMealDetails(db, ctx, rowId, details({ occasion: 'Abnahme Fotoproduktion' }));
    expect((await loadMealRecord(db, ws.workspaceId, rowId))!.occasion).toBe('Abnahme Fotoproduktion');
  });
});
