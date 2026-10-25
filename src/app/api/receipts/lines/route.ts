import { NextResponse } from 'next/server';
import type { AppSession } from '@marlinjai/auth-brain-nextjs';
import { auth } from '@/lib/auth';
import { sessionWorkspaceId, tenantIdForWorkspace } from '@/lib/auth-workspace';
import { prisma } from '@/lib/prisma';
import { readReceiptLines } from '@/lib/receipt-classifier';
import { LINES_BATCH_LIMIT, backfillReceiptLines } from '@/lib/line-items/backfill';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/**
 * POST /api/receipts/lines  ("Positionen lesen" on the receipts page)
 *
 * One run of the line backfill for the ACTIVE company: reads the lines of at
 * most LINES_BATCH_LIMIT stored receipts that have none yet, from their
 * stored text, and answers with what it did and how many are left. The
 * receipts are chosen on the server, never named by the browser; the page
 * calls again while some are left. See `lib/line-items/backfill.ts`.
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
    const result = await backfillReceiptLines(prisma, { workspaceId, tenantId: tenantIdForWorkspace(principal, workspaceId) }, readReceiptLines, { limit: LINES_BATCH_LIMIT });
    if (result.unavailable) return NextResponse.json({ error: 'model_unavailable', result }, { status: 503 });
    return NextResponse.json({ result });
  } catch (e) {
    console.error('[receipts/lines] failed:', e instanceof Error ? `${e.name}: ${e.message}` : 'unknown error');
    return NextResponse.json({ error: 'failed' }, { status: 500 });
  }
}
