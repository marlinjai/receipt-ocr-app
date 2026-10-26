import { PrismaAdapter } from '@marlinjai/data-table-adapter-prisma';
import { prisma } from '@/lib/prisma';
import { auth } from '@/lib/auth';
import { sessionWorkspaceId } from '@/lib/auth-guards';
import { incompleteQueue } from '@/lib/meals/register';
import { loadMealRecords } from '@/lib/meals/service';
import { loadReviewQueue, type ReviewEntry } from '@/lib/review/service';
import { RECEIPT_PARAM } from '@/lib/receipt-link';
import { YEAR_PARAM } from '@/lib/receipt-years';
import { yearCounts } from '@/lib/receipt-year-counts';
import { autoGroupRecurring } from '@/lib/groups/auto-service';
import { measurePage, timed } from '@/lib/timing';
import { initializeReceiptsTable } from '../actions';
import DashboardClient from './DashboardClient';

type YearCountsProp = Awaited<ReturnType<typeof yearCounts>>;

export const dynamic = 'force-dynamic';

export default async function DashboardPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  return measurePage('/app/dashboard', () => renderDashboard(searchParams));
}

async function renderDashboard(searchParams: Promise<Record<string, string | string[] | undefined>>) {
  // A link from another area names the receipt to open (see `receiptHref`).
  const openParam = (await searchParams)[RECEIPT_PARAM];
  const openRowId = typeof openParam === 'string' && openParam ? openParam : null;
  // The years the address asks for ("?jahr=2022-2024,2026"), see `parseYearParam`.
  const yearParam = (await searchParams)[YEAR_PARAM];
  const initialYears = typeof yearParam === 'string' ? yearParam : null;
  // The middleware gates the route; requireSession resolves the verified
  // session (or redirects) so the table lookup is scoped to the ACTIVE
  // workspace, server-side.
  const session = await timed('auth.session', () => auth.requireSession('/app/dashboard'));
  const workspaceId = sessionWorkspaceId(session);

  // The layout also does this, but the layout and the page render side by side: the columns this page
  // groups by must exist before it asks for them.
  await timed('init', () => initializeReceiptsTable());
  const adapter = new PrismaAdapter({ prisma });
  const tables = await timed('tables', () => adapter.listTables(workspaceId));
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

  // Recurring receipts are grouped by vendor, item and year each time the table is opened, so it loads
  // already grouped (see `lib/groups/auto.ts`). A failure leaves the table as it is.
  try {
    await timed('autoGroup', () => autoGroupRecurring(prisma, workspaceId));
  } catch (e) {
    console.error('[dashboard] automatic grouping failed', e instanceof Error ? e.name : 'unknown');
  }
  // How many receipts each year has: the year chips and the year the table opens on.
  let counts: YearCountsProp = { years: [], undated: 0 };
  try {
    counts = await timed('yearCounts', async () => yearCounts(prisma, table.id, await adapter.getColumns(table.id)));
  } catch (e) {
    console.error('[dashboard] year counts failed', e instanceof Error ? e.name : 'unknown');
  }

  // The badge on the "Bewirtung" link. A failure here must not take the whole
  // dashboard down: the count is a convenience, the page behind it has the truth.
  let openMealCount = 0;
  try {
    openMealCount = incompleteQueue(await timed('meals', () => loadMealRecords(prisma, workspaceId))).length;
  } catch (e) {
    console.error('[dashboard] open meal count failed', e);
  }

  // Receipts that need a look. Same rule as the badge: the list is help, not
  // a condition for seeing the receipts. The page reloads it after each action.
  let initialReview: ReviewEntry[] | null = [];
  try {
    initialReview = await timed('review', () => loadReviewQueue(prisma, workspaceId));
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
      openRowId={openRowId}
      initialYears={initialYears}
      yearCounts={counts}
    />
  );
}
