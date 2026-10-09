import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { PrismaAdapter } from '@marlinjai/data-table-adapter-prisma';
import type { CellValue } from '@marlinjai/data-table-core';
import { ensureReceiptsTable } from '@/lib/receipts-table';
import { withoutStatementCache } from '@/lib/prisma-url';

/** Helpers for the database tests: a fresh workspace with a real Receipts table. */

// The same client settings as the app's own (src/lib/prisma.ts), so the tests meet what production meets.
export const db = new PrismaClient({ datasourceUrl: withoutStatementCache(process.env.TEST_DATABASE_URL) });

export interface TestWorkspace {
  workspaceId: string;
  tenantId: string;
  adapter: PrismaAdapter;
  tableId: string;
  /** Create a receipt row from cells keyed by column NAME; select cells take the option NAME. */
  addReceipt(cells: Record<string, CellValue>): Promise<string>;
}

export async function createWorkspace(): Promise<TestWorkspace> {
  const workspaceId = `test-ws-${randomUUID()}`;
  const tenantId = `test-tenant-${randomUUID()}`;
  const adapter = new PrismaAdapter({ prisma: db });
  await ensureReceiptsTable(adapter, workspaceId, { db, tenantId });
  const table = (await adapter.listTables(workspaceId)).find((t) => t.name === 'Receipts');
  if (!table) throw new Error('Receipts table was not created');
  const columns = await adapter.getColumns(table.id);

  async function addReceipt(cells: Record<string, CellValue>): Promise<string> {
    const mapped: Record<string, CellValue> = {};
    for (const [name, value] of Object.entries(cells)) {
      const col = columns.find((c) => c.name === name);
      if (!col) throw new Error(`no column ${name}`);
      if (col.type === 'select' && typeof value === 'string') {
        const options = await adapter.getSelectOptions(col.id);
        const option = options.find((o) => o.name === value);
        if (!option) throw new Error(`no option ${value} on ${name}`);
        mapped[col.id] = option.id;
      } else {
        mapped[col.id] = value;
      }
    }
    const row = await adapter.createRow({ tableId: table!.id, cells: mapped });
    return row.id;
  }

  return { workspaceId, tenantId, adapter, tableId: table.id, addReceipt };
}

/** A meal receipt as it looks before any meal details were entered. */
export function plainMealReceipt(overrides: Record<string, CellValue> = {}): Record<string, CellValue> {
  return {
    Name: 'Mittagessen Testlokal',
    Vendor: 'Testlokal',
    Gross: 119,
    Date: '2025-03-14',
    Category: 'Bewirtung',
    Zuordnung: 'Geschäftlich',
    Currency: 'EUR',
    'FX Rate': 1,
    ...overrides,
  };
}
