import 'server-only';
import { Prisma, type PrismaClient } from '@prisma/client';
import { counterpartyKey, loadPayments, setCounterpartyTreatment, type PaymentRow } from '@/lib/tax/payments/service';
import { loadRoutedPayments, type RoutedPaymentRow, type RoutedPayments } from '@/lib/tax/payments/routing';
import { isSpendingCategory, type SpendingCategory } from './categories';
import { berlinYear } from './period';
import { buildOverview, paymentYears, type OverviewPaymentInput, type SpendingOverview } from './overview';
import { cleanOwnNames, treatmentsWithOwnNames } from './own-names';
import type { CounterpartyTreatmentAnswer } from './rules';

/**
 * Server-side reads and writes for the spending overview. Every function takes
 * the workspace explicitly and touches rows only inside it: the overview of one
 * company never sees another company's payments or answers. Payments are read
 * through the payments area's reads, never queried here: `loadRoutedPayments`
 * gives the company's own payments less those whose account shares its private
 * payments with another company, plus the private payments other companies
 * share with it (plan docs/plans/2026-10-22-payments-across-companies.md).
 */

export interface SpendingContext {
  workspaceId: string;
  tenantId: string | null;
}

export type SpendingServiceErrorCode =
  | 'counterparty_required'
  | 'invalid_category'
  /** The payments tab already answered the counterparty as business or private; that answer is changed there, not overwritten here. */
  | 'treatment_exists'
  /** Taking back an own-account answer that is not one. */
  | 'not_own_account'
  /** Own names that are no list of names, or a name with nothing to match on. */
  | 'invalid_names'
  | 'name_too_long'
  | 'too_many_names'
  /** The name, in this or another spelling, is listed already. */
  | 'name_listed'
  /** The name to take out is not in the list (any more). */
  | 'name_not_listed';

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
  /** `sharedFrom`: the workspace of the company that holds the account, when only its private payments are here. */
  accounts: Array<{ id: string; label: string; completeThrough: string | null; sharedFrom: string | null }>;
  /** Accounts of this company whose private payments show in another company (its workspace). */
  sharedOut: Array<{ accountLabel: string; receiverWorkspaceId: string }>;
  /** Receipts of this company still linked to payments that moved back to the company holding their account: taken back here. */
  dormantLinks: Array<{ paymentId: string; receipts: number; cents: number; linkedOn: string }>;
  answers: CategoryAnswerView[];
  /**
   * Counterparties counted as an own account, with a name to show: answered so (here or in the payments
   * tab), or `byName` because they carry one of the own names (changed with the names, not taken back here).
   */
  ownAccounts: Array<{ counterpartyKey: string; label: string; byName: boolean }>;
  /** The owner's own names, as typed. */
  ownNames: string[];
  /** True when the workspace holds no payment at all: the page explains where they come from. */
  noPayments: boolean;
}

export async function loadCategoryAnswers(db: PrismaClient, workspaceId: string): Promise<CategoryAnswerView[]> {
  const rows = await db.spendingCategoryAnswer.findMany({ where: { authWorkspaceId: workspaceId }, orderBy: { label: 'asc' } });
  // A stored key this code no longer knows is ignored rather than shown under a wrong name.
  return rows.flatMap((r) => (isSpendingCategory(r.category) ? [{ counterpartyKey: r.counterpartyKey, label: r.label, category: r.category }] : []));
}

/**
 * A payment of the payments service as the overview and the budgets read it.
 * The one mapper for both, so the private and business parts are worked out
 * from the same facts everywhere (links, a private account).
 */
export function toOverviewInput(p: PaymentRow | RoutedPaymentRow): OverviewPaymentInput {
  return {
    id: p.id,
    accountId: p.accountId,
    bookingDay: p.bookingDay,
    amountCents: p.amountCents,
    counterparty: p.counterparty,
    counterpartyKey: p.counterpartyKey,
    reference: p.reference,
    kind: p.kind,
    linkCount: p.links.length,
    linkedCents: p.links.reduce((sum, l) => sum + l.cents, 0),
    byPrivateAccount: p.byPrivateAccount,
    routed: 'routedFrom' in p && p.routedFrom !== null,
    // Only while the funding rule decides it: a person who said what the debit is has answered it.
    awaitingList: p.byRule && p.funding?.awaitingList ? p.funding.service : null,
  };
}

/**
 * The category answers that apply on this company's spending side: its own,
 * and for the counterparties of payments routed here, the answers the holding
 * company gave before (the owner categorized private counterparties there
 * before the split). A category belongs to a counterparty, so an inherited
 * one applies to every payment of that counterparty here, as an own answer
 * would. The own answer wins. Nothing of this company flows back.
 */
