'use server';

import { requireReceiptsSession } from '@/lib/auth-guards';
import { sessionWorkspaceId } from '@/lib/auth-workspace';
import { incompleteQueue } from '@/lib/meals/register';
import { loadMealRecords } from '@/lib/meals/service';
import { prisma } from '@/lib/prisma';
import { loadReviewQueue } from '@/lib/review/service';
import { withSharedReads } from '@/lib/shared-reads';

export interface NavCounts {
  /** Receipts in "Belege prüfen". */
  review: number;
  /** Business meals without participants or occasion. */
  meals: number;
}

/** The numbers of the sidebar, for the active company. A failure returns nothing to show, never a wrong zero. */
export async function getNavCounts(): Promise<{ ok: true; value: NavCounts } | { ok: false }> {
  try {
    const workspaceId = sessionWorkspaceId(await requireReceiptsSession());
    const [meals, review] = await withSharedReads(() => Promise.all([loadMealRecords(prisma, workspaceId), loadReviewQueue(prisma, workspaceId)]));
    return { ok: true, value: { review: review.length, meals: incompleteQueue(meals).length } };
  } catch (e) {
    console.error('[nav] counts failed', e instanceof Error ? e.name : 'unknown');
    return { ok: false };
  }
}
