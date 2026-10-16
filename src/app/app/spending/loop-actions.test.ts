import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The loop's server actions: the write permission, the workspace always taken
 * from the session, and the error codes. Auth and database are replaced; the
 * services are spies (their behaviour against a real database is in
 * `loop.dbtest.ts`).
 */

const requireAction = vi.fn();
const requireReceiptsSession = vi.fn();
const loadLoopOverview = vi.fn();
const runReceiptLoop = vi.fn();
const confirmCandidate = vi.fn();
const answerNoReceipt = vi.fn();
const withdrawNoReceipt = vi.fn();
const listUnreadNotifications = vi.fn();
const getNotifySettings = vi.fn();
const saveNotifySettings = vi.fn();
const markNotificationRead = vi.fn();

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
vi.mock('@/lib/spending/loop-service', () => {
  class LoopServiceError extends Error {
    constructor(readonly code: string) {
      super(code);
    }
  }
  return {
    LoopServiceError,
    loadLoopOverview: (...a: unknown[]) => loadLoopOverview(...a),
    runReceiptLoop: (...a: unknown[]) => runReceiptLoop(...a),
    confirmCandidate: (...a: unknown[]) => confirmCandidate(...a),
    answerNoReceipt: (...a: unknown[]) => answerNoReceipt(...a),
    withdrawNoReceipt: (...a: unknown[]) => withdrawNoReceipt(...a),
  };
});
vi.mock('@/lib/spending/notify/service', () => {
  class NotifyServiceError extends Error {
    constructor(readonly code: string) {
      super(code);
    }
  }
  return {
    NotifyServiceError,
    listUnreadNotifications: (...a: unknown[]) => listUnreadNotifications(...a),
    getNotifySettings: (...a: unknown[]) => getNotifySettings(...a),
    saveNotifySettings: (...a: unknown[]) => saveNotifySettings(...a),
    markNotificationRead: (...a: unknown[]) => markNotificationRead(...a),
  };
});
vi.mock('@/lib/tax/payments/service', () => {
  class PaymentServiceError extends Error {
    constructor(
      readonly code: string,
      readonly detail: string | null = null,
    ) {
      super(code);
    }
  }
  return { PaymentServiceError };
});

import { ReceiptsAuthError } from '@/lib/auth-guards';
import { LoopServiceError } from '@/lib/spending/loop-service';
import { PaymentServiceError } from '@/lib/tax/payments/service';
import { checkNow, confirmReceipt, getReceiptChecks, readNotification, saveNotificationSettings, sayNoReceipt, takeBackNoReceipt } from './loop-actions';

const WS = { id: 'ws-a', slug: 'beispiel', role: 'member', tenantId: 't-a' };
const SESSION = { memberships: [WS], activeWorkspace: WS };
const CTX = { workspaceId: 'ws-a', tenantId: 't-a' };

beforeEach(() => {
  for (const f of [requireAction, requireReceiptsSession, loadLoopOverview, runReceiptLoop, confirmCandidate, answerNoReceipt, withdrawNoReceipt, listUnreadNotifications, getNotifySettings, saveNotifySettings, markNotificationRead]) f.mockReset();
  loadLoopOverview.mockResolvedValue({ open: [], answered: [], counts: {} });
  listUnreadNotifications.mockResolvedValue([]);
  getNotifySettings.mockResolvedValue({ channel: 'push', notifyEmail: null });
});

describe('reading', () => {
  it('reads the active workspace and says whether it may write', async () => {
    requireReceiptsSession.mockResolvedValue(SESSION);
    requireAction.mockRejectedValue(new ReceiptsAuthError(403));
    expect(await getReceiptChecks()).toMatchObject({ ok: true, value: { canWrite: false, lastRun: null } });
    expect(loadLoopOverview).toHaveBeenCalledWith({ marker: 'prisma' }, 'ws-a');
  });

  it('shows the notification queue only to people who may write', async () => {
    requireReceiptsSession.mockResolvedValue(SESSION);
    requireAction.mockRejectedValue(new ReceiptsAuthError(403));
    expect(await getReceiptChecks()).toMatchObject({ ok: true, value: { notifications: [] } });
    expect(listUnreadNotifications).not.toHaveBeenCalled();
    requireAction.mockResolvedValue(SESSION);
    listUnreadNotifications.mockResolvedValue([{ id: 'n1' }]);
    expect(await getReceiptChecks()).toMatchObject({ ok: true, value: { notifications: [{ id: 'n1' }], canWrite: true } });
  });

  it('answers unauthorized without a session', async () => {
    requireReceiptsSession.mockRejectedValue(new ReceiptsAuthError(401));
    expect(await getReceiptChecks()).toEqual({ ok: false, error: 'unauthorized' });
  });
});

describe('writes', () => {
  it('refuse without the write permission and change nothing', async () => {
    requireAction.mockRejectedValue(new ReceiptsAuthError(403));
    for (const result of [await checkNow(), await confirmReceipt('p', 'r'), await sayNoReceipt('p', 'x'), await takeBackNoReceipt('p'), await readNotification('n'), await saveNotificationSettings({})]) {
      expect(result).toEqual({ ok: false, error: 'forbidden' });
    }
    for (const f of [runReceiptLoop, confirmCandidate, answerNoReceipt, withdrawNoReceipt, markNotificationRead, saveNotifySettings]) expect(f).not.toHaveBeenCalled();
  });

  it('act in the session\'s workspace and company, and report what the run did', async () => {
    requireAction.mockResolvedValue(SESSION);
    runReceiptLoop.mockResolvedValue({ notified: 1, settled: 0, retried: 0, open: 2 });
    expect(await checkNow()).toMatchObject({ ok: true, value: { canWrite: true, lastRun: { notified: 1, open: 2 } } });
    expect(runReceiptLoop.mock.calls[0][1]).toEqual(CTX);
    expect(runReceiptLoop.mock.calls[0][2].today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    await confirmReceipt('p1', 'r1');
    expect(confirmCandidate).toHaveBeenCalledWith({ marker: 'prisma' }, CTX, 'p1', 'r1');
    await sayNoReceipt('p1', 'Automat');
    expect(answerNoReceipt).toHaveBeenCalledWith({ marker: 'prisma' }, CTX, 'p1', 'Automat');
    await takeBackNoReceipt('p1');
    expect(withdrawNoReceipt).toHaveBeenCalledWith({ marker: 'prisma' }, CTX, 'p1');
    await readNotification('n1');
    expect(markNotificationRead).toHaveBeenCalledWith({ marker: 'prisma' }, CTX, 'n1');
    await saveNotificationSettings({ channel: 'email' });
    expect(saveNotifySettings).toHaveBeenCalledWith({ marker: 'prisma' }, CTX, { channel: 'email' });
  });

  it('pass refusals on with their code', async () => {
    requireAction.mockResolvedValue(SESSION);
    confirmCandidate.mockRejectedValueOnce(new LoopServiceError('not_a_candidate'));
    expect(await confirmReceipt('p1', 'r1')).toEqual({ ok: false, error: 'invalid_input', detail: 'not_a_candidate' });
    confirmCandidate.mockRejectedValueOnce(new PaymentServiceError('receipt_already_paid', '100:90'));
    expect(await confirmReceipt('p1', 'r1')).toEqual({ ok: false, error: 'invalid_input', detail: 'receipt_already_paid:100:90' });
    answerNoReceipt.mockRejectedValueOnce(new LoopServiceError('payment_not_found'));
    expect(await sayNoReceipt('p9', 'x')).toEqual({ ok: false, error: 'not_found', detail: 'payment_not_found' });
  });
});
