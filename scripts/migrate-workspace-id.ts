/**
 * Phase 4 migration (2026-07-16 auth-brain multi-tenant plan): re-point the
 * legacy data-table workspace `receipt-ocr` at the receipts-marlinjai
 * auth-brain workspace UUID. The dynamic dt_* schema hangs everything off
 * dt_tables.id, so this single UPDATE moves the whole table (rows, columns,
 * views, files stay keyed by table id).
 *
 * Idempotent: running it again finds zero legacy tables and exits cleanly.
 *
 * Run against prod:
 *   infisical run --projectId=95d42533-3157-4b66-a49b-cc386ec1214d \
 *     --env=prod -- npx tsx scripts/migrate-workspace-id.ts
 *
 * Rollback: the script prints the previous workspace_id for every table it
 * touches; re-run with FROM/TO swapped via env overrides to undo:
 *   MIGRATE_FROM=<uuid> MIGRATE_TO=receipt-ocr ... tsx scripts/migrate-workspace-id.ts
 */

import { PrismaClient } from '@prisma/client';

const LEGACY_WORKSPACE_ID = process.env.MIGRATE_FROM?.trim() || 'receipt-ocr';
// receipts-marlinjai auth-brain workspace (provisioned 2026-07-16).
const TARGET_WORKSPACE_ID =
  process.env.MIGRATE_TO?.trim() || '019f6a90-8b7a-7ad7-9832-b145de52b9b1';

async function main() {
  const prisma = new PrismaClient();
  try {
    const legacyTables = await prisma.dtTable.findMany({
      where: { workspaceId: LEGACY_WORKSPACE_ID },
      select: { id: true, name: true, workspaceId: true },
    });

    if (legacyTables.length === 0) {
      console.log(`No tables under workspace '${LEGACY_WORKSPACE_ID}' — nothing to migrate.`);
      return;
    }

    for (const table of legacyTables) {
      const rowCount = await prisma.dtRow.count({ where: { tableId: table.id } });
      console.log(
        `Migrating table '${table.name}' (${table.id}): ${rowCount} rows, ` +
          `workspace '${table.workspaceId}' -> '${TARGET_WORKSPACE_ID}'`,
      );
    }

    const result = await prisma.dtTable.updateMany({
      where: { workspaceId: LEGACY_WORKSPACE_ID },
      data: { workspaceId: TARGET_WORKSPACE_ID },
    });
    console.log(`Updated ${result.count} dt_tables row(s).`);

    for (const table of legacyTables) {
      const rowCount = await prisma.dtRow.count({ where: { tableId: table.id } });
      console.log(`Post-migration row count for '${table.name}': ${rowCount} (must be unchanged).`);
    }
    console.log(`Rollback value if needed: previous workspace_id was '${LEGACY_WORKSPACE_ID}'.`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
