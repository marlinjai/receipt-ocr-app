import type { Prisma, PrismaClient } from '@prisma/client';
import { counterpartyKey } from './service';

/**
 * Carry stored counterparty keys over to the merchant key (plan
 * docs/plans/2026-10-25-filed-year-decides-counterparties.md, decision 3).
 *
 * The key is stored with every payment and with everything said about a
 * counterparty (a person's treatment, a category, the app's verdict, a budget
 * for a shop). When the key's computation changes, each of them is worked out
 * again from its own name. Where several old keys become one, what they said is
 * merged: one answer, or the same answer from all of them, is carried; different
 * answers of a person are not carried at all, so the merchant is asked again
 * rather than answered by whichever came first. The app's verdicts are never
 * carried: their evidence changed with the key, so the next run decides again.
 *
 * Done for all companies of a tenant together, because one company's answers
 * apply to payments another company holds (an account shared across
 * companies): moving the payments of one and the answers of the other at
 * different times would leave an answer not applying in between. Run twice, the
 * second run changes nothing.
 */

export interface RekeyResult {
  payments: number;
  /** Answers moved to their new key. */
  carried: number;
  /** Answers of a person dropped because others of the same merchant said something else. */
  conflicting: number;
  /** Verdicts of the app removed, to be made again on the new key. */
  verdicts: number;
}

type Db = PrismaClient | Prisma.TransactionClient;

interface Keyed {
  id: string;
  authWorkspaceId: string;
  key: string;
  label: string;
  /** What the row says; rows of one merchant saying the same thing can be one. */
  says: string;
}

/** Per company and new key, the rows that end up there. Only groups where something changes are returned. */
function regroup(rows: readonly Keyed[]): Array<{ workspaceId: string; key: string; rows: Keyed[] }> {
  const groups = new Map<string, { workspaceId: string; key: string; rows: Keyed[] }>();
  for (const row of rows) {
    const key = counterpartyKey(row.label) || row.key;
    const id = `${row.authWorkspaceId}|${key}`;
    const group = groups.get(id) ?? { workspaceId: row.authWorkspaceId, key, rows: [] };
    group.rows.push(row);
    groups.set(id, group);
  }
  return [...groups.values()].filter((g) => g.rows.length > 1 || g.rows[0].key !== g.key);
}

/** One row per merchant: kept when all rows say the same, all removed when they disagree. */
async function merge(
  groups: ReturnType<typeof regroup>,
  move: (id: string, key: string) => Promise<unknown>,
  remove: (ids: string[]) => Promise<unknown>,
  result: RekeyResult,
): Promise<void> {
  for (const group of groups) {
    const keep = group.rows.find((r) => r.key === group.key) ?? group.rows[0];
    if (new Set(group.rows.map((r) => r.says)).size > 1) {
      await remove(group.rows.map((r) => r.id));
      result.conflicting += group.rows.length;
      continue;
    }
    const others = group.rows.filter((r) => r.id !== keep.id).map((r) => r.id);
    if (others.length > 0) await remove(others);
    if (keep.key !== group.key) await move(keep.id, group.key);
    result.carried += group.rows.length;
  }
}

export async function rekeyCounterparties(db: PrismaClient, tenantId: string | null, workspaceId: string): Promise<RekeyResult> {
  // A company without a tenant (older rows) only has its own rows to carry.
  const scope = tenantId ? { OR: [{ authTenantId: tenantId }, { authWorkspaceId: workspaceId }] } : { authWorkspaceId: workspaceId };
  return db.$transaction(async (tx: Db) => {
    const result: RekeyResult = { payments: 0, carried: 0, conflicting: 0, verdicts: 0 };
    const payments = await tx.taxPayment.findMany({ where: scope, select: { id: true, counterparty: true, counterpartyKey: true } });
    const moves = new Map<string, string[]>();
    for (const p of payments) {
      const key = counterpartyKey(p.counterparty);
      if (key !== p.counterpartyKey) moves.set(key, [...(moves.get(key) ?? []), p.id]);
    }
    for (const [key, ids] of moves) {
      await tx.taxPayment.updateMany({ where: { id: { in: ids } }, data: { counterpartyKey: key } });
      result.payments += ids.length;
    }

    const rules = await tx.taxCounterpartyRule.findMany({ where: scope });
    await merge(
      regroup(rules.map((r) => ({ id: r.id, authWorkspaceId: r.authWorkspaceId, key: r.counterpartyKey, label: r.label, says: r.treatment }))),
      (id, key) => tx.taxCounterpartyRule.update({ where: { id }, data: { counterpartyKey: key } }),
      (ids) => tx.taxCounterpartyRule.deleteMany({ where: { id: { in: ids } } }),
      result,
    );
    const categories = await tx.spendingCategoryAnswer.findMany({ where: scope });
    await merge(
      regroup(categories.map((r) => ({ id: r.id, authWorkspaceId: r.authWorkspaceId, key: r.counterpartyKey, label: r.label, says: r.category }))),
      (id, key) => tx.spendingCategoryAnswer.update({ where: { id }, data: { counterpartyKey: key } }),
      (ids) => tx.spendingCategoryAnswer.deleteMany({ where: { id: { in: ids } } }),
      result,
    );
    const budgets = await tx.spendingBudget.findMany({ where: { ...scope, scope: 'vendor' } });
    await merge(
      regroup(budgets.map((r) => ({ id: r.id, authWorkspaceId: r.authWorkspaceId, key: r.key, label: r.label, says: String(r.limitCents) }))),
      (id, key) => tx.spendingBudget.update({ where: { id }, data: { key } }),
      (ids) => tx.spendingBudget.deleteMany({ where: { id: { in: ids } } }),
      result,
    );

    const verdicts = await tx.taxCounterpartyVerdict.findMany({ where: scope, select: { id: true, counterpartyKey: true, label: true } });
    const stale = verdicts.filter((v) => (counterpartyKey(v.label) || v.counterpartyKey) !== v.counterpartyKey).map((v) => v.id);
    if (stale.length > 0) await tx.taxCounterpartyVerdict.deleteMany({ where: { id: { in: stale } } });
    result.verdicts = stale.length;

    if (result.payments + result.carried + result.conflicting + result.verdicts > 0) console.info('[payments] counterparty keys carried to their merchant', { tenantId, ...result });
    return result;
  }, { timeout: 60_000 });
}
