import 'server-only';
import { ensureRealTable } from '@marlinjai/data-table-adapter-prisma';
import { safeColumnName, safeTableName } from '@marlinjai/data-table-adapter-shared';
import type { PrismaClient } from '@prisma/client';
import { ITEM_COLUMN } from '@/lib/receipt-name';
import { tableContext } from '@/lib/meals/service';
import { AUTO_GROUP_OFF_COLUMN, GROUP_KIND, rowKindColumnId } from '@/lib/receipts-kind';
import { planAutoGroups, type ExistingGroup, type GroupableReceipt } from './auto';
import { removeEmptyGroups } from './empty';
import { GroupError } from './rules';
import { GROUP_MEMBERS_MAX, createGroup, moveIntoGroup, renameGroup } from './service';

/**
 * Apply the rule of `auto.ts` to a workspace's receipts: create the groups of
 * recurring receipts and put receipts into the group of their key.
 *
 * Reads only the columns the rule needs, straight from the table's own
 * storage: the whole table is looked at, and the recognized text of every
 * receipt must not travel with it. A failure on one group does not stop the
 * others, and a second run finds nothing left to do.
 */

export interface AutoGroupResult {
  created: number;
  joined: number;
  /** Receipts that were put into a group, whether by a new or an existing one. */
  grouped: number;
  /** Groups that could not be written, by the code of the error. */
  failed: string[];
  /** Groups removed because no receipt was left in them. */
  removedEmpty?: number;
}

export interface AutoGroupOptions {
  /** Only the keys of these receipts (a receipt that just arrived). */
  rowIds?: readonly string[];
  /** Only receipts of these years. */
  years?: readonly number[];
}

interface Raw {
  id: string;
  parent_row_id: string | null;
  kind: string | null;
  name: string | null;
  vendor: string | null;
  item: string | null;
  day: string | null;
  assignment: string | null;
  category: string | null;
  locked: string | null;
}

/**
 * One run per workspace at a time in this process: a second request that arrives while one runs waits for
 * it and takes its result, so two page loads cannot both create the group of one key.
 */
const running = new Map<string, Promise<AutoGroupResult>>();

export function autoGroupRecurring(db: PrismaClient, workspaceId: string, options: AutoGroupOptions = {}): Promise<AutoGroupResult> {
  const existing = running.get(workspaceId);
  // A run that is limited to some receipts is not the whole run: it waits its turn and goes after.
  if (existing && !options.rowIds && !options.years) return existing;
  const next = (existing ?? Promise.resolve()).catch(() => undefined).then(() => applyAutoGroups(db, workspaceId, options));
  running.set(workspaceId, next);
  void next.finally(() => {
    if (running.get(workspaceId) === next) running.delete(workspaceId);
  });
  return next;
}

async function applyAutoGroups(db: PrismaClient, workspaceId: string, options: AutoGroupOptions): Promise<AutoGroupResult> {
  const result: AutoGroupResult = { created: 0, joined: 0, grouped: 0, failed: [] };
  const ctx = await tableContext(db, workspaceId);
  if (!ctx) return result;
  const col = (name: string) => ctx.columns.find((c) => c.name === name)?.id;
  const kindId = rowKindColumnId(ctx.columns);
  const lockId = col(AUTO_GROUP_OFF_COLUMN);
  const [nameId, vendorId, itemId, dateId, assignmentId, categoryId] = ['Name', 'Vendor', ITEM_COLUMN, 'Date', 'Zuordnung', 'Category'].map(col);
  // Until the next dashboard load brings the columns there is nothing to group by.
  if (!kindId || !nameId || !vendorId || !itemId || !dateId) return result;
  await ensureRealTable(db, ctx.tableId);

  const optionName = (columnId: string | undefined, optionId: string | null): string | null => {
    if (!columnId || !optionId) return null;
    return ctx.selectOptions.get(columnId)?.find((o) => o.id === optionId)?.name ?? null;
  };
  const select = (id: string | undefined, alias: string) => (id ? `${safeColumnName(id)} AS ${alias}` : `NULL::text AS ${alias}`);
  const rows = await db.$queryRawUnsafe<Raw[]>(
    `SELECT id, parent_row_id, ${select(kindId, 'kind')}, ${select(nameId, 'name')}, ${select(vendorId, 'vendor')}, ${select(itemId, 'item')},
            ${select(dateId, 'day')}, ${select(assignmentId, 'assignment')}, ${select(categoryId, 'category')}, ${select(lockId, 'locked')}
     FROM ${safeTableName(ctx.tableId)} WHERE _archived = 0`,
  );

  const receipts: GroupableReceipt[] = [];
  const groups: ExistingGroup[] = [];
  const years = options.years ? new Set(options.years) : null;
  for (const r of rows) {
    if (r.kind === GROUP_KIND) {
      if (r.name) groups.push({ id: r.id, name: r.name });
      continue;
    }
    // A receipt a person took out of a group stays out. One they put into a group later still counts there.
    if (r.locked && !r.parent_row_id) continue;
    const match = r.day ? /^(\d{4})-/.exec(r.day) : null;
    const year = match ? Number(match[1]) : null;
    if (years && (year === null || !years.has(year))) continue;
    receipts.push({
      id: r.id,
      vendor: r.vendor,
      item: r.item,
      year,
      assignment: optionName(assignmentId, r.assignment),
      category: optionName(categoryId, r.category),
      parentRowId: r.parent_row_id,
    });
  }

  const plan = planAutoGroups(receipts, groups, options.rowIds ? new Set(options.rowIds) : undefined);
  const attempt = async (write: () => Promise<number>, onOk: (moved: number) => void) => {
    try {
      onOk(await write());
    } catch (e) {
      // Codes only: no vendor or amount reaches the log.
      result.failed.push(e instanceof GroupError ? e.code : 'failed');
    }
  };
  const chunks = <T,>(list: readonly T[]): T[][] => {
    const out: T[][] = [];
    for (let i = 0; i < list.length; i += GROUP_MEMBERS_MAX) out.push(list.slice(i, i + GROUP_MEMBERS_MAX));
    return out;
  };
  for (const g of plan.join) {
    for (const part of chunks(g.memberIds)) {
      await attempt(
        () => moveIntoGroup(db, workspaceId, g.groupId, part),
        (moved) => {
          result.joined += moved > 0 ? 1 : 0;
          result.grouped += moved;
        },
      );
    }
  }
  for (const g of plan.create) {
    const [first, ...rest] = chunks(g.memberIds);
    let groupId: string | null = null;
    await attempt(
      async () => {
        groupId = await createGroup(db, workspaceId, g.name, first);
        return first.length;
      },
      (moved) => {
        result.created += 1;
        result.grouped += moved;
      },
    );
    // A key with more than the limit of receipts: the rest join the group that was just made.
    for (const part of rest) {
      if (!groupId) break;
      const target: string = groupId;
      await attempt(
        () => moveIntoGroup(db, workspaceId, target, part),
        (moved) => {
          result.grouped += moved;
        },
      );
    }
  }
  for (const g of plan.rename) {
    await attempt(
      async () => {
        await renameGroup(db, workspaceId, g.groupId, g.name);
        return 0;
      },
      () => {},
    );
  }
  // Every move above removed the groups it emptied; this catches what other paths left behind.
  result.removedEmpty = (await removeEmptyGroups(db, workspaceId)).length;
  return result;
}
