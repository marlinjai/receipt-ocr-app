import 'server-only';
import type { PrismaClient } from '@prisma/client';
import { counterpartyKey, loadPayments } from '@/lib/tax/payments/service';
import { isSpendingCategory, type SpendingCategory } from './categories';
import { berlinYear } from './period';
import { buildOverview, paymentYears, type SpendingOverview } from './overview';

/**
 * Server-side reads and writes for the spending overview. Every function takes
 * the workspace explicitly and touches rows only inside it: the overview of one
 * company never sees another company's payments or answers. Payments are read
 * through the payments service's own read (`loadPayments`), never queried here.
 */

export interface SpendingContext {
  workspaceId: string;
  tenantId: string | null;
}

export type SpendingServiceErrorCode = 'counterparty_required' | 'invalid_category';

export class SpendingServiceError extends Error {
  readonly code: SpendingServiceErrorCode;
  constructor(code: SpendingServiceErrorCode) {
    super(code);
    this.name = 'SpendingServiceError';
    this.code = code;
  }
}

export interface CategoryAnswerView {
  counterpartyKey: string;
  label: string;
  category: SpendingCategory;
}

export interface SpendingView {
  overview: SpendingOverview;
  years: number[];
  accounts: Array<{ id: string; label: string; completeThrough: string | null }>;
  answers: CategoryAnswerView[];
  /** True when the workspace holds no payment at all: the page explains where they come from. */
  noPayments: boolean;
}

export async function loadCategoryAnswers(db: PrismaClient, workspaceId: string): Promise<CategoryAnswerView[]> {
  const rows = await db.spendingCategoryAnswer.findMany({ where: { authWorkspaceId: workspaceId }, orderBy: { label: 'asc' } });
  // A stored key this code no longer knows is ignored rather than shown under a wrong name.
  return rows.flatMap((r) => (isSpendingCategory(r.category) ? [{ counterpartyKey: r.counterpartyKey, label: r.label, category: r.category }] : []));
}

/** The overview of `year` (one month of it when `month` is 1 to 12). */
export async function loadSpending(db: PrismaClient, workspaceId: string, year: number, month: number | null, today = new Date()): Promise<SpendingView> {
  const [loaded, answers] = await Promise.all([loadPayments(db, workspaceId), loadCategoryAnswers(db, workspaceId)]);
  const overview = buildOverview(
    loaded.payments.map((p) => ({
      id: p.id,
      accountId: p.accountId,
      bookingDay: p.bookingDay,
      amountCents: p.amountCents,
      counterparty: p.counterparty,
      counterpartyKey: p.counterpartyKey,
      reference: p.reference,
      kind: p.kind,
      linkCount: p.links.length,
    })),
    { treatments: loaded.treatments, answers: new Map(answers.map((a) => [a.counterpartyKey, a.category])) },
    year,
    month,
  );
  return {
    overview,
    // The year asked for is always offered, so the year picker shows what the page shows even for a year without payments.
    years: [...new Set([year, ...paymentYears(loaded.payments, berlinYear(today))])].sort((a, b) => b - a),
    accounts: loaded.accounts.map((a) => ({ id: a.id, label: a.label, completeThrough: a.completeThrough })),
    answers,
    noPayments: loaded.payments.length === 0,
  };
}

/**
 * Take a category answer back by the key it is stored under (not by the name
 * shown, so a change in how names are normalized can never leave an answer
 * that cannot be removed). The payments then follow the rules again.
 */
export async function removeCounterpartyCategory(db: PrismaClient, ctx: SpendingContext, key: unknown): Promise<void> {
  if (typeof key !== 'string' || !key) throw new SpendingServiceError('counterparty_required');
  await db.spendingCategoryAnswer.deleteMany({ where: { authWorkspaceId: ctx.workspaceId, counterpartyKey: key } });
}

/**
 * Give a counterparty a spending category, for all its payments. `category`
 * null takes the answer back; the payments then follow the rules again.
 */
export async function setCounterpartyCategory(db: PrismaClient, ctx: SpendingContext, raw: unknown): Promise<void> {
  const input = (raw ?? {}) as { counterparty?: unknown; category?: unknown };
  const label = typeof input.counterparty === 'string' ? input.counterparty.trim() : '';
  const key = counterpartyKey(label);
  if (!key) throw new SpendingServiceError('counterparty_required');
  if (input.category === null) {
    await db.spendingCategoryAnswer.deleteMany({ where: { authWorkspaceId: ctx.workspaceId, counterpartyKey: key } });
    return;
  }
  // "Unclear" is what no answer means; storing it would only hide the question.
  if (!isSpendingCategory(input.category) || input.category === 'unclear') throw new SpendingServiceError('invalid_category');
  await db.spendingCategoryAnswer.upsert({
    where: { authWorkspaceId_counterpartyKey: { authWorkspaceId: ctx.workspaceId, counterpartyKey: key } },
    create: { authWorkspaceId: ctx.workspaceId, authTenantId: ctx.tenantId, counterpartyKey: key, label, category: input.category },
    update: { label, category: input.category },
  });
}
