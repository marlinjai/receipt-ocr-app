import 'server-only';
import type { PrismaClient } from '@prisma/client';
import { counterpartyKey, loadPayments } from '@/lib/tax/payments/service';
import { formatCents } from '@/lib/tax/money';
import { SPENDING_CATEGORIES, SPENDING_CATEGORY_LABELS, isSpendingCategory } from './categories';
import { MAX_LIMIT_CENTS, budgetSubject, computeBudgets, type BudgetLine, type BudgetScope, type StoredLimit } from './budgets';
import { classifyPayment } from './overview';
import { loadCategoryAnswers, toOverviewInput } from './service';
import { notify, serverChannels, settleAllBut, type NotifyContext } from './notify/service';
import type { NotificationChannel } from './notify/port';

/**
 * Budgets against the database: the limits the owner set, the lines of the
 * current month, saving a limit, and the warnings. Every function takes the
 * workspace explicitly.
 */

export type BudgetServiceErrorCode = 'invalid_scope' | 'invalid_key' | 'invalid_limit';

export class BudgetServiceError extends Error {
  readonly code: BudgetServiceErrorCode;
  constructor(code: BudgetServiceErrorCode) {
    super(code);
    this.name = 'BudgetServiceError';
    this.code = code;
  }
}

/** The longest counterparty name accepted for a budget. */
export const MAX_LABEL_LENGTH = 200;
/** Budget warnings sent in one run at most; the rest follow on the next run. */
export const MAX_WARNINGS_PER_RUN = 5;

export async function loadStoredLimits(db: PrismaClient, workspaceId: string): Promise<StoredLimit[]> {
  const rows = await db.spendingBudget.findMany({ where: { authWorkspaceId: workspaceId }, orderBy: { label: 'asc' } });
  return rows.flatMap((r) => (r.scope === 'category' || r.scope === 'vendor' ? [{ scope: r.scope as BudgetScope, key: r.key, label: r.label, limitCents: r.limitCents }] : []));
}

/** The budgets of the month `today` falls in, and (when asked) the counterparties to pick from, from one read of the payments. */
export async function loadBudgetsView(db: PrismaClient, workspaceId: string, today: string, withCounterparties = false): Promise<{ lines: BudgetLine[]; counterparties: string[] }> {
  const [loaded, answers, limits] = await Promise.all([loadPayments(db, workspaceId), loadCategoryAnswers(db, workspaceId), loadStoredLimits(db, workspaceId)]);
  const ctx = { treatments: loaded.treatments, answers: new Map(answers.map((a) => [a.counterpartyKey, a.category])) };
  const payments = loaded.payments.map((p) => classifyPayment(toOverviewInput(p), ctx));
  const lines = computeBudgets({ payments, limits, categories: SPENDING_CATEGORIES.filter((c) => c !== 'transfers'), categoryLabels: SPENDING_CATEGORY_LABELS, today });
  return { lines, counterparties: withCounterparties ? counterpartiesOf(payments) : [] };
}

/** The budgets of the month `today` falls in. */
export async function loadBudgets(db: PrismaClient, workspaceId: string, today: string): Promise<BudgetLine[]> {
  return (await loadBudgetsView(db, workspaceId, today)).lines;
}

/**
 * The names of the counterparties spending goes to, for picking one for a
 * budget: the most used first when there are very many, then alphabetical.
 * Own transfers and money coming in are left out.
 */
function counterpartiesOf(payments: ReturnType<typeof classifyPayment>[]): string[] {
  const byKey = new Map<string, { name: string; count: number }>();
  for (const p of payments) {
    if (!p.counterpartyKey || p.spendingCents === null || p.spendingCents <= 0) continue;
    const entry = byKey.get(p.counterpartyKey) ?? { name: p.counterparty, count: 0 };
    entry.count += 1;
    byKey.set(p.counterpartyKey, entry);
  }
  return [...byKey.values()]
    .sort((a, b) => b.count - a.count)
    .slice(0, 500)
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b, 'de'));
}

/**
 * Set a monthly limit: `limitCents` a positive number of cents, null to switch
 * the budget off, or `reset: true` to drop the owner's own number (a category
 * then follows its twelve-month average again; a counterparty budget is gone).
 * A counterparty budget is keyed by the counterparty's name as the payments show it.
 */
