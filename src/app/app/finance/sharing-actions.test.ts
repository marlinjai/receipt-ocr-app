import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The sharing server actions: the write permission in BOTH companies, the
 * target only ever one of the person's own memberships, the active company as
 * the holder, and the error codes. Auth and database are replaced; the
 * service is a spy (its behaviour against a real database is in
 * `routing.dbtest.ts`).
 */

const requireAction = vi.fn();
const requireReceiptsSession = vi.fn();
const shareAccount = vi.fn();
const endShare = vi.fn();
const loadShares = vi.fn();
const runSpendingChecks = vi.fn();

vi.mock('next/server', () => ({ after: (fn: () => unknown) => fn() }));
vi.mock('@/lib/auth', () => ({ auth: { requireAction: (...a: unknown[]) => requireAction(...a) } }));
vi.mock('@/lib/auth-guards', () => {
  class ReceiptsAuthError extends Error {
    constructor(readonly status: number) {
      super('auth');
    }
  }
  return { ReceiptsAuthError, requireReceiptsSession: (...a: unknown[]) => requireReceiptsSession(...a) };
});
vi.mock('@/lib/prisma', () => ({ prisma: { marker: 'prisma' } }));
vi.mock('@/lib/spending/checks', () => ({ runSpendingChecks: (...a: unknown[]) => runSpendingChecks(...a) }));
vi.mock('@/lib/tax/payments/routing', () => {
  class ShareError extends Error {
    constructor(readonly code: string) {
      super(code);
    }
  }
  return {
    ShareError,
    shareAccount: (...a: unknown[]) => shareAccount(...a),
    endShare: (...a: unknown[]) => endShare(...a),
    loadShares: (...a: unknown[]) => loadShares(...a),
  };
});

import { ReceiptsAuthError } from '@/lib/auth-guards';
import { ShareError } from '@/lib/tax/payments/routing';
import { endAccountShare, getSharingView, shareAccountWith } from './sharing-actions';

const A = { id: 'ws-a', slug: 'firma', role: 'member', tenantId: 't-a', tenantName: 'Firma' };
const B = { id: 'ws-b', slug: 'privat', role: 'member', tenantId: 't-b', tenantName: 'Privat' };
const SESSION = { userId: 'user-1', memberships: [A, B, { ...B }], activeWorkspace: A };

beforeEach(() => {
  for (const f of [requireAction, requireReceiptsSession, shareAccount, endShare, loadShares, runSpendingChecks]) f.mockReset();
  loadShares.mockResolvedValue({ outgoing: [], incoming: [] });
  runSpendingChecks.mockResolvedValue({ loop: null, budgets: null });
});

describe('getSharingView', () => {
  it('offers the person\'s other companies once each, never the active one, and says whether it may write', async () => {
    requireReceiptsSession.mockResolvedValue(SESSION);
    requireAction.mockResolvedValue(SESSION);
    loadShares.mockResolvedValue({ outgoing: [{ id: 's1', accountId: 'acc', accountLabel: 'Girokonto', otherWorkspaceId: 'ws-gone', createdAt: '2026-10-22T00:00:00.000Z' }], incoming: [] });
    const result = await getSharingView();
    expect(result).toEqual({
      ok: true,
      value: {
        outgoing: [expect.objectContaining({ id: 's1', otherName: null })],
        incoming: [],
        targets: [{ workspaceId: 'ws-b', label: 'Privat' }],
        canWrite: true,
      },
    });
    expect(loadShares).toHaveBeenCalledWith({ marker: 'prisma' }, 'ws-a');
  });
});

describe('shareAccountWith', () => {
  it('needs the write permission in the active company first', async () => {
    requireAction.mockRejectedValue(new ReceiptsAuthError(403));
    expect(await shareAccountWith('acc', 'ws-b')).toEqual({ ok: false, error: 'forbidden' });
    expect(shareAccount).not.toHaveBeenCalled();
  });

  it('refuses a company the person is no member of as forbidden, without asking anything about it', async () => {
    requireAction.mockResolvedValue(SESSION);
    expect(await shareAccountWith('acc', 'ws-stranger')).toEqual({ ok: false, error: 'forbidden' });
    expect(requireAction).toHaveBeenCalledTimes(1);
    expect(shareAccount).not.toHaveBeenCalled();
  });

  it('needs the write permission in the receiving company too', async () => {
    requireAction.mockImplementation(async (_action: string, workspaceId?: string) => {
      if (workspaceId === 'ws-b') throw Object.assign(new Error('deny'), { status: 403 });
      return SESSION;
    });
    expect(await shareAccountWith('acc', 'ws-b')).toEqual({ ok: false, error: 'forbidden' });
    expect(requireAction).toHaveBeenLastCalledWith('receipts.row.write', 'ws-b');
    expect(shareAccount).not.toHaveBeenCalled();
  });

  it('refuses the active company itself and a missing account', async () => {
    requireAction.mockResolvedValue(SESSION);
    expect(await shareAccountWith('acc', 'ws-a')).toEqual({ ok: false, error: 'invalid_input', detail: 'same_company' });
    expect(await shareAccountWith('', 'ws-b')).toEqual({ ok: false, error: 'not_found', detail: 'account_not_found' });
    expect(shareAccount).not.toHaveBeenCalled();
  });

  it('shares with both companies stamped, records who did it, and checks the receiving company once', async () => {
    requireAction.mockResolvedValue(SESSION);
    const result = await shareAccountWith('acc', 'ws-b');
    expect(result.ok).toBe(true);
    expect(shareAccount).toHaveBeenCalledWith({ marker: 'prisma' }, { workspaceId: 'ws-a', tenantId: 't-a' }, 'acc', { workspaceId: 'ws-b', tenantId: 't-b' }, 'user-1');
    expect(runSpendingChecks).toHaveBeenCalledWith({ marker: 'prisma' }, { workspaceId: 'ws-b', tenantId: 't-b' }, expect.objectContaining({ today: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) }));
  });

  it('passes a refusal of the service on with its code', async () => {
    requireAction.mockResolvedValue(SESSION);
    shareAccount.mockRejectedValue(new ShareError('already_shared'));
    expect(await shareAccountWith('acc', 'ws-b')).toEqual({ ok: false, error: 'invalid_input', detail: 'already_shared' });
    shareAccount.mockRejectedValue(new ShareError('account_not_found'));
    expect(await shareAccountWith('acc', 'ws-b')).toEqual({ ok: false, error: 'not_found', detail: 'account_not_found' });
  });
});

describe('endAccountShare', () => {
  it('ends a share of the active company and answers with the fresh view', async () => {
    requireAction.mockResolvedValue(SESSION);
    expect((await endAccountShare('s1')).ok).toBe(true);
    expect(endShare).toHaveBeenCalledWith({ marker: 'prisma' }, 'ws-a', 's1');
  });

  it('refuses without the write permission and for an unknown share', async () => {
    requireAction.mockRejectedValue(new ReceiptsAuthError(403));
    expect(await endAccountShare('s1')).toEqual({ ok: false, error: 'forbidden' });
    requireAction.mockResolvedValue(SESSION);
    endShare.mockRejectedValue(new ShareError('share_not_found'));
    expect(await endAccountShare('s1')).toEqual({ ok: false, error: 'not_found', detail: 'share_not_found' });
    expect(await endAccountShare(42)).toEqual({ ok: false, error: 'not_found', detail: 'share_not_found' });
  });
});
