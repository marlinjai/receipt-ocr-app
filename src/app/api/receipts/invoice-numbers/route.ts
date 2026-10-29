import { NextResponse } from 'next/server';
import type { AppSession } from '@marlinjai/auth-brain-nextjs';
import { auth } from '@/lib/auth';
import { sessionWorkspaceId, tenantIdForWorkspace } from '@/lib/auth-workspace';
import { prisma } from '@/lib/prisma';
import { INVOICE_NUMBER_BATCH_LIMIT, backfillInvoiceNumbers } from '@/lib/review/invoice-number-backfill';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

/**
 * POST /api/receipts/invoice-numbers  ("Rechnungsnummern lesen" on the receipts page)
 *
 * One run of the invoice number backfill for the ACTIVE company: reads the
 * number of at most INVOICE_NUMBER_BATCH_LIMIT stored receipts not looked at
 * yet from their stored text (no model, nothing spent), then archives what is
 * now the same receipt into the more complete one. Answers with counts only;
 * the page calls again while some are left. See
 * `lib/review/invoice-number-backfill.ts`.
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
    const result = await backfillInvoiceNumbers(prisma, { workspaceId, tenantId: tenantIdForWorkspace(principal, workspaceId) }, { limit: INVOICE_NUMBER_BATCH_LIMIT });
    return NextResponse.json({ result });
  } catch (e) {
    console.error('[receipts/invoice-numbers] failed:', e instanceof Error ? `${e.name}: ${e.message}` : 'unknown error');
    return NextResponse.json({ error: 'failed' }, { status: 500 });
  }
}
