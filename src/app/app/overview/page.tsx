export const dynamic = 'force-dynamic';

import { auth } from '@/lib/auth';
import { sessionWorkspaceId } from '@/lib/auth-workspace';
import { loadOverview } from '@/lib/overview/data';
import { getAttribution } from '@/lib/overview/attribution';
import { getNotes } from '@/lib/overview/notes';
import OverviewClient from './OverviewClient';

export default async function OverviewPage() {
  const session = await auth.requireSession('/app/overview');
  const workspaceId = sessionWorkspaceId(session);
  const [data, attribution, notes] = await Promise.all([
    loadOverview(workspaceId),
    getAttribution(workspaceId),
    getNotes(workspaceId),
  ]);
  return <OverviewClient data={data} attribution={attribution} notes={notes} />;
}
