import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The spending server actions: the write permission, the workspace always
 * taken from the session, and the error codes. Auth and database are
 * replaced; the services are spies (their behaviour against a real database
 * is in `service.dbtest.ts`).
 */

const requireAction = vi.fn();
const requireReceiptsSession = vi.fn();
const loadSpending = vi.fn();
const setCounterpartyCategory = vi.fn();
const removeCounterpartyCategory = vi.fn();
const markCounterpartyOwnAccount = vi.fn();
const unmarkCounterpartyOwnAccount = vi.fn();

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
vi.mock('@/lib/spending/service', () => {
  class SpendingServiceError extends Error {
    constructor(readonly code: string) {
      super(code);
    }
  }
  return {
    SpendingServiceError,
    loadSpending: (...a: unknown[]) => loadSpending(...a),
    setCounterpartyCategory: (...a: unknown[]) => setCounterpartyCategory(...a),
    removeCounterpartyCategory: (...a: unknown[]) => removeCounterpartyCategory(...a),
    markCounterpartyOwnAccount: (...a: unknown[]) => markCounterpartyOwnAccount(...a),
    unmarkCounterpartyOwnAccount: (...a: unknown[]) => unmarkCounterpartyOwnAccount(...a),
  };
});
const unlinkRoutedPayment = vi.fn();
vi.mock('@/lib/tax/payments/routing', () => ({ unlinkRoutedPayment: (...a: unknown[]) => unlinkRoutedPayment(...a) }));
vi.mock('@/lib/tax/payments/service', () => {
  class PaymentServiceError extends Error {
    constructor(readonly code: string) {
      super(code);
    }
  }
  return { PaymentServiceError };
});

import { ReceiptsAuthError } from '@/lib/auth-guards';
import { SpendingServiceError } from '@/lib/spending/service';
import { PaymentServiceError } from '@/lib/tax/payments/service';
import { answerCategory, getSpending, markOwnAccount, unlinkRoutedReceipt, unmarkOwnAccount, withdrawCategory } from './actions';

const WS = { id: 'ws-a', slug: 'beispiel', role: 'member', tenantId: 't-a' };
const SESSION = { memberships: [WS], activeWorkspace: WS };
const VIEW = { overview: { year: 2026 }, accounts: [], sharedOut: [], dormantLinks: [] };

beforeEach(() => {
  for (const f of [requireAction, requireReceiptsSession, loadSpending, setCounterpartyCategory, removeCounterpartyCategory, markCounterpartyOwnAccount, unmarkCounterpartyOwnAccount, unlinkRoutedPayment]) f.mockReset();
  loadSpending.mockResolvedValue(VIEW);
});

describe('getSpending', () => {
  it('reads the active workspace of the session and says whether it may write', async () => {
    requireReceiptsSession.mockResolvedValue(SESSION);
    requireAction.mockResolvedValue(SESSION);
    expect(await getSpending('2025', '3')).toEqual({ ok: true, value: { ...VIEW, canWrite: true, companies: {} } });
    expect(loadSpending).toHaveBeenCalledWith({ marker: 'prisma' }, 'ws-a', 2025, 3);
  });

  it('shows the page read-only when the write check refuses', async () => {
    requireReceiptsSession.mockResolvedValue(SESSION);
    requireAction.mockRejectedValue(new ReceiptsAuthError(403));
    expect(await getSpending(null, null)).toMatchObject({ ok: true, value: { canWrite: false } });
  });

  it('answers unauthorized without a session', async () => {
    requireReceiptsSession.mockRejectedValue(new ReceiptsAuthError(401));
    expect(await getSpending(null, null)).toEqual({ ok: false, error: 'unauthorized' });
    expect(loadSpending).not.toHaveBeenCalled();
  });
});

