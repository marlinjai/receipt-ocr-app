import 'server-only';
import type { PrismaClient } from '@prisma/client';
import { runBudgetWarnings, type WarningRun } from './budget-service';
import { runReceiptLoop, type RunResult } from './loop-service';
import type { NotifyContext } from './notify/service';
import type { NotificationChannel } from './notify/port';
import type { MailboxPort } from './mailbox/port';
import { receiversOf } from '@/lib/tax/payments/routing';

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
  options: { today: string; channels?: readonly NotificationChannel[]; now?: Date; mailbox?: MailboxPort },
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

/**
 * The spending checks after new payments arrived in the company `ctx` (a file
 * import, "Jetzt abholen", the daily bank run): for that company, and for
 * every company that receives the private payments of one of its accounts
 * (plan docs/plans/2026-10-22-payments-across-companies.md), because a new
 * payment answered private is asked about there. One after the other, each on
 * its own: a failure in one never stops the next. Returns the checks of `ctx`
 * (null when `done` says it was checked already in this pass).
 */
export async function runSpendingChecksAfterNewPayments(
  db: PrismaClient,
  ctx: NotifyContext,
  options: { today: string; channels?: readonly NotificationChannel[]; now?: Date; mailbox?: MailboxPort },
  /** Companies already checked in this pass (the daily run checks many): each one is checked once. */
  done: Set<string> = new Set(),
): Promise<ChecksRun | null> {
  let own: ChecksRun | null = null;
  if (!done.has(ctx.workspaceId)) {
    done.add(ctx.workspaceId);
    own = await runSpendingChecks(db, ctx, options);
  }
  let receivers: NotifyContext[] = [];
  try {
    receivers = await receiversOf(db, [ctx.workspaceId]);
  } catch (e) {
    console.error('[spending] the companies receiving private payments could not be read', (e as Error)?.name ?? 'error');
  }
  // A mailbox given is the caller's company's; a receiver looks its own up.
  const rest = { today: options.today, channels: options.channels, now: options.now };
  for (const receiver of receivers) {
    if (done.has(receiver.workspaceId)) continue;
    done.add(receiver.workspaceId);
    await runSpendingChecks(db, receiver, rest);
  }
  return own;
}
