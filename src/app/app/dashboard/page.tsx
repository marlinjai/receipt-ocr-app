import { PrismaAdapter } from '@marlinjai/data-table-adapter-prisma';
import { prisma } from '@/lib/prisma';
import { auth } from '@/lib/auth';
import { sessionWorkspaceId } from '@/lib/auth-guards';
import { incompleteQueue } from '@/lib/meals/register';
import { loadMealRecords } from '@/lib/meals/service';
import { loadReviewQueue, type ReviewEntry } from '@/lib/review/service';
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

  // The badge on the "Bewirtung" link. A failure here must not take the whole
  // dashboard down: the count is a convenience, the page behind it has the truth.
  let openMealCount = 0;
  try {
    openMealCount = incompleteQueue(await loadMealRecords(prisma, workspaceId)).length;
  } catch (e) {
    console.error('[dashboard] open meal count failed', e);
  }

  // Receipts that need a look. Same rule as the badge: the list is help, not
  // a condition for seeing the receipts. The page reloads it after each action.
  let initialReview: ReviewEntry[] | null = [];
  try {
    initialReview = await loadReviewQueue(prisma, workspaceId);
  } catch (e) {
    console.error('[dashboard] review queue failed', e);
    // Null, not an empty list: the page then says the list could not be loaded.
    initialReview = null;
  }

  return (
    <DashboardClient
      tableId={table.id}
      workspaceId={workspaceId}
      openMealCount={openMealCount}
      initialReview={initialReview}
    />
  );
}
