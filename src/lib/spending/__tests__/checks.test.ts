import { beforeEach, describe, expect, it, vi } from 'vitest';

const runReceiptLoop = vi.fn();
const runBudgetWarnings = vi.fn();
vi.mock('../loop-service', () => ({ runReceiptLoop: (...a: unknown[]) => runReceiptLoop(...a) }));
vi.mock('../budget-service', () => ({ runBudgetWarnings: (...a: unknown[]) => runBudgetWarnings(...a) }));

import { runSpendingChecks } from '../checks';

const db = {} as never;
const ctx = { workspaceId: 'ws', tenantId: 't' };
const LOOP = { notified: 1, deferred: 0, settled: 0, retried: 0, open: 1 };
const BUDGETS = { sent: 1, deferred: 0, settled: 0 };

beforeEach(() => {
  runReceiptLoop.mockReset().mockResolvedValue(LOOP);
  runBudgetWarnings.mockReset().mockResolvedValue(BUDGETS);
});

describe('runSpendingChecks', () => {
  it('runs both checks and returns both results', async () => {
    expect(await runSpendingChecks(db, ctx, { today: '2026-03-05' })).toEqual({ loop: LOOP, budgets: BUDGETS });
  });

  it('still warns about budgets when the loop fails, and says the loop failed', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    runReceiptLoop.mockRejectedValue(new Error('database gone'));
    expect(await runSpendingChecks(db, ctx, { today: '2026-03-05' })).toEqual({ loop: null, budgets: BUDGETS });
    expect(runBudgetWarnings).toHaveBeenCalled();
    spy.mockRestore();
  });

  it('keeps the loop result when the budgets fail, and says the budgets failed', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    runBudgetWarnings.mockRejectedValue(new Error('boom'));
    expect(await runSpendingChecks(db, ctx, { today: '2026-03-05' })).toEqual({ loop: LOOP, budgets: null });
    spy.mockRestore();
  });
});
