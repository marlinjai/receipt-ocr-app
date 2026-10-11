import { NextRequest, NextResponse } from 'next/server';
import type { AppSession } from '@marlinjai/auth-brain-nextjs';
import { PrismaAdapter } from '@marlinjai/data-table-adapter-prisma';
import { auth } from '@/lib/auth';
import { sessionWorkspaceId, tenantIdForWorkspace } from '@/lib/auth-workspace';
import { prisma } from '@/lib/prisma';
import { readReceiptItem } from '@/lib/receipt-classifier';
import { ITEM_BATCH_LIMIT, fillReceiptItems } from '@/lib/receipt-items';
import { RECEIPTS_TABLE_NAME, ensureReceiptsTable } from '@/lib/receipts-table';

export const dynamic = 'force-dynamic';
export const maxDuration = 180;

/**
 * POST /api/receipts/items  Body: { rowIds: string[] }
 *
 * Give the named receipts of the active company what was bought (where they
 * hold none) and build their names again from their cells. At most
 * ITEM_BATCH_LIMIT rows per call; a row that failed is unchanged and can be
 * sent again. See `lib/receipt-items.ts` for what is and is not touched.
 */
export async function POST(req: NextRequest) {
  let principal: AppSession;
  try {
    principal = await auth.requireAction('receipts.row.write');
  } catch (e) {
    const status = (e as { status?: number }).status === 401 ? 401 : 403;
    return NextResponse.json({ error: status === 401 ? 'unauthorized' : 'forbidden' }, { status });
  }
  const body = (await req.json().catch(() => ({}))) as { rowIds?: unknown };
  const rowIds = Array.isArray(body.rowIds) ? body.rowIds.filter((id): id is string => typeof id === 'string' && id !== '') : [];
  if (rowIds.length === 0) return NextResponse.json({ error: 'no_rows' }, { status: 400 });
  if (rowIds.length > ITEM_BATCH_LIMIT) return NextResponse.json({ error: 'too_many_rows', limit: ITEM_BATCH_LIMIT }, { status: 400 });

  try {
    const workspaceId = sessionWorkspaceId(principal);
    const adapter = new PrismaAdapter({ prisma });
    // The item column is added to a table that predates it, exactly as a page load would.
    await ensureReceiptsTable(adapter, workspaceId, { db: prisma, tenantId: tenantIdForWorkspace(principal, workspaceId) });
    const table = (await adapter.listTables(workspaceId)).find((t) => t.name === RECEIPTS_TABLE_NAME);
    if (!table) return NextResponse.json({ error: 'no_table' }, { status: 404 });
    const results = await fillReceiptItems(adapter, table.id, rowIds, readReceiptItem);
    return NextResponse.json({ results });
  } catch (e) {
    console.error('[receipts/items] failed:', e instanceof Error ? `${e.name}: ${e.message}` : 'unknown error');
    return NextResponse.json({ error: 'failed' }, { status: 500 });
  }
}