describe('writes', () => {
  it('refuse without the write permission and change nothing', async () => {
    requireAction.mockRejectedValue(new ReceiptsAuthError(403));
    expect(await answerCategory(2026, null, 'Zyx', 'cash')).toEqual({ ok: false, error: 'forbidden' });
    expect(await withdrawCategory(2026, null, 'zyx')).toEqual({ ok: false, error: 'forbidden' });
    expect(await markOwnAccount(2026, null, 'Zyx')).toEqual({ ok: false, error: 'forbidden' });
    expect(await unmarkOwnAccount(2026, null, 'zyx')).toEqual({ ok: false, error: 'forbidden' });
    expect(setCounterpartyCategory).not.toHaveBeenCalled();
    expect(removeCounterpartyCategory).not.toHaveBeenCalled();
    expect(markCounterpartyOwnAccount).not.toHaveBeenCalled();
    expect(unmarkCounterpartyOwnAccount).not.toHaveBeenCalled();
  });

  it('write into the session\'s active workspace with its company, never one from the browser', async () => {
    requireAction.mockResolvedValue(SESSION);
    await answerCategory(2026, 4, 'Zyx', 'cash');
    const ctx = expect.objectContaining({ workspaceId: 'ws-a', tenantId: 't-a' });
    expect(setCounterpartyCategory).toHaveBeenCalledWith({ marker: 'prisma' }, ctx, { counterparty: 'Zyx', category: 'cash' });
    await withdrawCategory(2026, 4, 'zyx');
    expect(removeCounterpartyCategory).toHaveBeenCalledWith({ marker: 'prisma' }, ctx, 'zyx');
    await markOwnAccount(2026, 4, 'Zyx');
    expect(markCounterpartyOwnAccount).toHaveBeenCalledWith({ marker: 'prisma' }, ctx, 'Zyx');
    await unmarkOwnAccount(2026, 4, 'zyx');
    expect(unmarkCounterpartyOwnAccount).toHaveBeenCalledWith({ marker: 'prisma' }, ctx, 'zyx');
    await unlinkRoutedReceipt(2026, 4, 'pay-1');
    expect(unlinkRoutedPayment).toHaveBeenCalledWith({ marker: 'prisma' }, ctx, 'pay-1');
  });

  it('return the fresh view after a write', async () => {
    requireAction.mockResolvedValue(SESSION);
    expect(await answerCategory(2026, 4, 'Zyx', 'cash')).toEqual({ ok: true, value: { ...VIEW, canWrite: true, companies: {} } });
    expect(loadSpending).toHaveBeenLastCalledWith({ marker: 'prisma' }, 'ws-a', 2026, 4);
  });

  it('pass a refused input on as invalid_input with its code', async () => {
    requireAction.mockResolvedValue(SESSION);
    setCounterpartyCategory.mockRejectedValue(new SpendingServiceError('invalid_category'));
    expect(await answerCategory(2026, null, 'Zyx', 'yachts')).toEqual({ ok: false, error: 'invalid_input', detail: 'invalid_category' });
  });

  it('refuse to overwrite a business or private answer with "own account"', async () => {
    requireAction.mockResolvedValue(SESSION);
    markCounterpartyOwnAccount.mockRejectedValue(new SpendingServiceError('treatment_exists'));
    expect(await markOwnAccount(2026, null, 'Zyx')).toEqual({ ok: false, error: 'invalid_input', detail: 'treatment_exists' });
  });

  it('names the other companies of shared accounts by the person\'s own memberships, and no company the person is not in', async () => {
    const other = { id: 'ws-b', slug: 'marlinjai', role: 'member', tenantId: 't-b', tenantName: 'marlinjai' };
    requireReceiptsSession.mockResolvedValue({ ...SESSION, memberships: [WS, other] });
    requireAction.mockResolvedValue(SESSION);
    loadSpending.mockResolvedValue({ ...VIEW, accounts: [{ id: 'acc', label: 'N26', completeThrough: null, sharedFrom: null }], sharedOut: [{ accountLabel: 'N26', receiverWorkspaceId: 'ws-b' }, { accountLabel: 'Alt', receiverWorkspaceId: 'ws-unknown' }] });
    const result = await getSpending(2026, null);
    expect(result).toMatchObject({ ok: true, value: { companies: { 'ws-b': 'marlinjai' } } });
    expect(result.ok && 'ws-unknown' in result.value.companies).toBe(false);
  });

  it('unlinking a routed receipt refuses without the write permission, a missing id, and a payment not routed here', async () => {
    requireAction.mockRejectedValue(new ReceiptsAuthError(403));
    expect(await unlinkRoutedReceipt(2026, null, 'pay-1')).toEqual({ ok: false, error: 'forbidden' });
    requireAction.mockResolvedValue(SESSION);
    expect(await unlinkRoutedReceipt(2026, null, '')).toEqual({ ok: false, error: 'invalid_input', detail: 'payment_not_found' });
    expect(unlinkRoutedPayment).not.toHaveBeenCalled();
    unlinkRoutedPayment.mockRejectedValue(new PaymentServiceError('payment_not_found'));
    expect(await unlinkRoutedReceipt(2026, null, 'pay-2')).toEqual({ ok: false, error: 'invalid_input', detail: 'payment_not_found' });
  });

  it('report anything unexpected as failed', async () => {
    requireAction.mockResolvedValue(SESSION);
    setCounterpartyCategory.mockRejectedValue(new Error('database gone'));
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await answerCategory(2026, null, 'Zyx', 'cash')).toEqual({ ok: false, error: 'failed' });
    spy.mockRestore();
  });
});