export async function categoryAnswerMap(db: PrismaClient, workspaceId: string, routed: Pick<RoutedPayments, 'payments' | 'holders'>, own?: readonly CategoryAnswerView[]): Promise<Map<string, SpendingCategory>> {
  const mine = own ?? (await loadCategoryAnswers(db, workspaceId));
  const out = new Map<string, SpendingCategory>();
  // Per holder only the counterparties of ITS routed payments; with two holders answering one counterparty
  // differently, the answer given last wins, so the result never depends on the database's row order.
  const keysByHolder = new Map<string, Set<string>>();
  for (const p of routed.payments) {
    if (p.routedFrom === null || !p.counterpartyKey) continue;
    keysByHolder.set(p.routedFrom, (keysByHolder.get(p.routedFrom) ?? new Set()).add(p.counterpartyKey));
  }
  if (keysByHolder.size > 0) {
    const inherited = await db.spendingCategoryAnswer.findMany({
      where: { OR: [...keysByHolder].map(([holder, keys]) => ({ authWorkspaceId: holder, counterpartyKey: { in: [...keys] } })) },
      orderBy: [{ updatedAt: 'asc' }, { id: 'asc' }],
    });
    for (const a of inherited) if (isSpendingCategory(a.category)) out.set(a.counterpartyKey, a.category);
  }
  for (const a of mine) out.set(a.counterpartyKey, a.category);
  return out;
}

/** The owner's own names of this company, as typed; none before he set any. */
export async function loadOwnNames(db: PrismaClient, workspaceId: string): Promise<string[]> {
  const row = await db.spendingSettings.findUnique({ where: { authWorkspaceId: workspaceId }, select: { ownNames: true } });
  return row?.ownNames ?? [];
}

/**
 * The counterparty answers the spending side reads: the payments tab's, and
 * own accounts by the owner's own names where no answer was given (see
 * `treatmentsWithOwnNames`). The one place the names apply, for the overview,
 * the budgets and the missing-receipt loop alike.
 */
export async function spendingTreatments(
  db: PrismaClient,
  workspaceId: string,
  loaded: Pick<RoutedPayments, 'payments' | 'treatments'>,
  names?: readonly string[],
): Promise<{ treatments: ReadonlyMap<string, CounterpartyTreatmentAnswer>; byName: ReadonlySet<string> }> {
  const ownNames = names ?? (await loadOwnNames(db, workspaceId));
  return treatmentsWithOwnNames(loaded.treatments, loaded.payments, ownNames);
}

/**
 * Add one own name or take one out (`{ add }` or `{ remove }`), on the list as
 * stored now: two open pages never undo each other's change. A second
 * spelling of a listed name is not added again.
 */
