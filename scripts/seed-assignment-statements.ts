/**
 * Seeds the owner's statements as freetext rules ("Aussage über mich") of
 * Whiz-Art Media (plan docs/plans/2026-11-07-learned-assignment.md, decision 5).
 * The texts live in src/lib/assignment/seed.ts, the same ones the replay
 * counted as stated from the start.
 *
 * Idempotent and never overwriting: a statement the workspace already holds
 * with the same text is left as it is, so a second run adds nothing. A
 * statement the owner has since deleted would be added again, so run it once,
 * at release. The tenant is taken from the workspace's receipts table.
 *
 * Usage (DATABASE_URL names the database):
 *   npx tsx scripts/seed-assignment-statements.ts            # dry run: what would be added, nothing written
 *   npx tsx scripts/seed-assignment-statements.ts --apply    # write
 *
 * Output carries the workspace id, the statement keys and counts only.
 */
import { PrismaClient } from '@prisma/client';
import { OWNER_STATEMENTS, OWNER_WORKSPACE_ID } from '@/lib/assignment/seed';
import { validateRuleInput } from '@/lib/classification-rules';
import { RECEIPTS_TABLE_NAME } from '@/lib/receipts-table';

export async function seedOwnerStatements(db: PrismaClient, apply: boolean): Promise<{ workspaceId: string; added: string[]; alreadyThere: string[] }> {
  const table = await db.dtTable.findFirst({ where: { workspaceId: OWNER_WORKSPACE_ID, name: RECEIPTS_TABLE_NAME }, select: { authTenantId: true } });
  if (!table) throw new Error(`No receipts table for workspace ${OWNER_WORKSPACE_ID}: nothing seeded.`);
  const existing = new Set(
    (await db.classificationRule.findMany({ where: { authWorkspaceId: OWNER_WORKSPACE_ID, type: 'freetext' }, select: { matchValue: true } })).map((r) => r.matchValue),
  );
  const added: string[] = [];
  const alreadyThere: string[] = [];
  for (const statement of OWNER_STATEMENTS) {
    // The same checks a statement typed on the rules page passes.
    const input = validateRuleInput({ type: 'freetext', matchValue: statement.text, zuordnung: statement.zuordnung, categoryOverride: null, label: '' });
    if (existing.has(input.matchValue)) {
      alreadyThere.push(statement.key);
      continue;
    }
    if (apply) {
      const created = await db.classificationRule.createMany({
        data: [{ authWorkspaceId: OWNER_WORKSPACE_ID, authTenantId: table.authTenantId ?? null, type: input.type, matchValue: input.matchValue, zuordnung: input.zuordnung, categoryOverride: null, label: input.label }],
        skipDuplicates: true,
      });
      if (created.count === 0) {
        alreadyThere.push(statement.key);
        continue;
      }
    }
    added.push(statement.key);
  }
  return { workspaceId: OWNER_WORKSPACE_ID, added, alreadyThere };
}

if (process.argv[1]?.endsWith('seed-assignment-statements.ts')) {
  const apply = process.argv.includes('--apply');
  const db = new PrismaClient();
  seedOwnerStatements(db, apply)
    .then((r) => console.log(JSON.stringify({ mode: apply ? 'apply' : 'dry-run', ...r })))
    .catch((err) => {
      console.error(err instanceof Error ? err.message : 'failed');
      process.exitCode = 1;
    })
    .finally(() => void db.$disconnect());
}
