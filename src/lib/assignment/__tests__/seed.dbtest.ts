import { afterAll, describe, expect, it } from 'vitest';
import { PrismaAdapter } from '@marlinjai/data-table-adapter-prisma';
import { ensureReceiptsTable } from '@/lib/receipts-table';
import { db } from '../../../../test/db-helpers';
import { OWNER_STATEMENTS, OWNER_WORKSPACE_ID } from '../seed';
import { seedOwnerStatements } from '../../../../scripts/seed-assignment-statements';

/** The owner's statements (plan 2026-11-07-learned-assignment, decision 5): dry run, write, idempotent, never overwriting. */
afterAll(async () => {
  await db.$disconnect();
});

const statements = () => db.classificationRule.findMany({ where: { authWorkspaceId: OWNER_WORKSPACE_ID, type: 'freetext' }, orderBy: { matchValue: 'asc' } });

describe('seedOwnerStatements', () => {
  it('refuses a workspace without its receipts table, writes nothing in a dry run, then seeds once and never again', async () => {
    await expect(seedOwnerStatements(db, true)).rejects.toThrow(/No receipts table/);
    await ensureReceiptsTable(new PrismaAdapter({ prisma: db }), OWNER_WORKSPACE_ID, { db, tenantId: 'tenant-owner' });

    const dry = await seedOwnerStatements(db, false);
    expect(dry.added).toEqual(OWNER_STATEMENTS.map((s) => s.key));
    expect(await statements()).toEqual([]);

    // One of them is already there, edited by the owner: it stays as he left it.
    await db.classificationRule.create({ data: { authWorkspaceId: OWNER_WORKSPACE_ID, type: 'freetext', matchValue: OWNER_STATEMENTS[0].text, zuordnung: null, label: 'meins' } });
    const first = await seedOwnerStatements(db, true);
    expect(first).toEqual({ workspaceId: OWNER_WORKSPACE_ID, added: OWNER_STATEMENTS.slice(1).map((s) => s.key), alreadyThere: [OWNER_STATEMENTS[0].key] });
    const stored = await statements();
    expect(stored).toHaveLength(OWNER_STATEMENTS.length);
    expect(stored.find((r) => r.matchValue === OWNER_STATEMENTS[0].text)).toMatchObject({ zuordnung: null, label: 'meins' });
    expect(stored.find((r) => r.matchValue === OWNER_STATEMENTS[1].text)).toMatchObject({ zuordnung: OWNER_STATEMENTS[1].zuordnung, authTenantId: 'tenant-owner' });

    const again = await seedOwnerStatements(db, true);
    expect(again.added).toEqual([]);
    expect(await statements()).toHaveLength(OWNER_STATEMENTS.length);
  });
});
