import 'server-only';
import type { PrismaClient } from '@prisma/client';
import { runBudgetWarnings, type WarningRun } from './budget-service';
import { runReceiptLoop, type RunResult } from './loop-service';
import type { NotifyContext } from './notify/service';
import type { NotificationChannel } from './notify/port';

export interface ChecksRun {
  /** The missing-receipt loop's result, or null when it failed. */
  loop: RunResult | null;
  /** The budget warnings' result, or null when they failed. */
  budgets: WarningRun | null;
}

/**
 * Everything the spending side checks after new payments arrive: the
 * missing-receipt loop and the budget warnings, each on its own, so one
 * failing never stops the other. A failure is logged and reported as null,
 * so the page can say which part could not be checked. One entry point for
 * the payment import, the live bank feed and the "check now" button.
 */
export async function runSpendingChecks(
  db: PrismaClient,
  ctx: NotifyContext,
  options: { today: string; channels?: readonly NotificationChannel[]; now?: Date },
): Promise<ChecksRun> {
  let loop: RunResult | null = null;
  let budgets: WarningRun | null = null;
  try {
    loop = await runReceiptLoop(db, ctx, options);
  } catch (e) {
    console.error('[spending] missing-receipt loop failed', e);
  }
  try {
    budgets = await runBudgetWarnings(db, ctx, options);
  } catch (e) {
    console.error('[spending] budget warnings failed', e);
  }
  return { loop, budgets };
}