export async function saveBudget(db: PrismaClient, ctx: NotifyContext, raw: unknown): Promise<void> {
  const input = (raw ?? {}) as { scope?: unknown; key?: unknown; label?: unknown; limitCents?: unknown; reset?: unknown };
  if (input.scope !== 'category' && input.scope !== 'vendor') throw new BudgetServiceError('invalid_scope');
  let key: string;
  let label: string;
  if (input.scope === 'category') {
    if (!isSpendingCategory(input.key) || input.key === 'transfers') throw new BudgetServiceError('invalid_key');
    key = input.key;
    label = SPENDING_CATEGORY_LABELS[input.key];
  } else {
    label = typeof input.label === 'string' ? input.label.trim() : '';
    // A key from the browser must be one the app itself would make; otherwise it is made from the name.
    if (typeof input.key === 'string' && input.key && input.key !== counterpartyKey(input.key)) throw new BudgetServiceError('invalid_key');
    key = typeof input.key === 'string' && input.key ? input.key : counterpartyKey(label);
    if (!key || !label || label.length > MAX_LABEL_LENGTH) throw new BudgetServiceError('invalid_key');
  }
  if (input.reset === true) {
    await db.spendingBudget.deleteMany({ where: { authWorkspaceId: ctx.workspaceId, scope: input.scope, key } });
    return;
  }
  const limit = input.limitCents;
  if (limit !== null && (typeof limit !== 'number' || !Number.isInteger(limit) || limit <= 0 || limit > MAX_LIMIT_CENTS)) throw new BudgetServiceError('invalid_limit');
  await db.spendingBudget.upsert({
    where: { authWorkspaceId_scope_key: { authWorkspaceId: ctx.workspaceId, scope: input.scope, key } },
    create: { authWorkspaceId: ctx.workspaceId, authTenantId: ctx.tenantId, scope: input.scope, key, label, limitCents: limit as number | null },
    update: { label, limitCents: limit as number | null },
  });
}

const MONTH_NAMES = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];

function warning(line: BudgetLine, month: string): { subjectKey: string; title: string; body: string; level: 'passed' | 'on_pace'; overshootCents: number } | null {
  if (line.level === 'ok' || line.limitCents === null) return null;
  const limit = `${formatCents(line.limitCents)} €`;
  const spent = `${formatCents(line.spentCents)} €`;
  const when = `${MONTH_NAMES[Number(month.slice(5, 7)) - 1]} ${month.slice(0, 4)}`;
  return line.level === 'passed'
    ? {
        level: 'passed' as const,
        overshootCents: line.spentCents - line.limitCents,
        subjectKey: budgetSubject(line, month, 'passed'),
        title: `Budget überschritten: ${line.label}`,
        body: `${line.label}, ${when}: ${spent} ausgegeben, das Budget ist ${limit}.`,
      }
    : {
        level: 'on_pace' as const,
        overshootCents: line.projectedCents - line.limitCents,
        subjectKey: budgetSubject(line, month, 'on_pace'),
        title: `Budget wird überschritten: ${line.label}`,
        body: `${line.label}, ${when}: ${spent} ausgegeben. Bei gleichem Tempo werden es etwa ${formatCents(line.projectedCents)} € bei einem Budget von ${limit}.`,
      };
}

export interface WarningRun {
  sent: number;
  /** Warnings left for the next run because this run reached its limit. */
  deferred: number;
  /** Warnings taken out of the in-app list because their budget is no longer passed or on pace (a raised limit, a new month). */
  settled: number;
}

/**
 * Warn about every budget of this month that is passed or certain to be
 * passed at this pace, through the notification port: each at most once per
 * month, level and limit, at most five per run. Warnings that no longer hold
 * leave the in-app list.
 */
export async function runBudgetWarnings(db: PrismaClient, ctx: NotifyContext, options: { today: string; channels?: readonly NotificationChannel[] }): Promise<WarningRun> {
  const lines = await loadBudgets(db, ctx.workspaceId, options.today);
  const month = options.today.slice(0, 7);
  const due = lines.flatMap((line) => {
    const w = warning(line, month);
    return w ? [w] : [];
  });
  const settled = await settleAllBut(db, ctx.workspaceId, 'budget', new Set(due.map((w) => w.subjectKey)));
  const known = new Set(
    (
      await db.spendingNotification.findMany({ where: { authWorkspaceId: ctx.workspaceId, kind: 'budget', subjectKey: { in: due.map((w) => w.subjectKey) } }, select: { subjectKey: true } })
    ).map((n) => n.subjectKey),
  );
  // Passed before on pace, the largest overshoot first: when the cap holds some back, the most urgent go out.
  const fresh = due.filter((w) => !known.has(w.subjectKey)).sort((a, b) => (a.level === b.level ? b.overshootCents - a.overshootCents : a.level === 'passed' ? -1 : 1));
  let sent = 0;
  for (const w of fresh.slice(0, MAX_WARNINGS_PER_RUN)) {
    const message = { subjectKey: w.subjectKey, title: w.title, body: w.body, kind: 'budget' as const, path: '/app/spending#budgets' };
    if ((await notify(db, ctx, message, options.channels ?? serverChannels())) === 'sent') sent += 1;
  }
  return { sent, deferred: Math.max(0, fresh.length - MAX_WARNINGS_PER_RUN), settled };
}
