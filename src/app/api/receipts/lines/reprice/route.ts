import { NextResponse } from 'next/server';
import type { AppSession } from '@marlinjai/auth-brain-nextjs';
import { auth } from '@/lib/auth';
import { sessionWorkspaceId, tenantIdForWorkspace } from '@/lib/auth-workspace';
import { prisma } from '@/lib/prisma';
import { repriceCompanyLines } from '@/lib/line-items/reprice';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

/**
 * POST /api/receipts/lines/reprice
 *
 * Settles again, for every receipt of the ACTIVE company, whether its stored
 * lines are gross or net, from the stored lines and the row's figures (no
 * model, nothing spent): an invoice that prints its positions before tax gets
 * its lines' gross. Answers with counts only (`lookedAt`, `rederived`,
 * `unchanged`, `failed`); a run again changes nothing. Status 500 when a
 * receipt failed, with the counts: a run again tries it. See
 * `lib/line-items/reprice.ts`.
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
    const result = await repriceCompanyLines(prisma, { workspaceId, tenantId: tenantIdForWorkspace(principal, workspaceId) });
    if (result.failed > 0) return NextResponse.json({ error: 'partly_failed', result }, { status: 500 });
    return NextResponse.json({ result });
  } catch (e) {
    console.error('[receipts/lines/reprice] failed:', e instanceof Error ? `${e.name}: ${e.message}` : 'unknown error');
    return NextResponse.json({ error: 'failed' }, { status: 500 });
  }
}
