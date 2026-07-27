/**
 * App-grant migration (pre-launch gate item 6): repoint Receipts data off the
 * legacy magic `receipts-*` auth-brain workspaces onto the real tenant-owned
 * workspaces that the `receipts` app grant now opens. Data scoping is unchanged
 * (still the auth-brain workspace UUID); only WHICH workspace UUID owns each
 * company's data moves, so the operator can then delete the retired workspaces.
 *
 * Every id-partitioned table moves together for a given pair: the dynamic dt_*
 * schema hangs off `dt_tables.workspace_id`, and the four side tables key their
 * per-company config to the same auth-brain workspace UUID
 * (`sheet_import_configs.auth_workspace_id`, `workspace_vendor_attribution`,
 * `overview_selections`, `workspace_notes`). All of a pair's updates run in ONE
 * transaction so a company never lands half-migrated.
 *
 * No hardcoded UUIDs: the operator passes explicit pairs. Idempotent: an
 * already-repointed pair finds zero rows under the old id and no-ops (every
 * count 0). Unknown flags are refused rather than silently ignored.
 *
 * Usage (repeat --map per company):
 *   infisical run --projectId=95d42533-3157-4b66-a49b-cc386ec1214d --env=prod -- \
 *     npx tsx scripts/migrate-workspace-to-tenant-workspace.ts \
 *       --map <oldWorkspaceId>=<newWorkspaceId> \
 *       --map <oldWorkspaceId2>=<newWorkspaceId2>
 *
 * Rollback: re-run with each pair's sides swapped (old=new -> new=old).
 *
 * The generated Prisma client is loaded LAZILY inside main() (never at module
 * top level), so importing this module for unit tests opens no DB connection.
 */

/** Per-table row counts moved for one pair (all 0 when already repointed). */
export interface RepointCounts {
  dtTables: number;
  sheetImportConfigs: number;
  workspaceVendorAttribution: number;
  overviewSelections: number;
  workspaceNotes: number;
}

/** One Prisma model delegate, narrowed to the single call this script makes. */
interface UpdateManyDelegate {
  updateMany(args: {
    where: Record<string, string>;
    data: Record<string, string>;
  }): Promise<{ count: number }>;
}

/** The transaction client surface this script touches (real or mocked). */
export interface RepointTx {
  dtTable: UpdateManyDelegate;
  sheetImportConfig: UpdateManyDelegate;
  workspaceVendorAttribution: UpdateManyDelegate;
  overviewSelection: UpdateManyDelegate;
  workspaceNotes: UpdateManyDelegate;
}

/** The minimal client shape `repointPair` needs (real PrismaClient satisfies it). */
export interface RepointClient {
  $transaction<T>(fn: (tx: RepointTx) => Promise<T>): Promise<T>;
}

/**
 * Parse `--map oldId=newId` pairs (also accepts `--map=oldId=newId`). Requires
 * at least one pair, rejects malformed pairs and self-maps, and REFUSES any
 * unknown flag or bare positional argument (fail loud, never silently skip).
 */
export function parseMapArgs(argv: string[]): Map<string, string> {
  const map = new Map<string, string>();

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    let pair: string | undefined;

    if (arg === '--map') {
      pair = argv[++i];
      if (pair === undefined) throw new Error('--map requires an oldId=newId argument');
    } else if (arg.startsWith('--map=')) {
      pair = arg.slice('--map='.length);
    } else {
      throw new Error(`unknown argument: ${arg} (only repeated --map oldId=newId is accepted)`);
    }

    const eq = pair.indexOf('=');
    const oldId = eq === -1 ? '' : pair.slice(0, eq).trim();
    const newId = eq === -1 ? '' : pair.slice(eq + 1).trim();
    if (!oldId || !newId) {
      throw new Error(`invalid --map pair '${pair}' (expected oldWorkspaceId=newWorkspaceId)`);
    }
    if (oldId === newId) {
      throw new Error(`invalid --map pair '${pair}' (old and new workspace id are identical)`);
    }
    if (map.has(oldId)) {
      throw new Error(`duplicate --map source '${oldId}'`);
    }
    map.set(oldId, newId);
  }

  if (map.size === 0) {
    throw new Error('at least one --map oldWorkspaceId=newWorkspaceId pair is required');
  }
  return map;
}

/**
 * Repoint a single company: move `dt_tables` and the four side tables from
 * `oldId` to `newId` inside one transaction. Idempotent by construction (an
 * already-migrated pair matches zero rows). Returns the per-table counts.
 */
export async function repointPair(
  prisma: RepointClient,
  oldId: string,
  newId: string,
): Promise<RepointCounts> {
  return prisma.$transaction(async (tx) => {
    const dtTables = await tx.dtTable.updateMany({
      where: { workspaceId: oldId },
      data: { workspaceId: newId },
    });
    const sheetImportConfigs = await tx.sheetImportConfig.updateMany({
      where: { authWorkspaceId: oldId },
      data: { authWorkspaceId: newId },
    });
    const workspaceVendorAttribution = await tx.workspaceVendorAttribution.updateMany({
      where: { authWorkspaceId: oldId },
      data: { authWorkspaceId: newId },
    });
    const overviewSelections = await tx.overviewSelection.updateMany({
      where: { authWorkspaceId: oldId },
      data: { authWorkspaceId: newId },
    });
    const workspaceNotes = await tx.workspaceNotes.updateMany({
      where: { authWorkspaceId: oldId },
      data: { authWorkspaceId: newId },
    });

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
  const mapping = parseMapArgs(process.argv.slice(2));

  const { PrismaClient: Client } = await import('@prisma/client');
  const prisma = new Client() as unknown as RepointClient & { $disconnect(): Promise<void> };

  try {
    for (const [oldId, newId] of mapping) {
      console.log(`Repointing workspace '${oldId}' -> '${newId}' ...`);
      const counts = await repointPair(prisma, oldId, newId);
      const total =
        counts.dtTables +
        counts.sheetImportConfigs +
        counts.workspaceVendorAttribution +
        counts.overviewSelections +
        counts.workspaceNotes;
      console.log(
        `  dt_tables=${counts.dtTables} ` +
          `sheet_import_configs=${counts.sheetImportConfigs} ` +
          `workspace_vendor_attribution=${counts.workspaceVendorAttribution} ` +
          `overview_selections=${counts.overviewSelections} ` +
          `workspace_notes=${counts.workspaceNotes}`,
      );
      if (total === 0) {
        console.log(`  (no rows under '${oldId}' - already repointed or empty, no-op)`);
      }
    }
    console.log('Done.');
  } finally {
    await (prisma as { $disconnect(): Promise<void> }).$disconnect();
  }
}

// Run only when executed directly (tsx scripts/...), never when imported by a
// test. Comparing the resolved entry path keeps the module import side effect
// free.
import { fileURLToPath } from 'node:url';
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
