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
const setCounterpartyTreatment = vi.fn();

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
  };
});
vi.mock('@/lib/tax/payments/service', () => {
  class PaymentServiceError extends Error {
    constructor(readonly code: string) {
      super(code);
    }
  }
  return { PaymentServiceError, setCounterpartyTreatment: (...a: unknown[]) => setCounterpartyTreatment(...a) };
});

import { ReceiptsAuthError } from '@/lib/auth-guards';
import { SpendingServiceError } from '@/lib/spending/service';
import { answerCategory, getSpending, markOwnAccount, withdrawCategory } from './actions';

const WS = { id: 'ws-a', slug: 'beispiel', role: 'member', tenantId: 't-a' };
const SESSION = { memberships: [WS], activeWorkspace: WS };
const VIEW = { overview: { year: 2026 } };

beforeEach(() => {
  for (const f of [requireAction, requireReceiptsSession, loadSpending, setCounterpartyCategory, removeCounterpartyCategory, setCounterpartyTreatment]) f.mockReset();
  loadSpending.mockResolvedValue(VIEW);
});

describe('getSpending', () => {
  it('reads the active workspace of the session and says whether it may write', async () => {
    requireReceiptsSession.mockResolvedValue(SESSION);
    requireAction.mockResolvedValue(SESSION);
    expect(await getSpending('2025', '3')).toEqual({ ok: true, value: { ...VIEW, canWrite: true } });
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
    expect(setCounterpartyCategory).not.toHaveBeenCalled();
    expect(removeCounterpartyCategory).not.toHaveBeenCalled();
    expect(setCounterpartyTreatment).not.toHaveBeenCalled();
  });

  it('write into the session\'s active workspace with its company, never one from the browser', async () => {
    requireAction.mockResolvedValue(SESSION);
    await answerCategory(2026, 4, 'Zyx', 'cash');
    expect(setCounterpartyCategory).toHaveBeenCalledWith({ marker: 'prisma' }, { workspaceId: 'ws-a', tenantId: 't-a' }, { counterparty: 'Zyx', category: 'cash' });
    await withdrawCategory(2026, 4, 'zyx');
    expect(removeCounterpartyCategory).toHaveBeenCalledWith({ marker: 'prisma' }, { workspaceId: 'ws-a', tenantId: 't-a' }, 'zyx');
    await markOwnAccount(2026, 4, 'Zyx');
    expect(setCounterpartyTreatment).toHaveBeenCalledWith({ marker: 'prisma' }, { workspaceId: 'ws-a', tenantId: 't-a' }, { counterparty: 'Zyx', treatment: 'own_account' });
  });

  it('return the fresh view after a write', async () => {
    requireAction.mockResolvedValue(SESSION);
    expect(await answerCategory(2026, 4, 'Zyx', 'cash')).toEqual({ ok: true, value: { ...VIEW, canWrite: true } });
    expect(loadSpending).toHaveBeenLastCalledWith({ marker: 'prisma' }, 'ws-a', 2026, 4);
  });

  it('pass a refused input on as invalid_input with its code', async () => {
    requireAction.mockResolvedValue(SESSION);
    setCounterpartyCategory.mockRejectedValue(new SpendingServiceError('invalid_category'));
    expect(await answerCategory(2026, null, 'Zyx', 'yachts')).toEqual({ ok: false, error: 'invalid_input', detail: 'invalid_category' });
  });

  it('report anything unexpected as failed', async () => {
    requireAction.mockResolvedValue(SESSION);
    setCounterpartyCategory.mockRejectedValue(new Error('database gone'));
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await answerCategory(2026, null, 'Zyx', 'cash')).toEqual({ ok: false, error: 'failed' });
    spy.mockRestore();
  });
});
