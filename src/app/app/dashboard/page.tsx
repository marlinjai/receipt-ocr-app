import { PrismaAdapter } from '@marlinjai/data-table-adapter-prisma';
import { prisma } from '@/lib/prisma';
import { auth } from '@/lib/auth';
import { sessionWorkspaceId } from '@/lib/auth-guards';
import DashboardClient from './DashboardClient';

export const dynamic = 'force-dynamic';

export default async function DashboardPage() {
  // The middleware gates the route; requireSession resolves the verified
  // session (or redirects) so the table lookup is scoped to the ACTIVE
  // workspace, server-side.
  const session = await auth.requireSession('/app/dashboard');
  const workspaceId = sessionWorkspaceId(session);

  const adapter = new PrismaAdapter({ prisma });
  const tables = await adapter.listTables(workspaceId);
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
      workspaceId={workspaceId}
    />
  );
}
