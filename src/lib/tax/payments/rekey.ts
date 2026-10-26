import type { Prisma, PrismaClient } from '@prisma/client';
import { merchantName } from './merchant';
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
 * rather than answered by whichever came first. The app's verdicts on a changed
 * key, and on every key that took over payments, are removed: their evidence
 * changed with the move, so the next run decides again.
 *
 * It runs once per version of the key, for all companies together (a company's
 * answers apply to payments another company holds, also across tenants), and
 * before anything reads or writes a key: `ensureMerchantKeys` is called by the
 * payments' load, every import and every answer that stores a key. A stored
 * marker says it is done, so after that a call costs one lookup, and nothing
 * once this process has seen the marker.
 */

/** Raised whenever `counterpartyKey` changes how it makes a key: the stored keys are carried again. */
export const MERCHANT_KEY_VERSION = 1;
const MARKER = 'counterparty_key';
/** One run at a time, also across server instances (an arbitrary constant for `pg_advisory_xact_lock`). */
const LOCK = 742_031_001;

export interface RekeyResult {
  payments: number;
  /** Answers moved to their new key, or merged into one there. */
  carried: number;
  /** Answers of a person dropped because others of the same merchant said something else. */
  conflicting: number;
  /** Verdicts of the app removed, to be made again on the new key. */
  verdicts: number;
}

type Tx = Prisma.TransactionClient;

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

/**
 * One row per merchant: kept when all rows say the same, all removed when they
 * disagree. Removals go first and every move goes through a key of its own, so
 * no move lands on a key another row still holds (the tables allow one row per
 * company and key).
 */
async function merge(
  groups: ReturnType<typeof regroup>,
  move: (id: string, key: string, label: string) => Promise<unknown>,
  remove: (ids: string[]) => Promise<unknown>,
  result: RekeyResult,
): Promise<void> {
  const moves: Array<{ id: string; key: string; label: string }> = [];
  for (const group of groups) {
    if (new Set(group.rows.map((r) => r.says)).size > 1) {
      await remove(group.rows.map((r) => r.id));
      result.conflicting += group.rows.length;
      continue;
    }
    const keep = group.rows.find((r) => r.key === group.key) ?? group.rows[0];
    const others = group.rows.filter((r) => r.id !== keep.id).map((r) => r.id);
    if (others.length > 0) await remove(others);
    if (keep.key !== group.key) moves.push({ id: keep.id, key: group.key, label: merchantName(keep.label) });
    result.carried += group.rows.length;
  }
  for (const m of moves) await move(m.id, `rekey:${m.id}`, m.label);
  for (const m of moves) await move(m.id, m.key, m.label);
}

/** The carrying itself, inside the caller's transaction. Exported for tests; use `ensureMerchantKeys`. */
export async function rekeyCounterparties(tx: Tx): Promise<RekeyResult> {
  const result: RekeyResult = { payments: 0, carried: 0, conflicting: 0, verdicts: 0 };
  const byId = { orderBy: { id: 'asc' as const } };
  const payments = await tx.taxPayment.findMany({ select: { id: true, authWorkspaceId: true, counterparty: true, counterpartyKey: true }, ...byId });
  const moves = new Map<string, string[]>();
  // The keys that take over payments, per company: a verdict there was made on fewer payments.
  const receiving = new Set<string>();
  for (const p of payments) {
    const key = counterpartyKey(p.counterparty);
    if (key === p.counterpartyKey) continue;
    moves.set(key, [...(moves.get(key) ?? []), p.id]);
    receiving.add(`${p.authWorkspaceId}|${key}`);
  }
  for (const [key, ids] of moves) {
    await tx.taxPayment.updateMany({ where: { id: { in: ids } }, data: { counterpartyKey: key } });
    result.payments += ids.length;
  }

  const rules = await tx.taxCounterpartyRule.findMany(byId);
  await merge(
    regroup(rules.map((r) => ({ id: r.id, authWorkspaceId: r.authWorkspaceId, key: r.counterpartyKey, label: r.label, says: r.treatment }))),
    (id, key, label) => tx.taxCounterpartyRule.update({ where: { id }, data: { counterpartyKey: key, label } }),
    (ids) => tx.taxCounterpartyRule.deleteMany({ where: { id: { in: ids } } }),
    result,
  );
  const categories = await tx.spendingCategoryAnswer.findMany(byId);
  await merge(
    regroup(categories.map((r) => ({ id: r.id, authWorkspaceId: r.authWorkspaceId, key: r.counterpartyKey, label: r.label, says: r.category }))),
    (id, key, label) => tx.spendingCategoryAnswer.update({ where: { id }, data: { counterpartyKey: key, label } }),
    (ids) => tx.spendingCategoryAnswer.deleteMany({ where: { id: { in: ids } } }),
    result,
  );
  const budgets = await tx.spendingBudget.findMany({ where: { scope: 'vendor' }, ...byId });
  await merge(
    regroup(budgets.map((r) => ({ id: r.id, authWorkspaceId: r.authWorkspaceId, key: r.key, label: r.label, says: String(r.limitCents) }))),
    (id, key, label) => tx.spendingBudget.update({ where: { id }, data: { key, label } }),
    (ids) => tx.spendingBudget.deleteMany({ where: { id: { in: ids } } }),
    result,
  );

  const verdicts = await tx.taxCounterpartyVerdict.findMany({ select: { id: true, authWorkspaceId: true, counterpartyKey: true, label: true }, ...byId });
  const stale = verdicts
    .filter((v) => (counterpartyKey(v.label) || v.counterpartyKey) !== v.counterpartyKey || receiving.has(`${v.authWorkspaceId}|${v.counterpartyKey}`))
    .map((v) => v.id);
  if (stale.length > 0) await tx.taxCounterpartyVerdict.deleteMany({ where: { id: { in: stale } } });
  result.verdicts = stale.length;
  return result;
}

let doneVersion = 0;

/**
 * Make sure the stored keys are the current ones, before a key is read or
 * written. Once per key version: the first caller carries them (under a lock,
 * so a second caller waits and then finds the marker), every later caller only
 * sees the marker. A failure is thrown: reading payments under keys that answers
 * no longer match would show wrong figures without saying so.
 */
export async function ensureMerchantKeys(db: PrismaClient | Tx): Promise<RekeyResult | null> {
  if (doneVersion >= MERCHANT_KEY_VERSION) return null;
  const marker = await db.taxKeyVersion.findUnique({ where: { name: MARKER } });
  if (marker && marker.version >= MERCHANT_KEY_VERSION) {
    doneVersion = marker.version;
    return null;
  }
  // Inside a caller's transaction the carrying joins it; otherwise it gets one of its own.
  const run = async (tx: Tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${LOCK})`;
    const again = await tx.taxKeyVersion.findUnique({ where: { name: MARKER } });
    if (again && again.version >= MERCHANT_KEY_VERSION) return null;
    const result = await rekeyCounterparties(tx);
    await tx.taxKeyVersion.upsert({ where: { name: MARKER }, create: { name: MARKER, version: MERCHANT_KEY_VERSION }, update: { version: MERCHANT_KEY_VERSION } });
    console.info('[payments] counterparty keys carried to their merchant', { version: MERCHANT_KEY_VERSION, ...result });
    return result;
  };
  const result = '$transaction' in db ? await (db as PrismaClient).$transaction(run, { maxWait: 30_000, timeout: 120_000 }) : await run(db as Tx);
  doneVersion = MERCHANT_KEY_VERSION;
  return result;
}

/** For tests: forget that this process has seen the marker. */
export function forgetMerchantKeys(): void {
  doneVersion = 0;
}
