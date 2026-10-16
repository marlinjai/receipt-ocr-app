import { beforeEach, describe, expect, it, vi } from 'vitest';

/** The budget server actions: the write permission, the workspace from the session, the error codes. */

const requireAction = vi.fn();
const requireReceiptsSession = vi.fn();
const loadBudgetsView = vi.fn();
const saveBudget = vi.fn();

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
vi.mock('@/lib/spending/budget-service', () => {
  class BudgetServiceError extends Error {
    constructor(readonly code: string) {
      super(code);
    }
  }
  return { BudgetServiceError, loadBudgetsView: (...a: unknown[]) => loadBudgetsView(...a), saveBudget: (...a: unknown[]) => saveBudget(...a) };
});

import { ReceiptsAuthError } from '@/lib/auth-guards';
import { BudgetServiceError } from '@/lib/spending/budget-service';
import { getBudgets, setBudget } from './budget-actions';

const WS = { id: 'ws-a', slug: 'beispiel', role: 'member', tenantId: 't-a' };
const SESSION = { memberships: [WS], activeWorkspace: WS };

beforeEach(() => {
  for (const f of [requireAction, requireReceiptsSession, loadBudgetsView, saveBudget]) f.mockReset();
  loadBudgetsView.mockResolvedValue({ lines: [], counterparties: [] });
});

describe('budget actions', () => {
  it('read the active workspace for this month and say whether it may write', async () => {
    requireReceiptsSession.mockResolvedValue(SESSION);
    requireAction.mockRejectedValue(new ReceiptsAuthError(403));
    const result = await getBudgets();
    expect(result).toMatchObject({ ok: true, value: { lines: [], counterparties: [], canWrite: false } });
    expect(loadBudgetsView.mock.calls[0][1]).toBe('ws-a');
    expect(loadBudgetsView.mock.calls[0][2]).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // A reader gets no list of counterparties to pick from.
    expect(loadBudgetsView.mock.calls[0][3]).toBe(false);
  });

  it('treat only a refusal as read-only and report any other failure of the check', async () => {
    requireReceiptsSession.mockResolvedValue(SESSION);
    requireAction.mockRejectedValue(new Error('authorization service unreachable'));
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await getBudgets()).toEqual({ ok: false, error: 'failed' });
    spy.mockRestore();
  });

  it('answer unauthorized without a session', async () => {
    requireReceiptsSession.mockRejectedValue(new ReceiptsAuthError(401));
    expect(await getBudgets()).toEqual({ ok: false, error: 'unauthorized' });
  });

  it('refuse a write without the permission and change nothing', async () => {
    requireAction.mockRejectedValue(new ReceiptsAuthError(403));
    expect(await setBudget({ scope: 'category', key: 'cash', limitCents: 100 })).toEqual({ ok: false, error: 'forbidden' });
    expect(saveBudget).not.toHaveBeenCalled();
  });

  it('write into the session\'s workspace and company, and pass refusals on with their code', async () => {
    requireAction.mockResolvedValue(SESSION);
    await setBudget({ scope: 'category', key: 'cash', limitCents: 100 });
    expect(saveBudget).toHaveBeenCalledWith({ marker: 'prisma' }, { workspaceId: 'ws-a', tenantId: 't-a' }, { scope: 'category', key: 'cash', limitCents: 100 });
    saveBudget.mockRejectedValue(new BudgetServiceError('invalid_limit'));
    expect(await setBudget({ scope: 'category', key: 'cash', limitCents: -1 })).toEqual({ ok: false, error: 'invalid_input', detail: 'invalid_limit' });
  });
});
