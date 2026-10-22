import type { PaymentKind } from '@/lib/tax/payments/types';
import { SPENDING_CATEGORIES, type SpendingCategory } from './categories';
import { businessShare, categorise, purposeOf, spendingCents, type CategoryBasis, type CounterpartyTreatmentAnswer, type SpendingPurpose } from './rules';

/**
 * The spending overview of one year (or one month of it), from the payments
 * the app holds. Pure: the service loads, this adds up.
 */

/** A payment as the overview needs it (a subset of the payments service's `PaymentRow`). */
export interface OverviewPaymentInput {
  id: string;
  accountId: string;
  bookingDay: string;
  amountCents: number;
  counterparty: string;
  counterpartyKey: string;
  reference: string;
  kind: PaymentKind;
  /** Number of receipts or invoices the payment is linked to. */
  linkCount: number;
  /** Cents of the payment linked to receipts or invoices; with a mixed answer or on a private account that is its business part. */
  linkedCents?: number;
  /** True when the payment is private only because its whole account was said to be private. */
  byPrivateAccount?: boolean;
  /** True when the payment is here because the company holding its account calls it private (src/lib/tax/payments/route.ts). */
  routed?: boolean;
}

export interface OverviewPayment {
  id: string;
  accountId: string;
  bookingDay: string;
  amountCents: number;
  counterparty: string;
  counterpartyKey: string;
  reference: string;
  kind: PaymentKind;
  category: SpendingCategory;
  basis: CategoryBasis;
  purpose: SpendingPurpose;
  /** What the payment adds to its category: positive out, negative back. Null: not spending (income, own transfer). */
  spendingCents: number | null;
  /** Of `spendingCents`, the business part; the rest is private (or unanswered, with purpose `unanswered`). */
  businessCents: number;
  hasReceipt: boolean;
  /** Here from the company that holds its account: a receipt linked here can be taken back on this page. */
  routed: boolean;
}

export interface CategoryTotal {
  category: SpendingCategory;
  cents: number;
  count: number;
}

export interface UnclearCounterparty {
  /** Empty for payments whose source names nobody: those cannot be answered once for all and are listed one by one. */
  counterpartyKey: string;
  counterparty: string;
  cents: number;
  count: number;
  lastDay: string;
}

export interface SpendingOverview {
  year: number;
  /** 1 to 12, or null for the whole year. */
  month: number | null;
  /** Spending of the period, all categories, refunds deducted. */
  totalCents: number;
  /** All twelve categories, in their fixed order, zero ones included. */
  byCategory: CategoryTotal[];
  /** Twelve entries, January first: the year month by month, independent of `month`. */
  byMonth: Array<{ month: number; cents: number; byCategory: Record<SpendingCategory, number> }>;
  split: Record<SpendingPurpose, number>;
  /** Money that left an account for another own account in the period: shown, never counted as spending. */
  ownTransfers: { cents: number; count: number };
  /** Counterparties whose spending in the period is in "unclear", largest first. */
  unclear: UnclearCounterparty[];
  /** The payments of the period that count as spending or are own transfers, newest first. */
  payments: OverviewPayment[];
}

export interface OverviewContext {
  treatments: ReadonlyMap<string, CounterpartyTreatmentAnswer>;
  answers: ReadonlyMap<string, SpendingCategory>;
}

export function classifyPayment(p: OverviewPaymentInput, ctx: OverviewContext): OverviewPayment {
  const treatment = p.counterpartyKey ? ctx.treatments.get(p.counterpartyKey) : undefined;
  const answer = p.counterpartyKey ? ctx.answers.get(p.counterpartyKey) : undefined;
  const { category, basis } = categorise(p, { treatment, answer });
  // An own account is never spending, even when the file calls the line a purchase. The payments read
  // already turns such payments into own transfers; this is a deliberate second guard, so the overview
  // stays right should that read ever change.
  const cents = treatment === 'own_account' ? null : spendingCents(p);
  const purpose = purposeOf(p, treatment);
  return {
    id: p.id,
    accountId: p.accountId,
    bookingDay: p.bookingDay,
    amountCents: p.amountCents,
    counterparty: p.counterparty,
    counterpartyKey: p.counterpartyKey,
    reference: p.reference,
    kind: p.kind,
    category,
    basis,
    purpose,
    spendingCents: cents,
    businessCents: cents === null ? 0 : businessShare(cents, purpose, treatment === 'mixed' || p.byPrivateAccount === true, p.linkedCents ?? 0),
    hasReceipt: p.linkCount > 0,
    routed: p.routed === true,
  };
}

