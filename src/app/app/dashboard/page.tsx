import { PrismaAdapter } from '@marlinjai/data-table-adapter-prisma';
import { prisma } from '@/lib/prisma';
import { WORKSPACE_ID } from '@/lib/receipts-constants';
import DashboardClient from './DashboardClient';

export const dynamic = 'force-dynamic';

export default async function DashboardPage() {
  const adapter = new PrismaAdapter({ prisma });

  // Find the Receipts table
  const tables = await adapter.listTables(WORKSPACE_ID);
  const table = tables.find((t) => t.name === 'Receipts');

  if (!table) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-center">
          <p className="text-lg font-medium text-gray-400">
            Receipts table not initialized.
          </p>
          <p className="text-sm mt-2 text-gray-500">
            Upload a receipt first to create the table.
          </p>
        </div>
      </div>
    );
  }

  return (
    <DashboardClient
      tableId={table.id}
      workspaceId={WORKSPACE_ID}
    />
  );
}
