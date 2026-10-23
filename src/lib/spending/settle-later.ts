import 'server-only';
import { after } from 'next/server';
import type { PrismaClient } from '@prisma/client';
import { touchesSharedAccount } from '@/lib/tax/payments/routing';
import { settleAcrossSharesCoalesced } from './loop-service';

/**
 * After a change in a company that may have moved a payment of a shared
 * account between companies (an answer, a link, an undone import, a deleted
 * receipt; plan docs/plans/2026-10-22-payments-across-companies.md), the
 * message queues of that company and of the companies receiving its private
 * payments are settled, after the answer is sent. Only where the change
 * touches a shared account, and coalesced, so a burst of clicks settles once
 * more at the end. A failure is logged only: the next run of the loop settles
 * the same messages.
 */
export function settleMovedPaymentsLater(db: PrismaClient, workspaceId: string, hint: Parameters<typeof touchesSharedAccount>[2] = {}): void {
  after(async () => {
    try {
      if (!(await touchesSharedAccount(db, workspaceId, hint))) return;
      await settleAcrossSharesCoalesced(db, [workspaceId], { onlyWithReceivers: true });
    } catch (e) {
      console.error('[spending] settling messages of moved payments failed', (e as Error)?.name ?? 'error');
    }
  });
}
