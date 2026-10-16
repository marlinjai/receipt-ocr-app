/**
 * One-time data move for the roadmap line "The assignment cell and the finance
 * decision are two sources for who bears a receipt".
 *
 * Writes the "Zuordnung" and "Business Share %" cells of every receipt from the
 * one source of who bears it (see src/lib/tax/assignment.ts):
 *  - a receipt with a finance decision or a vendor rule in force gets the cells
 *    of that treatment (until now a decision in the finance area left them as
 *    they were, so the table and the finance area could disagree);
 *  - a private receipt without either gets the share 0 (it read 100 in some
 *    rows and 0 in others; the share of a private receipt plays no role); the
 *    share it held is kept (`tax_assignment_origins`, reason "private_share")
 *    and comes back if the receipt stops being private.
 * Meals are not touched: there the cell is the meal register's own input.
 *
 * ADDITIVE in the sense the plan asks for: no column, table or decision is
 * removed or changed, the two older columns stay and only some of their cells
 * are rewritten, and what a decided row's cells held before is kept in the new
 * table `tax_assignment_origins` (so removing a decision restores it). Every figure of the finance area is the same before and after;
 * `scripts/assignment-cells.copycheck.ts` proves that on a copy of production
 * (`pnpm check:copy`). Idempotent: a second run plans nothing.
 *
 * Usage (DATABASE_URL names the database):
 *   npx tsx scripts/sync-assignment-cells.ts            # dry run: counts per workspace, nothing written
 *   npx tsx scripts/sync-assignment-cells.ts --apply    # write
 *
 * Output carries workspace ids and counts only, never a receipt or a name.
 */
import { PrismaClient } from '@prisma/client';
import { RECEIPTS_TABLE_NAME } from '@/lib/receipts-table';
import { plannedAssignmentCells, writeAssignmentCells, type PlannedCells } from '@/lib/tax/assignment-sync';

export interface SyncReport {
  workspaceId: string;
  /** Rows whose cells are written from their own decision. */
  fromDecision: number;
  /** Rows whose cells are written from their vendor rule. */
  fromVendorRule: number;
  /** Private rows without either whose share becomes 0. */
  privateShare: number;
  /** Rows neither decides any more whose cells get their kept values back. */
  restored: number;
  /** Rows whose current cells are kept before a decision or rule takes them over. */
  originsKept: number;
  /** Rows whose cells were written (0 on a dry run). */
  written: number;
  /** Rows that could not be brought in step (each logged with its reason); run again after fixing it. */
  failed: number;
}

/** True when the report plans nothing at all: the state a second run must find. */
export const settled = (r: SyncReport) => r.fromDecision + r.fromVendorRule + r.privateShare + r.restored + r.originsKept + r.failed === 0;

export async function syncAllWorkspaces(db: PrismaClient, apply: boolean): Promise<SyncReport[]> {
  const tables = await db.dtTable.findMany({ where: { name: RECEIPTS_TABLE_NAME }, select: { workspaceId: true, authTenantId: true }, orderBy: { workspaceId: 'asc' } });
  const reports: SyncReport[] = [];
  for (const { workspaceId, authTenantId } of tables) {
    const plans: PlannedCells[] = await plannedAssignmentCells(db, workspaceId);
    const count = (origin: PlannedCells['origin']) => plans.filter((p) => p.origin === origin && p.to !== null).length;
    reports.push({
      workspaceId,
      fromDecision: count('item'),
      fromVendorRule: count('vendor_rule'),
      privateShare: count('legacy_columns'),
      restored: count('restore'),
      originsKept: plans.filter((p) => p.kept !== null && p.kept.op !== 'drop').length,
      ...(apply ? await writeAssignmentCells(db, { workspaceId, tenantId: authTenantId }, plans).then((r) => ({ written: r.written, failed: r.failed.length })) : { written: 0, failed: 0 }),
    });
  }
  return reports;
}

async function main() {
  const apply = process.argv.includes('--apply');
  const db = new PrismaClient();
  try {
    const reports = await syncAllWorkspaces(db, apply);
    const failed = reports.reduce((n, r) => n + r.failed, 0);
    for (const r of reports.filter((x) => !settled(x))) {
      console.log(
        `${r.workspaceId}: from decision ${r.fromDecision}, from vendor rule ${r.fromVendorRule}, private share ${r.privateShare}, restored ${r.restored}, kept before ${r.originsKept}, written ${r.written}, failed ${r.failed}`,
      );
    }
    if (!apply) console.log('Dry run: nothing written. Run with --apply to write.');
    if (failed > 0) {
      console.error(`${failed} receipt(s) could not be brought in step (see the log above); fix and run again.`);
      process.exitCode = 1;
    }
  } finally {
    await db.$disconnect();
  }
}

if (process.argv[1]?.endsWith('sync-assignment-cells.ts')) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
