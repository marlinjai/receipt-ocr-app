import 'server-only';
import type { PrismaAdapter } from '@marlinjai/data-table-adapter-prisma';
import type { CellValue, Column } from '@marlinjai/data-table-core';
import type { PrismaClient } from '@prisma/client';
import { tableContext } from '@/lib/meals/service';
import { GROUP_KIND, rowKindColumnId } from '@/lib/receipts-kind';
import { readRowLinks, setParentRow } from './links';
import { GroupError, assertCanJoinGroup, cleanGroupName, sharedValue } from './rules';

/**
 * Groups in the receipts table: create one, put receipts in, take them out.
 *
 * Every function takes the workspace explicitly, resolved by the caller from
 * the verified session. A row is only ever addressed through the workspace's
 * own Receipts table, so an id from another workspace behaves like one that
 * does not exist. Deleting a group is not here: it goes through the app's one
 * delete path (`deleteReceiptRows`), which releases the receipts first.
 */

/** At most this many receipts are moved in one call. */
export const GROUP_MEMBERS_MAX = 500;

/** The columns a new group takes over from its receipts when they all agree. */
const INHERITED_COLUMNS = ['Category', 'Konto', 'Vendor'] as const;

interface GroupTable {
  adapter: PrismaAdapter;
  tableId: string;
  columns: Column[];
  kindColumnId: string;
}

async function groupTable(db: PrismaClient, workspaceId: string): Promise<GroupTable> {
  const ctx = await tableContext(db, workspaceId);
  if (!ctx) throw new GroupError('not_initialized');
  const kindColumnId = rowKindColumnId(ctx.columns);
  // The column arrives with the next dashboard load; until then there are no groups.
  if (!kindColumnId) throw new GroupError('not_initialized');
  return { adapter: ctx.adapter, tableId: ctx.tableId, columns: ctx.columns, kindColumnId };
}

function cleanIds(rowIds: unknown): string[] {
  if (!Array.isArray(rowIds)) throw new GroupError('row_not_found');
  const ids = [...new Set(rowIds.filter((id): id is string => typeof id === 'string' && id.length > 0))];
  if (ids.length !== new Set(rowIds).size || ids.length > GROUP_MEMBERS_MAX) throw new GroupError('row_not_found');
  return ids;
}

/** The members, checked: all rows of this table, none of them a group. */
async function checkedMembers(db: PrismaClient, table: GroupTable, rowIds: readonly string[]): Promise<void> {
  const found = await readRowLinks(db, table.tableId, table.kindColumnId, rowIds);
  assertCanJoinGroup(rowIds, found);
}

/**
 * Create a group, optionally with receipts in it. Returns the id of the group.
 *
 * The group carries its name and its kind, and the category, account and vendor
 * its receipts all share, so it starts in the section its receipts were in. It
 * never carries an amount.
 */
export async function createGroup(db: PrismaClient, workspaceId: string, name: unknown, memberRowIds: unknown = []): Promise<string> {
  const cleanName = cleanGroupName(name);
  const ids = cleanIds(memberRowIds);
  const table = await groupTable(db, workspaceId);
  await checkedMembers(db, table, ids);

  const columnId = (columnName: string) => table.columns.find((c) => c.name === columnName)?.id;
  const nameColumnId = columnId('Name');
  if (!nameColumnId) throw new GroupError('not_initialized');
  const cells: Record<string, CellValue> = { [nameColumnId]: cleanName, [table.kindColumnId]: GROUP_KIND };

  if (ids.length > 0) {
    const members = await Promise.all(ids.map((id) => table.adapter.getRow(id)));
    for (const columnName of INHERITED_COLUMNS) {
      const id = columnId(columnName);
      if (!id) continue;
      const shared = sharedValue(members.map((m) => m?.cells[id]));
      if (shared !== null) cells[id] = shared;
    }
  }

  const group = await table.adapter.createRow({ tableId: table.tableId, cells });
  try {
    await db.$transaction(async (tx) => {
      // Checked again in the transaction that writes: a receipt deleted since the first look is not moved.
      assertCanJoinGroup(ids, await readRowLinks(tx, table.tableId, table.kindColumnId, ids));
      await setParentRow(tx, table.tableId, ids, group.id);
    });
  } catch (e) {
    // The receipts did not move: no empty group is left behind for a failed request.
    await table.adapter.deleteRow(group.id);
    throw e;
  }
  return group.id;
}

/**
 * Put receipts into a group. A receipt that lies in another group leaves it;
 * one that is already in this group is not written. Returns how many moved.
 */
export async function moveIntoGroup(db: PrismaClient, workspaceId: string, groupId: unknown, rowIds: unknown): Promise<number> {
  if (typeof groupId !== 'string' || !groupId) throw new GroupError('group_not_found');
  const ids = cleanIds(rowIds);
  const table = await groupTable(db, workspaceId);
  return db.$transaction(async (tx) => {
    // The group and the receipts are read in the transaction that writes, so a
    // group deleted in between cannot be given rows.
    const found = await readRowLinks(tx, table.tableId, table.kindColumnId, [groupId, ...ids]);
    const group = found.get(groupId);
    if (!group || group.kind !== GROUP_KIND || group.archived) throw new GroupError('group_not_found');
    assertCanJoinGroup(ids, found, groupId);
    return setParentRow(tx, table.tableId, ids, groupId);
  });
}

/** Take receipts out of whatever group they lie in. Returns how many moved. */
export async function removeFromGroup(db: PrismaClient, workspaceId: string, rowIds: unknown): Promise<number> {
  const ids = cleanIds(rowIds);
  const table = await groupTable(db, workspaceId);
  return db.$transaction(async (tx) => {
    const found = await readRowLinks(tx, table.tableId, table.kindColumnId, ids);
    for (const id of ids) if (!found.has(id)) throw new GroupError('row_not_found');
    return setParentRow(tx, table.tableId, ids, null);
  });
}

/** The kind of one row of a table, null on a receipt. Throws when the row is not in the table. */
export async function rowKind(db: PrismaClient, tableId: string, columns: readonly Pick<Column, 'id' | 'name'>[], rowId: string): Promise<string | null> {
  const kindColumnId = rowKindColumnId(columns);
  if (!kindColumnId) return null;
  const row = (await readRowLinks(db, tableId, kindColumnId, [rowId])).get(rowId);
  if (!row) throw new GroupError('row_not_found');
  return row.kind;
}
