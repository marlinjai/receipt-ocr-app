export const dynamic = 'force-dynamic';

import { auth } from '@/lib/auth';
import { sessionWorkspaceId } from '@/lib/auth-workspace';
import { loadInvoices } from '@/lib/overview/data';
import { getAttribution } from '@/lib/overview/attribution';
import { getNotes } from '@/lib/overview/notes';
import { prisma } from '@/lib/prisma';
import { sanitizeSelectionDef } from '@/lib/overview/selection';
import OverviewClient from './OverviewClient';

export default async function OverviewPage() {
  const session = await auth.requireSession('/app/overview');
  const workspaceId = sessionWorkspaceId(session);
  const [invoices, attribution, notes, selectionRows] = await Promise.all([
    loadInvoices(workspaceId),
    getAttribution(workspaceId),
    getNotes(workspaceId),
    prisma.overviewSelection.findMany({
      where: { authWorkspaceId: workspaceId },
      orderBy: { name: 'asc' },
      select: { id: true, name: true, definition: true },
    }),
  ]);
  const selections = selectionRows.map((s) => ({
    id: s.id,
    name: s.name,
    definition: sanitizeSelectionDef(s.definition),
  }));
  return <OverviewClient invoices={invoices} selections={selections} attribution={attribution} notes={notes} />;
}
