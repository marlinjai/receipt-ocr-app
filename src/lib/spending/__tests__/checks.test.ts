import { beforeEach, describe, expect, it, vi } from 'vitest';

const runReceiptLoop = vi.fn();
const runBudgetWarnings = vi.fn();
const classifyCounterparties = vi.fn();
vi.mock('../loop-service', () => ({ runReceiptLoop: (...a: unknown[]) => runReceiptLoop(...a) }));
vi.mock('../budget-service', () => ({ runBudgetWarnings: (...a: unknown[]) => runBudgetWarnings(...a) }));
vi.mock('@/lib/tax/payments/classify-service', () => ({ classifyCounterparties: (...a: unknown[]) => classifyCounterparties(...a) }));
vi.mock('@/lib/tax/payments/counterparty-classifier', () => ({ serverCounterpartyClassifier: () => null }));

import { runSpendingChecks } from '../checks';

const db = {} as never;
const ctx = { workspaceId: 'ws', tenantId: 't' };
const LOOP = { notified: 1, deferred: 0, settled: 0, settledOwnName: 0, retried: 0, open: 1 };
const BUDGETS = { sent: 1, deferred: 0, settled: 0 };
const CLASSIFY = { pending: 2, byEvidence: 1, byModel: 1, applied: 2, unavailable: false, failedBatches: 0, unanswered: 0, removed: 0, stoppedEarly: false };

beforeEach(() => {
  runReceiptLoop.mockReset().mockResolvedValue(LOOP);
  runBudgetWarnings.mockReset().mockResolvedValue(BUDGETS);
  classifyCounterparties.mockReset().mockResolvedValue(CLASSIFY);
});

describe('runSpendingChecks', () => {
  it('runs all three checks, the counterparties first, and returns every result', async () => {
    const order: string[] = [];
    classifyCounterparties.mockImplementation(async () => (order.push('classify'), CLASSIFY));
    runReceiptLoop.mockImplementation(async () => (order.push('loop'), LOOP));
    expect(await runSpendingChecks(db, ctx, { today: '2026-03-05' })).toEqual({ classify: CLASSIFY, loop: LOOP, budgets: BUDGETS });
    expect(order).toEqual(['classify', 'loop']);
  });

  it('a failed classification stops neither the loop nor the budgets, and says it failed', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    classifyCounterparties.mockRejectedValue(new Error('model gone'));
    expect(await runSpendingChecks(db, ctx, { today: '2026-03-05' })).toEqual({ classify: null, loop: LOOP, budgets: BUDGETS });
    spy.mockRestore();
  });

  it('a classifier given by the caller is used, also none at all', async () => {
    const port = { model: 'fake', classify: vi.fn() };
    await runSpendingChecks(db, ctx, { today: '2026-03-05', classifier: port });
    expect(classifyCounterparties).toHaveBeenLastCalledWith(db, ctx, port, { limit: undefined });
    await runSpendingChecks(db, ctx, { today: '2026-03-05', classifier: null, classifyLimit: 20 });
    expect(classifyCounterparties).toHaveBeenLastCalledWith(db, ctx, null, { limit: 20 });
  });

  it('still warns about budgets when the loop fails, and says the loop failed', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    runReceiptLoop.mockRejectedValue(new Error('database gone'));
    expect(await runSpendingChecks(db, ctx, { today: '2026-03-05' })).toEqual({ classify: CLASSIFY, loop: null, budgets: BUDGETS });
    expect(runBudgetWarnings).toHaveBeenCalled();
    spy.mockRestore();
  });

  it('keeps the loop result when the budgets fail, and says the budgets failed', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    runBudgetWarnings.mockRejectedValue(new Error('boom'));
    expect(await runSpendingChecks(db, ctx, { today: '2026-03-05' })).toEqual({ classify: CLASSIFY, loop: LOOP, budgets: null });
    spy.mockRestore();
  });
});