export async function saveOwnNames(db: PrismaClient, ctx: SpendingContext, raw: unknown): Promise<string[]> {
  const input = (raw ?? {}) as { add?: unknown; remove?: unknown };
  const adding = typeof input.add === 'string' && input.remove === undefined;
  if (!adding && !(typeof input.remove === 'string' && input.add === undefined)) throw new SpendingServiceError('invalid_names');
  // The settings row exists before it is locked, so two first changes at the same moment meet on one row.
  try {
    await db.spendingSettings.upsert({ where: { authWorkspaceId: ctx.workspaceId }, create: { authWorkspaceId: ctx.workspaceId, authTenantId: ctx.tenantId }, update: {} });
  } catch (e) {
    // Two first changes at the same moment: the other one created the row, which is all this needed.
    if (!(e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002')) throw e;
  }
  return db.$transaction(async (tx) => {
    // Locked until the change is written: a second change waits and then applies to this one's result.
    const [row] = await tx.$queryRaw<Array<{ own_names: string[] }>>`SELECT own_names FROM spending_settings WHERE auth_workspace_id = ${ctx.workspaceId} FOR UPDATE`;
    const current = row?.own_names ?? [];
    const cleaned = cleanOwnNames(adding ? [...current, input.add] : current.filter((n) => n !== input.remove));
    if (!cleaned.ok) throw new SpendingServiceError(cleaned.error);
    // A name typed that adds nothing (empty, or a spelling already listed) is refused, so the page says so.
    if (adding && cleaned.names.length === current.length) throw new SpendingServiceError((input.add as string).trim() ? 'name_listed' : 'invalid_names');
    // Taken out on another page already: said, so this page does not claim a change it did not make.
    if (!adding && cleaned.names.length === current.length) throw new SpendingServiceError('name_not_listed');
    await tx.spendingSettings.update({ where: { authWorkspaceId: ctx.workspaceId }, data: { ownNames: cleaned.names } });
    return cleaned.names;
  });
}

/** The overview of `year` (one month of it when `month` is 1 to 12). */
export async function loadSpending(db: PrismaClient, workspaceId: string, year: number, month: number | null, today = new Date()): Promise<SpendingView> {
  const [loaded, answers, ownNames] = await Promise.all([loadRoutedPayments(db, workspaceId), loadCategoryAnswers(db, workspaceId), loadOwnNames(db, workspaceId)]);
  const { treatments, byName } = await spendingTreatments(db, workspaceId, loaded, ownNames);
  const overview = buildOverview(loaded.payments.map(toOverviewInput), { treatments, byName, answers: await categoryAnswerMap(db, workspaceId, loaded, answers), appCategories: loaded.appCategories }, year, month);
  return {
    overview,
    // The year asked for is always offered, so the year picker shows what the page shows even for a year without payments.
    years: [...new Set([year, ...paymentYears(loaded.payments, berlinYear(today))])].sort((a, b) => b - a),
    accounts: loaded.accounts.map((a) => ({ id: a.id, label: a.label, completeThrough: a.completeThrough, sharedFrom: a.sharedFrom })),
    sharedOut: loaded.sharedOut.map((s) => ({ accountLabel: s.accountLabel, receiverWorkspaceId: s.receiverWorkspaceId })),
    dormantLinks: loaded.dormantLinks.map((l) => ({ paymentId: l.paymentId, receipts: l.receipts, cents: l.cents, linkedOn: l.linkedOn })),
    answers,
    ownAccounts: [...treatments]
      .filter(([, treatment]) => treatment === 'own_account')
      .map(([key]) => ({ counterpartyKey: key, label: loaded.payments.find((p) => p.counterpartyKey === key)?.counterparty ?? key, byName: byName.has(key) }))
      .sort((a, b) => a.label.localeCompare(b.label, 'de')),
    ownNames,
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

/** Give a counterparty a spending category, for all its payments (taken back with `removeCounterpartyCategory`). */
export async function setCounterpartyCategory(db: PrismaClient, ctx: SpendingContext, raw: unknown): Promise<void> {
  const input = (raw ?? {}) as { counterparty?: unknown; category?: unknown };
  const label = typeof input.counterparty === 'string' ? input.counterparty.trim() : '';
  const key = counterpartyKey(label);
  if (!key) throw new SpendingServiceError('counterparty_required');
  // "Unclear" is what no answer means; storing it would only hide the question.
  if (!isSpendingCategory(input.category) || input.category === 'unclear') throw new SpendingServiceError('invalid_category');
  await db.spendingCategoryAnswer.upsert({
    where: { authWorkspaceId_counterpartyKey: { authWorkspaceId: ctx.workspaceId, counterpartyKey: key } },
    create: { authWorkspaceId: ctx.workspaceId, authTenantId: ctx.tenantId, counterpartyKey: key, label, category: input.category },
    update: { label, category: input.category },
  });
}

/**
 * The counterparty is one of the owner's own accounts (a credit card paid off
 * from the bank, a savings account). This writes the payments tab's own answer
 * through the payments service, so its payments stop counting as spending
 * everywhere. An existing business or private answer is never overwritten
 * from here: it may carry the tax treatment of every payment of the
 * counterparty, so it is changed in the payments tab.
 */
export async function markCounterpartyOwnAccount(db: PrismaClient, ctx: SpendingContext, raw: unknown): Promise<void> {
  const label = typeof raw === 'string' ? raw.trim() : '';
  const key = counterpartyKey(label);
  if (!key) throw new SpendingServiceError('counterparty_required');
  const { treatments } = await loadPayments(db, ctx.workspaceId);
  const current = treatments.get(key);
  if (current === 'own_account') return;
  if (current !== undefined) throw new SpendingServiceError('treatment_exists');
  await setCounterpartyTreatment(db, ctx, { counterparty: label, treatment: 'own_account' });
}

/** Take an own-account answer back (by key); any other answer is left alone. */
export async function unmarkCounterpartyOwnAccount(db: PrismaClient, ctx: SpendingContext, rawKey: unknown): Promise<void> {
  if (typeof rawKey !== 'string' || !rawKey) throw new SpendingServiceError('counterparty_required');
  const loaded = await loadRoutedPayments(db, ctx.workspaceId);
  if (loaded.treatments.get(rawKey) !== 'own_account') throw new SpendingServiceError('not_own_account');
  const label = loaded.payments.find((p) => p.counterpartyKey === rawKey)?.counterparty ?? rawKey;
  await setCounterpartyTreatment(db, ctx, { counterparty: label, treatment: null });
}
