import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { PrismaAdapter } from '@marlinjai/data-table-adapter-prisma';
import { ensureReceiptsTable } from '../receipts-table';
import { db } from '../../../test/db-helpers';

/**
 * A Receipts table created for a workspace carries the company it belongs to
 * from the first moment, instead of waiting for the tenant backfill script.
 */

afterAll(async () => {
  await db.$disconnect();
});

const tableOf = async (workspaceId: string) => db.dtTable.findFirst({ where: { workspaceId, name: 'Receipts' } });

describe('ensureReceiptsTable: owning company', () => {
  it('stamps the company on the table it creates', async () => {
    const workspaceId = `test-ws-${randomUUID()}`;
    await ensureReceiptsTable(new PrismaAdapter({ prisma: db }), workspaceId, { db, tenantId: 'tenant-a' });
    expect((await tableOf(workspaceId))?.authTenantId).toBe('tenant-a');
  });

  it('never overwrites an owner on a later call', async () => {
    const workspaceId = `test-ws-${randomUUID()}`;
    const adapter = new PrismaAdapter({ prisma: db });
    await ensureReceiptsTable(adapter, workspaceId, { db, tenantId: 'tenant-a' });
    await ensureReceiptsTable(adapter, workspaceId, { db, tenantId: 'tenant-b' });
    expect((await tableOf(workspaceId))?.authTenantId).toBe('tenant-a');
  });

  it('leaves the company empty when the session has none (development bypass)', async () => {
    const workspaceId = `test-ws-${randomUUID()}`;
    await ensureReceiptsTable(new PrismaAdapter({ prisma: db }), workspaceId, { db, tenantId: null });
    expect((await tableOf(workspaceId))?.authTenantId).toBeNull();
  });
});