const zeroCategories = (): Record<SpendingCategory, number> =>
  Object.fromEntries(SPENDING_CATEGORIES.map((c) => [c, 0])) as Record<SpendingCategory, number>;

export function buildOverview(payments: readonly OverviewPaymentInput[], ctx: OverviewContext, year: number, month: number | null): SpendingOverview {
  const prefix = `${year}-`;
  const monthPrefix = month === null ? null : `${year}-${String(month).padStart(2, '0')}-`;
  const ofYear = payments.filter((p) => p.bookingDay.startsWith(prefix)).map((p) => classifyPayment(p, ctx));
  const byMonth = Array.from({ length: 12 }, (_, i) => ({ month: i + 1, cents: 0, byCategory: zeroCategories() }));
  for (const p of ofYear) {
    if (p.spendingCents === null) continue;
    const entry = byMonth[Number(p.bookingDay.slice(5, 7)) - 1];
    if (!entry) continue;
    entry.cents += p.spendingCents;
    entry.byCategory[p.category] += p.spendingCents;
  }

  const inPeriod = monthPrefix === null ? ofYear : ofYear.filter((p) => p.bookingDay.startsWith(monthPrefix));
  const totals = zeroCategories();
  const counts = zeroCategories();
  const split: Record<SpendingPurpose, number> = { private: 0, business: 0, unanswered: 0 };
  const ownTransfers = { cents: 0, count: 0 };
  const unclear = new Map<string, UnclearCounterparty>();
  const listed: OverviewPayment[] = [];
  let totalCents = 0;
  for (const p of inPeriod) {
    if (p.spendingCents === null) {
      if (p.category === 'transfers' && p.basis === 'own_account') {
        listed.push(p);
        // Only the side leaving an account: with both accounts imported, the money arriving is the same money.
        if (p.amountCents < 0) {
          ownTransfers.cents += -p.amountCents;
          ownTransfers.count += 1;
        }
      }
      continue;
    }
    listed.push(p);
    totalCents += p.spendingCents;
    totals[p.category] += p.spendingCents;
    counts[p.category] += 1;
    // A payment only partly business (a mixed counterparty, a private account) is split by what is linked.
    split.business += p.businessCents;
    split[p.purpose === 'business' ? 'private' : p.purpose] += p.spendingCents - p.businessCents;
    if (p.category === 'unclear') {
      // Nameless payments are kept apart, one entry each: there is nobody to answer for.
      const key = p.counterpartyKey || `payment:${p.id}`;
      const entry = unclear.get(key) ?? { counterpartyKey: p.counterpartyKey, counterparty: p.counterparty || p.reference, cents: 0, count: 0, lastDay: p.bookingDay };
      entry.cents += p.spendingCents;
      entry.count += 1;
      if (p.bookingDay > entry.lastDay) entry.lastDay = p.bookingDay;
      unclear.set(key, entry);
    }
  }
  listed.sort((a, b) => (a.bookingDay === b.bookingDay ? 0 : a.bookingDay < b.bookingDay ? 1 : -1));
  return {
    year,
    month,
    totalCents,
    byCategory: SPENDING_CATEGORIES.map((category) => ({ category, cents: totals[category], count: counts[category] })),
    byMonth,
    split,
    ownTransfers,
    unclear: [...unclear.values()].sort((a, b) => b.cents - a.cents),
    payments: listed,
  };
}

/** The years payments exist for, newest first, always including `current`. */
export function paymentYears(payments: ReadonlyArray<{ bookingDay: string }>, current: number): number[] {
  const years = new Set<number>([current]);
  for (const p of payments) {
    const y = Number(p.bookingDay.slice(0, 4));
    if (Number.isInteger(y)) years.add(y);
  }
  return [...years].sort((a, b) => b - a);
}
