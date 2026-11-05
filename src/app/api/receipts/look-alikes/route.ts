import { NextResponse } from 'next/server';
import type { AppSession } from '@marlinjai/auth-brain-nextjs';
import { auth } from '@/lib/auth';
import { sessionWorkspaceId, tenantIdForWorkspace } from '@/lib/auth-workspace';
import { prisma } from '@/lib/prisma';
import { LOOK_ALIKE_LIMITS, serverLookAlikeDeps, settleLookAlikes } from '@/lib/review/look-alikes';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/**
 * POST /api/receipts/look-alikes  ("Duplikate klären" on the tools page)
 *
 * One run of the look-alike pass for the ACTIVE company (plan
 * docs/plans/2026-11-05-duplicates-without-asking.md): the missing invoice
 * numbers of look-alike receipts are read again (stored text and file name,
 * then the small model with the page), what is now the same invoice is merged,
 * and the pairs no number decides are compared by the strongest model. At most
 * LOOK_ALIKE_LIMITS.request model calls; answers with counts only, and the
 * page calls again while `remaining` is above zero. The same pass runs daily
 * for every company and after every upload, retake and new reading.
 */
export async function POST() {
  let principal: AppSession;
  try {
    principal = await auth.requireAction('receipts.row.write');
  } catch (e) {
    const status = (e as { status?: number }).status === 401 ? 401 : 403;
    return NextResponse.json({ error: status === 401 ? 'unauthorized' : 'forbidden' }, { status });
  }
  try {
    const workspaceId = sessionWorkspaceId(principal);
    const result = await settleLookAlikes(prisma, { workspaceId, tenantId: tenantIdForWorkspace(principal, workspaceId) }, await serverLookAlikeDeps(), {
      numberLimit: LOOK_ALIKE_LIMITS.request.numbers,
      pairLimit: LOOK_ALIKE_LIMITS.request.pairs,
    });
    return NextResponse.json({ result });
  } catch (e) {
    console.error('[receipts/look-alikes] failed:', e instanceof Error ? `${e.name}: ${e.message}` : 'unknown error');
    return NextResponse.json({ error: 'failed' }, { status: 500 });
  }
}
