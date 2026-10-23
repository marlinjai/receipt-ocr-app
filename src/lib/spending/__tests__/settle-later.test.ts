import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Settling the message queues after a change that may have moved a payment of
 * a shared account (an answer, a link, an undone import, a deleted receipt):
 * after the answer, only where a shared account is touched, never failing the
 * change. The two steps are stand-ins; both are tested against the database
 * in `routing.dbtest.ts` and `settle-coalesced.test.ts`.
 */

const touchesSharedAccount = vi.fn();
const settleAcrossSharesCoalesced = vi.fn();
const deferred: Array<() => Promise<unknown>> = [];

vi.mock('next/server', () => ({ after: (task: () => Promise<unknown>) => deferred.push(task) }));
vi.mock('@/lib/tax/payments/routing', () => ({ touchesSharedAccount: (...a: unknown[]) => touchesSharedAccount(...a) }));
vi.mock('../loop-service', () => ({ settleAcrossSharesCoalesced: (...a: unknown[]) => settleAcrossSharesCoalesced(...a) }));

import type { PrismaClient } from '@prisma/client';
import { settleMovedPaymentsLater } from '../settle-later';

const db = { marker: 'prisma' } as unknown as PrismaClient;

beforeEach(() => {
  deferred.length = 0;
  touchesSharedAccount.mockReset();
  settleAcrossSharesCoalesced.mockReset();
});

describe('settleMovedPaymentsLater', () => {
  it('does nothing before the answer is sent, then settles the company and its receivers', async () => {
    touchesSharedAccount.mockResolvedValue(true);
    settleMovedPaymentsLater(db, 'ws-a', { paymentId: 'p1' });
    expect(touchesSharedAccount).not.toHaveBeenCalled();
    await deferred[0]();
    expect(touchesSharedAccount).toHaveBeenCalledWith(db, 'ws-a', { paymentId: 'p1' });
    expect(settleAcrossSharesCoalesced).toHaveBeenCalledWith(db, ['ws-a'], { onlyWithReceivers: true });
  });

  it('settles nothing when no shared account is touched', async () => {
    touchesSharedAccount.mockResolvedValue(false);
    settleMovedPaymentsLater(db, 'ws-a');
    await deferred[0]();
    expect(settleAcrossSharesCoalesced).not.toHaveBeenCalled();
  });

  it('logs a failure and never throws it', async () => {
    touchesSharedAccount.mockRejectedValue(new Error('database gone'));
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    settleMovedPaymentsLater(db, 'ws-a');
    await expect(deferred[0]()).resolves.toBeUndefined();
    expect(log).toHaveBeenCalled();
    log.mockRestore();
  });
});
