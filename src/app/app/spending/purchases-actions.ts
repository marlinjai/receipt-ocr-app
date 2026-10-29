'use server';

import { ReceiptsAuthError, requireReceiptsSession } from '@/lib/auth-guards';
import { MissingTenantError, sessionWorkspaceId } from '@/lib/auth-workspace';
import { prisma } from '@/lib/prisma';
import { loadPurchases } from '@/lib/line-items/service';
import type { PurchasesOverview } from '@/lib/line-items/overview';
import { safeMonth, safeYear } from '@/lib/spending/period';

/**
 * "Was gekauft" of the ACTIVE company (plan 2026-10-26-receipt-line-items,
 * decision 6). Business and private receipts both count, each in the company
 * it belongs to. Read only; failures are returned with a stable code.
 */
export type PurchasesResult = { ok: true; value: PurchasesOverview } | { ok: false; error: 'unauthorized' | 'forbidden' | 'failed' };

export async function getPurchases(year: unknown, month: unknown): Promise<PurchasesResult> {
  try {
    const session = await requireReceiptsSession();
    return { ok: true, value: await loadPurchases(prisma, sessionWorkspaceId(session), { year: safeYear(year), month: safeMonth(month) }) };
  } catch (e) {
    if (e instanceof ReceiptsAuthError) return { ok: false, error: e.status === 401 ? 'unauthorized' : 'forbidden' };
    if (e instanceof MissingTenantError) return { ok: false, error: 'forbidden' };
    const status = (e as { status?: number })?.status;
    if (status === 401) return { ok: false, error: 'unauthorized' };
    if (status === 403) return { ok: false, error: 'forbidden' };
    console.error('[spending] loading what was bought failed:', e instanceof Error ? e.name : 'error');
    return { ok: false, error: 'failed' };
  }
}
