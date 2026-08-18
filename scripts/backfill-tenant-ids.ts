/**
 * Phase 0 backfill: stamp the owning company (auth-brain tenant) onto every
 * receipts row written before `auth_tenant_id` existed.
 *
 * Migration 0007 adds the column nullable, because a NOT NULL column cannot be
 * added to a live table with rows in it. This script is what makes the column
 * meaningful afterwards. Until it has run, existing rows are attributable to a
 * workspace but not to a company, which is the gap phase 0 exists to close.
 *
 * WHY EXPLICIT PAIRS RATHER THAN AN AUTH-BRAIN LOOKUP
 *
 * The integration plan described resolving each workspace to its tenant through
 * the auth-brain machine API. This takes the sibling script's approach instead
 * (`migrate-workspace-to-tenant-workspace.ts`, same repo, same class of one-shot
 * data move): the operator passes the pairs explicitly. Three reasons, and the
 * result is the same rows either way.
 *
 *   1. It needs no credentials. A backfill that requires a machine token is a
 *      backfill that cannot run from wherever the database happens to be
 *      reachable, and it drags a second failure mode (token expiry, network) into
 *      a job whose only real risk should be writing the wrong id.
 *   2. It is auditable. The operator sees the exact company each workspace is
 *      about to be filed under, before anything is written, rather than trusting
 *      a lookup they cannot inspect.
 *   3. The pairs are trivially obtainable: run with `--list` to print every
 *      distinct workspace id in the database with its row counts, then read the
 *      matching company id off the auth-brain admin UI or any verified session
 *      (every membership carries `tenantId`).
 *
 * IDEMPOTENT by construction: it only ever touches rows whose `auth_tenant_id`
 * IS NULL, so a second run reports zero and changes nothing. It never overwrites
 * an existing company id, because a row that already names an owner is not this
 * script's business, and silently re-attributing one would be the single worst
 * thing a backfill could do.
 *
 * Usage:
 *   npx tsx scripts/backfill-tenant-ids.ts --list
 *   npx tsx scripts/backfill-tenant-ids.ts --map <workspaceId>=<tenantId> [--map ...]
 *   npx tsx scripts/backfill-tenant-ids.ts --map <workspaceId>=<tenantId> --dry-run
 *
 * Rollback: this only fills NULLs, so undoing a pair is
 *   UPDATE <table> SET auth_tenant_id = NULL WHERE auth_tenant_id = '<tenantId>';
 *
 * The generated Prisma client is loaded LAZILY inside main(), never at module
 * top level, so importing this file for unit tests opens no DB connection.
 */

/** Per-table counts stamped for one workspace (all 0 when already backfilled). */
export interface BackfillCounts {
  dtTables: number;
  sheetImportConfigs: number;
  workspaceVendorAttribution: number;
  overviewSelections: number;
  workspaceNotes: number;
}

/** One Prisma model delegate, narrowed to the single call this script makes. */
interface UpdateManyDelegate {
  updateMany(args: {
    where: Record<string, unknown>;
    data: Record<string, string>;
  }): Promise<{ count: number }>;
}

/** The transaction surface this script touches (real client or a mock). */
export interface BackfillTx {
  dtTable: UpdateManyDelegate;
  sheetImportConfig: UpdateManyDelegate;
  workspaceVendorAttribution: UpdateManyDelegate;
  overviewSelection: UpdateManyDelegate;
  workspaceNotes: UpdateManyDelegate;
}

/** The minimal client shape `backfillPair` needs (real PrismaClient satisfies it). */
export interface BackfillClient {
  $transaction<T>(fn: (tx: BackfillTx) => Promise<T>): Promise<T>;
}

/**
 * Parse repeated `--map old=new` flags into pairs.
 *
 * Refuses unknown flags and malformed pairs rather than ignoring them: a typo in
 * a backfill argument should stop the run, not quietly skip a company.
 */
