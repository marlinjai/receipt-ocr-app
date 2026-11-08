import { NextResponse } from 'next/server';
import type { AppSession } from '@marlinjai/auth-brain-nextjs';
import { auth } from '@/lib/auth';
import { sessionWorkspaceId, tenantIdForWorkspace } from '@/lib/auth-workspace';
import { prisma } from '@/lib/prisma';
import { ASSIGNMENT_LIMITS, decideAssignments, serverAssignmentDeps } from '@/lib/assignment/pass';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;
/** No model call starts after this much of a request: one call (45 seconds, one retry) still ends before maxDuration. */
const REQUEST_BUDGET_MS = 200_000;

/**
 * POST /api/receipts/assignments  ("Zuordnungen entscheiden" on the tools page)
 *
 * One run of the assignment pass for the ACTIVE company (plan
 * docs/plans/2026-11-07-learned-assignment.md): every receipt whose assignment is
 * open is decided by the model that knows the person; a confident answer is set
 * and marked as automatic, an unsure one stays asked with its suggestion. At
 * most ASSIGNMENT_LIMITS.request model calls; answers with counts only, and the
 * page calls again while `remaining` is above zero. A second run changes
 * nothing already decided. The same pass runs after every upload, retake, new
 * reading and edit of the vendor.
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
    const result = await decideAssignments(prisma, { workspaceId, tenantId: tenantIdForWorkspace(principal, workspaceId) }, serverAssignmentDeps(), {
      limit: ASSIGNMENT_LIMITS.request,
      // Well inside maxDuration: a slow provider leaves the rest for the page's next request.
      deadline: Date.now() + REQUEST_BUDGET_MS,
    });
    return NextResponse.json({ result });
  } catch (e) {
    console.error('[receipts/assignments] failed:', e instanceof Error ? `${e.name}: ${e.message}` : 'unknown error');
    return NextResponse.json({ error: 'failed' }, { status: 500 });
  }
}
