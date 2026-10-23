import { describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { settleAcrossSharesCoalesced } from '../loop-service';

/**
 * A burst of answers in a company that shares accounts settles the message
 * queues once more at the end, not once per answer. The database is a stand-in
 * that has no shares, so each settling run is exactly one read of the shares.
 */

function fakeDb(fail = false) {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => (release = resolve));
  const findMany = vi.fn(async () => {
    await gate;
    if (fail) throw new Error('database gone');
    return [];
  });
  return { db: { taxAccountShare: { findMany } } as unknown as PrismaClient, findMany, release };
}

describe('settleAcrossSharesCoalesced', () => {
  it('runs once more after the running one for any number of calls in between, then starts afresh', async () => {
    const { db, findMany, release } = fakeDb();
    const calls = [settleAcrossSharesCoalesced(db, ['ws-a'], { onlyWithReceivers: true }), settleAcrossSharesCoalesced(db, ['ws-a'], { onlyWithReceivers: true }), settleAcrossSharesCoalesced(db, ['ws-a'], { onlyWithReceivers: true })];
    release();
    await Promise.all(calls);
    expect(findMany).toHaveBeenCalledTimes(2);
    // Done: the next call is a run of its own.
    await settleAcrossSharesCoalesced(db, ['ws-a'], { onlyWithReceivers: true });
    expect(findMany).toHaveBeenCalledTimes(3);
  });

  it('keeps other companies apart', async () => {
    const { db, findMany, release } = fakeDb();
    const calls = [settleAcrossSharesCoalesced(db, ['ws-a'], { onlyWithReceivers: true }), settleAcrossSharesCoalesced(db, ['ws-b'], { onlyWithReceivers: true })];
    release();
    await Promise.all(calls);
    expect(findMany).toHaveBeenCalledTimes(2);
  });

  it('a failing read is logged, never thrown, and leaves no run behind', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { db, findMany, release } = fakeDb(true);
    const first = settleAcrossSharesCoalesced(db, ['ws-a'], { onlyWithReceivers: true });
    release();
    await expect(first).resolves.toBeUndefined();
    await settleAcrossSharesCoalesced(db, ['ws-a'], { onlyWithReceivers: true });
    expect(findMany).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenCalled();
    log.mockRestore();
  });
});