export function parseMaps(argv: string[]): Array<{ workspaceId: string; tenantId: string }> {
  const pairs: Array<{ workspaceId: string; tenantId: string }> = [];
  const push = (value: string) => {
    const eq = value.indexOf('=');
    const workspaceId = eq > 0 ? value.slice(0, eq).trim() : '';
    const tenantId = eq > 0 ? value.slice(eq + 1).trim() : '';
    if (!workspaceId || !tenantId) {
      throw new Error(`invalid --map pair (expected workspaceId=tenantId): ${value}`);
    }
    pairs.push({ workspaceId, tenantId });
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dry-run' || arg === '--list') continue;
    if (arg.startsWith('--map=')) {
      push(arg.slice('--map='.length));
      continue;
    }
    if (arg === '--map') {
      const value = argv[++i];
      if (value === undefined) throw new Error('--map requires a workspaceId=tenantId value');
      push(value);
      continue;
    }
    throw new Error(`unknown argument: ${arg}`);
  }
  if (pairs.length === 0) throw new Error('no --map pairs given');
  return pairs;
}

/**
 * Stamp one workspace's rows with its company, in a single transaction so a
 * company never lands half-attributed.
 *
 * `dt_tables` keys on `workspaceId`; the four side tables key on
 * `authWorkspaceId`. Both mean the same auth-brain workspace UUID.
 */
export async function backfillPair(
  client: BackfillClient,
  workspaceId: string,
  tenantId: string,
): Promise<BackfillCounts> {
  return client.$transaction(async (tx) => {
    const only = { authTenantId: null } as const; // never overwrite an existing owner
    const data = { authTenantId: tenantId };
    const [dtTables, sheetImportConfigs, workspaceVendorAttribution, overviewSelections, workspaceNotes] =
      await Promise.all([
        tx.dtTable.updateMany({ where: { workspaceId, ...only }, data }),
        tx.sheetImportConfig.updateMany({ where: { authWorkspaceId: workspaceId, ...only }, data }),
        tx.workspaceVendorAttribution.updateMany({ where: { authWorkspaceId: workspaceId, ...only }, data }),
        tx.overviewSelection.updateMany({ where: { authWorkspaceId: workspaceId, ...only }, data }),
        tx.workspaceNotes.updateMany({ where: { authWorkspaceId: workspaceId, ...only }, data }),
      ]);
    return {
      dtTables: dtTables.count,
      sheetImportConfigs: sheetImportConfigs.count,
      workspaceVendorAttribution: workspaceVendorAttribution.count,
      overviewSelections: overviewSelections.count,
      workspaceNotes: workspaceNotes.count,
    };
  });
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const { PrismaClient } = await import('@prisma/client');
  const prisma = new PrismaClient();

  try {
    if (argv.includes('--list')) {
      const groups = await prisma.dtTable.groupBy({
        by: ['workspaceId', 'authTenantId'],
        _count: { _all: true },
      });
      console.log('workspace ids present in dt_tables:');
      for (const g of groups) {
        console.log(
          `  ${g.workspaceId}  rows=${g._count._all}  company=${g.authTenantId ?? 'NOT SET'}`,
        );
      }
      console.log('\nPass each as: --map <workspaceId>=<tenantId>');
      return;
    }

    const pairs = parseMaps(argv);
    const dryRun = argv.includes('--dry-run');

    for (const { workspaceId, tenantId } of pairs) {
      if (dryRun) {
        const pending = await prisma.dtTable.count({
          where: { workspaceId, authTenantId: null },
        });
        console.log(`[dry-run] ${workspaceId} -> ${tenantId}: ${pending} dt_tables row(s) would be stamped`);
        continue;
      }
      const counts = await backfillPair(prisma, workspaceId, tenantId);
      console.log(`${workspaceId} -> ${tenantId}:`, counts);
    }
  } finally {
    await prisma.$disconnect();
  }
}

// Only run when invoked directly, so the unit test can import the helpers above.
if (process.argv[1]?.endsWith('backfill-tenant-ids.ts')) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
