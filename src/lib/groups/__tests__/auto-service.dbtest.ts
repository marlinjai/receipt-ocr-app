import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isGroupRow } from '@/lib/receipts-kind';
import { deleteReceiptRows } from '@/lib/meals/service';
import { autoGroupRecurring } from '../auto-service';
import { createGroup, moveIntoGroup, removeFromGroup } from '../service';
import { setParentRow } from '../links';
import { createWorkspace, db, type TestWorkspace } from '../../../../test/db-helpers';

/**
 * Automatic groups against a real database: recurring receipts of one vendor
 * and item in one year become a group, once; a receipt a person took out of
 * the group stays out; what does not count for tax, meals and receipts in a
 * group are left alone. Run with `pnpm test:db`.
 */

let ws: TestWorkspace;
const deps = { deleteStoredFile: async () => {} };

const receipt = (vendor: string, item: string, date: string, over: Record<string, string | number> = {}) => ({
  Name: `${vendor}, ${item}`,
  Vendor: vendor,
  Item: item,
  Gross: 10,
  Date: date,
  Category: 'Software & Lizenzen',
  Zuordnung: 'Geschäftlich',
  Currency: 'EUR',
  'FX Rate': 1,
  ...over,
});

const all = async () => (await ws.adapter.getRows(ws.tableId, { limit: 1000 })).items;
const columns = async () => ws.adapter.getColumns(ws.tableId);
const parentOf = async (id: string) => (await all()).find((r) => r.id === id)?.parentRowId;
const groupsOf = async () => {
  const cols = await columns();
  return (await all()).filter((r) => isGroupRow(r, cols));
};
const nameOf = async (row: { cells: Record<string, unknown> }) => row.cells[(await columns()).find((c) => c.name === 'Name')!.id];

beforeAll(async () => {
  ws = await createWorkspace();
});
afterAll(async () => {
  await db.$disconnect();
});

describe('automatic groups of recurring receipts', () => {
  it('makes one group per vendor, item and year from two or more counted receipts', async () => {
    const tag = randomUUID().slice(0, 6);
    const a = await ws.addReceipt(receipt(`Cloud ${tag}`, 'Plan', '2024-01-05T00:00:00.000Z'));
    const b = await ws.addReceipt(receipt(`Cloud ${tag}`, 'Plan', '2024-02-05T00:00:00.000Z'));
    const otherYear = await ws.addReceipt(receipt(`Cloud ${tag}`, 'Plan', '2025-01-05T00:00:00.000Z'));
    const single = await ws.addReceipt(receipt(`Solo ${tag}`, 'Plan', '2024-01-05T00:00:00.000Z'));
    const privateOne = await ws.addReceipt(receipt(`Cloud ${tag}`, 'Plan', '2024-03-05T00:00:00.000Z', { Zuordnung: 'Privat' }));
    const meal = await ws.addReceipt(receipt(`Cloud ${tag}`, 'Plan', '2024-04-05T00:00:00.000Z', { Category: 'Bewirtung' }));

    const first = await autoGroupRecurring(db, ws.workspaceId);
    expect(first.created).toBeGreaterThanOrEqual(1);
    const groupId = await parentOf(a);
    expect(groupId).toBeTruthy();
    expect(await parentOf(b)).toBe(groupId);
    // Another year, a lone receipt, a private one (no second private one of its key) and a meal stay at the top level.
    for (const id of [otherYear, single, privateOne, meal]) expect(await parentOf(id)).toBeFalsy();
    const group = (await groupsOf()).find((g) => g.id === groupId)!;
    expect(await nameOf(group)).toBe(`Cloud ${tag}, Plan, 2024`);

    // A second run finds nothing left to do.
    const second = await autoGroupRecurring(db, ws.workspaceId);
    expect(second).toMatchObject({ created: 0, joined: 0, grouped: 0 });
    expect((await groupsOf()).filter((g) => g.id === groupId)).toHaveLength(1);
  });

  it('puts a receipt that arrives later into the group of its key', async () => {
    const tag = randomUUID().slice(0, 6);
    const a = await ws.addReceipt(receipt(`Late ${tag}`, 'Abo', '2024-01-05T00:00:00.000Z'));
    const b = await ws.addReceipt(receipt(`Late ${tag}`, 'Abo', '2024-02-05T00:00:00.000Z'));
    await autoGroupRecurring(db, ws.workspaceId);
    const groupId = await parentOf(a);
    expect(await parentOf(b)).toBe(groupId);

    const c = await ws.addReceipt(receipt(`Late ${tag}`, 'abo ', '2024-03-05T00:00:00.000Z'));
    const result = await autoGroupRecurring(db, ws.workspaceId);
    expect(result.joined).toBeGreaterThanOrEqual(1);
    expect(await parentOf(c)).toBe(groupId);
  });

  it('never groups a receipt again that a person took out of its group', async () => {
    const tag = randomUUID().slice(0, 6);
    const a = await ws.addReceipt(receipt(`Out ${tag}`, 'Abo', '2024-01-05T00:00:00.000Z'));
    const b = await ws.addReceipt(receipt(`Out ${tag}`, 'Abo', '2024-02-05T00:00:00.000Z'));
    const c = await ws.addReceipt(receipt(`Out ${tag}`, 'Abo', '2024-03-05T00:00:00.000Z'));
    await autoGroupRecurring(db, ws.workspaceId);
    const groupId = await parentOf(a);

    await removeFromGroup(db, ws.workspaceId, [b]);
    expect(await parentOf(b)).toBeFalsy();
    await autoGroupRecurring(db, ws.workspaceId);
    expect(await parentOf(b)).toBeFalsy();
    expect(await parentOf(a)).toBe(groupId);
    expect(await parentOf(c)).toBe(groupId);
  });

  it('does not make a group again that a person dissolved', async () => {
    const tag = randomUUID().slice(0, 6);
    const a = await ws.addReceipt(receipt(`Gone ${tag}`, 'Abo', '2024-01-05T00:00:00.000Z'));
    const b = await ws.addReceipt(receipt(`Gone ${tag}`, 'Abo', '2024-02-05T00:00:00.000Z'));
    await autoGroupRecurring(db, ws.workspaceId);
    const groupId = (await parentOf(a))!;
    await deleteReceiptRows(db, { workspaceId: ws.workspaceId, tenantId: ws.tenantId }, [groupId], deps);

    await autoGroupRecurring(db, ws.workspaceId);
    expect(await parentOf(a)).toBeFalsy();
    expect(await parentOf(b)).toBeFalsy();
    expect((await groupsOf()).some((g) => g.id === groupId)).toBe(false);
  });

  it('can be limited to the keys of the receipts that just arrived', async () => {
    const tag = randomUUID().slice(0, 6);
    const x1 = await ws.addReceipt(receipt(`OnlyA ${tag}`, 'Abo', '2024-01-05T00:00:00.000Z'));
    const x2 = await ws.addReceipt(receipt(`OnlyA ${tag}`, 'Abo', '2024-02-05T00:00:00.000Z'));
    const y1 = await ws.addReceipt(receipt(`OnlyB ${tag}`, 'Abo', '2024-01-05T00:00:00.000Z'));
    const y2 = await ws.addReceipt(receipt(`OnlyB ${tag}`, 'Abo', '2024-02-05T00:00:00.000Z'));
    await autoGroupRecurring(db, ws.workspaceId, { rowIds: [x2] });
    expect(await parentOf(x1)).toBeTruthy();
    expect(await parentOf(y1)).toBeFalsy();
    expect(await parentOf(y2)).toBeFalsy();
  });

  it('makes one group when two runs start at once', async () => {
    const tag = randomUUID().slice(0, 6);
    const a = await ws.addReceipt(receipt(`Twice ${tag}`, 'Abo', '2024-01-05T00:00:00.000Z'));
    const b = await ws.addReceipt(receipt(`Twice ${tag}`, 'Abo', '2024-02-05T00:00:00.000Z'));
    await Promise.all([autoGroupRecurring(db, ws.workspaceId), autoGroupRecurring(db, ws.workspaceId)]);
    const named = (await groupsOf()).filter(async () => true);
    const cols = await columns();
    const nameCol = cols.find((c) => c.name === 'Name')!.id;
    const same = named.filter((g) => g.cells[nameCol] === `Twice ${tag}, Abo, 2024`);
    expect(same).toHaveLength(1);
    expect(await parentOf(a)).toBe(same[0].id);
    expect(await parentOf(b)).toBe(same[0].id);
  });

  it('removes every group left without a receipt, and puts an archived receipt that pointed at one at the top level', async () => {
    const tag = randomUUID().slice(0, 6);
    const kept = await ws.addReceipt(receipt(`Keep ${tag}`, 'Abo', '2024-01-05T00:00:00.000Z'));
    const left = await ws.addReceipt(receipt(`Left ${tag}`, 'Abo', '2024-01-05T00:00:00.000Z'));
    const archived = await ws.addReceipt(receipt(`Arch ${tag}`, 'Abo', '2024-01-05T00:00:00.000Z'));
    const holding = await createGroup(db, ws.workspaceId, `Mine ${tag}`, [kept]);
    // What a path outside the group service leaves behind: a group whose receipt was moved out directly,
    // and one whose only receipt is archived.
    const stray = await createGroup(db, ws.workspaceId, `Stray ${tag}`, [left]);
    await setParentRow(db, ws.tableId, [left], null);
    const shelf = await createGroup(db, ws.workspaceId, `Shelf ${tag}`, [archived]);
    await ws.adapter.archiveRow(archived);

    const result = await autoGroupRecurring(db, ws.workspaceId);
    expect(result.removedEmpty).toBeGreaterThanOrEqual(2);
    const groups = (await groupsOf()).map((g) => g.id);
    expect(groups).toContain(holding);
    expect(groups).not.toContain(stray);
    expect(groups).not.toContain(shelf);
    const archivedRow = (await ws.adapter.getRows(ws.tableId, { limit: 1000, includeArchived: true } as never)).items.find((r) => r.id === archived);
    expect(archivedRow?.parentRowId ?? null).toBeNull();
  });

  it('a group goes by itself when its last receipt is taken out, moved or deleted', async () => {
    const tag = randomUUID().slice(0, 6);
    const [a, b, c, d] = await Promise.all(
      ['01', '02', '03', '04'].map((m) => ws.addReceipt(receipt(`Self ${tag}`, `Item ${m}`, `2024-${m}-05T00:00:00.000Z`))),
    );
    const out = await createGroup(db, ws.workspaceId, `Out ${tag}`, [a]);
    const moved = await createGroup(db, ws.workspaceId, `Moved ${tag}`, [b]);
    const target = await createGroup(db, ws.workspaceId, `Target ${tag}`, [c]);
    const gone = await createGroup(db, ws.workspaceId, `Gone ${tag}`, [d]);

    await removeFromGroup(db, ws.workspaceId, [a]);
    await moveIntoGroup(db, ws.workspaceId, target, [b]);
    await deleteReceiptRows(db, { workspaceId: ws.workspaceId, tenantId: ws.tenantId }, [d], deps);

    const groups = (await groupsOf()).map((g) => g.id);
    expect(groups).not.toContain(out);
    expect(groups).not.toContain(moved);
    expect(groups).not.toContain(gone);
    expect(groups).toContain(target);
    expect(await parentOf(b)).toBe(target);
  });

  it('groups private receipts in a group of their own, never with the business ones', async () => {
    const tag = randomUUID().slice(0, 6);
    const work = [
      await ws.addReceipt(receipt(`Both ${tag}`, 'Abo', '2025-01-05T00:00:00.000Z')),
      await ws.addReceipt(receipt(`Both ${tag}`, 'Abo', '2025-02-05T00:00:00.000Z')),
    ];
    const home = [
      await ws.addReceipt(receipt(`Both ${tag}`, 'Abo', '2025-03-05T00:00:00.000Z', { Zuordnung: 'Privat' })),
      await ws.addReceipt(receipt(`Both ${tag}`, 'Abo', '2025-04-05T00:00:00.000Z', { Zuordnung: 'Privat' })),
    ];
    await autoGroupRecurring(db, ws.workspaceId);
    const workGroup = await parentOf(work[0]);
    const homeGroup = await parentOf(home[0]);
    expect(workGroup).toBeTruthy();
    expect(homeGroup).toBeTruthy();
    expect(workGroup).not.toBe(homeGroup);
    expect(await parentOf(work[1])).toBe(workGroup);
    expect(await parentOf(home[1])).toBe(homeGroup);
    const names = await Promise.all((await groupsOf()).filter((g) => g.id === workGroup || g.id === homeGroup).map(nameOf));
    expect(names.sort()).toEqual([`Both ${tag}, Abo, 2025`, `Both ${tag}, Abo, 2025, Privat`]);
  });

  it('a receipt joins the group its key lies in although the group carries an older vendor in its name', async () => {
    const tag = randomUUID().slice(0, 6);
    const a = await ws.addReceipt(receipt(`Apple ${tag}`, 'iCloud+ 2 TB', '2026-01-08T00:00:00.000Z'));
    const b = await ws.addReceipt(receipt(`Apple ${tag}`, 'iCloud+ 2 TB', '2026-02-08T00:00:00.000Z'));
    const groupId = await createGroup(db, ws.workspaceId, `Apple Distribution International Ltd. ${tag}, iCloud+ 2 TB, 2026`, [a, b]);
    const august = await ws.addReceipt(receipt(`Apple ${tag}`, 'iCloud+ 2 TB', '2026-08-08T00:00:00.000Z'));

    await autoGroupRecurring(db, ws.workspaceId);
    expect(await parentOf(august)).toBe(groupId);
  });

  it('moves the receipts of a second group of one key into the larger one, and the emptied group goes', async () => {
    const tag = randomUUID().slice(0, 6);
    const big = [
      await ws.addReceipt(receipt(`Twin ${tag}`, 'Plan', '2025-01-05T00:00:00.000Z')),
      await ws.addReceipt(receipt(`Twin ${tag}`, 'Plan', '2025-02-05T00:00:00.000Z')),
    ];
    const small = await ws.addReceipt(receipt(`Twin ${tag}`, 'Plan', '2025-03-05T00:00:00.000Z'));
    const large = await createGroup(db, ws.workspaceId, `Twin ${tag}, Plan, 2025`, big);
    const second = await createGroup(db, ws.workspaceId, `Twin ${tag}, Plan mit Abo, 2025`, [small]);

    await autoGroupRecurring(db, ws.workspaceId);
    expect(await parentOf(small)).toBe(large);
    expect((await groupsOf()).map((g) => g.id)).not.toContain(second);
    // A second run changes nothing.
    await autoGroupRecurring(db, ws.workspaceId);
    expect(await parentOf(small)).toBe(large);
  });
});
