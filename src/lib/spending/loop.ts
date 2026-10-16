import { vendorNamed } from '@/lib/tax/payments/match';
import type { PaymentKind } from '@/lib/tax/payments/types';
import type { SpendingCategory } from './categories';
import { categorise, normalizeText, type CounterpartyTreatmentAnswer } from './rules';

/**
 * The missing-receipt loop, as a pure function of what is stored (plan
 * docs/plans/2026-10-14-personal-spending-and-bank-feed.md, "The loop, as
 * steps"). Nothing about a payment's state is stored: it is worked out on read
 * from the payment, its links, the counterparty answers and the one thing a
 * person can say here ("no receipt exists"). So a changed answer, a removed
 * link or a re-labelled payment changes the state at once, and nothing can go
 * stale.
 *
 * For each payment, first hit wins:
 *
 * - it is linked to a receipt or invoice: settled;
 * - step 1, it needs no receipt (an own transfer, income, a refund, a fee,
 *   a loan instalment, cash, money to a person);
 * - a person said no receipt exists, with the reason: settled, never asked again;
 * - step 2, unlinked receipts of this company fit it by vendor, amount and day:
 *   a person confirms one;
 * - step 3, the expenses mailbox holds a mail with an attachment that may be
 *   the invoice: the owner takes it into the normal upload path with one tap;
 * - step 5, otherwise the receipt is missing and the owner is asked.
 */

export type NotNeededReason = 'own_transfer' | 'income' | 'refund' | 'fee' | 'loan' | 'cash' | 'transfer';

export interface LoopPayment {
  id: string;
  bookingDay: string;
  amountCents: number;
  counterparty: string;
  counterpartyKey: string;
  reference: string;
  kind: PaymentKind;
  linkCount: number;
}

/** A receipt of this company as the loop sees it. */
export interface LoopReceipt {
  rowId: string;
  label: string;
  vendor: string | null;
  /** `vendorKey` of the vendor; null when the receipt names none (then it is never proposed). */
  vendorKey: string | null;
  day: string | null;
  /** Euro cents: the receipt's own amount, or the reference-rate estimate of a foreign-currency receipt. */
  amountCents: number | null;
  estimated: boolean;
  /** Linked to any payment already. */
  linked: boolean;
}

export interface ReceiptCandidate {
  rowId: string;
  label: string;
  day: string;
  amountCents: number;
  estimated: boolean;
}

export type LoopState =
  | { state: 'has_receipt' }
  | { state: 'not_needed'; reason: NotNeededReason }
  | { state: 'no_receipt'; reason: string }
  | { state: 'proposed'; candidates: ReceiptCandidate[] }
  | { state: 'in_mailbox'; mails: MailCandidateView[] }
  | { state: 'missing' };

/** A mail attachment found for a payment (see the mailbox port), as the open checks show it. */
export interface MailCandidateView {
  id: string;
  fileName: string;
  receivedDay: string;
  subject: string;
  sender: string;
}

export interface LoopContext {
  treatments: ReadonlyMap<string, CounterpartyTreatmentAnswer>;
  categoryAnswers: ReadonlyMap<string, SpendingCategory>;
  /** "No receipt exists" answers by payment id, with the reason. */
  noReceipt: ReadonlyMap<string, string>;
  receipts: readonly LoopReceipt[];
  /** Vendor keys a counterparty is known to stand for, from the links that exist (see the payments service). */
  vendorAliases: ReadonlyMap<string, ReadonlySet<string>>;
  /** Mail attachments found for a payment, by payment id. Optional: no mailbox, no entries. */
  mailCandidates?: ReadonlyMap<string, readonly MailCandidateView[]>;
}

/** Days a receipt may lie before the payment (an invoice paid later), and after it (a receipt dated after a card payment). */
export const RECEIPT_DAYS_BEFORE_PAYMENT = 60;
export const RECEIPT_DAYS_AFTER_PAYMENT = 5;
/** How far a foreign-currency receipt's estimate may be from what the bank charged, in percent. */
export const ESTIMATE_TOLERANCE_PERCENT = 8;

const dayNumber = (day: string) => Math.round(Date.parse(`${day}T00:00:00Z`) / 86_400_000);

/** Step 1: why a payment needs no receipt, or null when it needs one. */
export function notNeededReason(payment: LoopPayment, ctx: Pick<LoopContext, 'treatments' | 'categoryAnswers'>): NotNeededReason | null {
  const treatment = payment.counterpartyKey ? ctx.treatments.get(payment.counterpartyKey) : undefined;
  if (treatment === 'own_account' || payment.kind === 'own_transfer') return 'own_transfer';
  if (payment.kind === 'income') return 'income';
  // Money back belongs on the receipt of the purchase it refunds; it never asks for a receipt of its own.
  if (payment.kind === 'refund' || payment.amountCents >= 0) return 'refund';
  if (payment.kind === 'fee') return 'fee';
  const answer = payment.counterpartyKey ? ctx.categoryAnswers.get(payment.counterpartyKey) : undefined;
  const { category } = categorise(payment, { treatment, answer });
  if (category === 'fees_interest') return 'fee';
  if (category === 'loans_leasing_credit') return 'loan';
  if (category === 'cash') return 'cash';
  if (category === 'transfers') return 'transfer';
  return null;
}

/**
 * Step 2: the receipts that may be this payment's. The vendor must be named
 * (by its words in the counterparty or the payment's text, or by a pairing a
 * person made with a link before), the receipt must be unlinked, dated from 60
 * days before to 5 days after the payment, and the amount must be exact (a
 * euro receipt) or within 8 percent (a foreign-currency estimate). Amount and
 * day alone are never enough here: that is the difference to the payments
 * tab's own proposals.
 */
export function receiptCandidates(payment: LoopPayment, ctx: Pick<LoopContext, 'receipts' | 'vendorAliases'>): ReceiptCandidate[] {
  const paid = Math.abs(payment.amountCents);
  const booked = dayNumber(payment.bookingDay);
  if (!Number.isFinite(booked)) return [];
  const referenceKey = normalizeText(payment.reference);
  const aliases = ctx.vendorAliases.get(payment.counterpartyKey);
  const out: ReceiptCandidate[] = [];
  for (const r of ctx.receipts) {
    if (r.linked || r.vendorKey === null || r.day === null || r.amountCents === null || r.amountCents <= 0) continue;
    const gap = booked - dayNumber(r.day);
    // A date that is no real day ("2026-13-45") places the receipt nowhere.
    if (!Number.isFinite(gap)) continue;
    if (gap > RECEIPT_DAYS_BEFORE_PAYMENT || gap < -RECEIPT_DAYS_AFTER_PAYMENT) continue;
    const fits = r.estimated ? Math.abs(paid - r.amountCents) * 100 <= ESTIMATE_TOLERANCE_PERCENT * r.amountCents : paid === r.amountCents;
    if (!fits) continue;
    if (!vendorNamed(r.vendorKey, payment.counterpartyKey, referenceKey) && !aliases?.has(r.vendorKey)) continue;
    out.push({ rowId: r.rowId, label: r.label, day: r.day, amountCents: r.amountCents, estimated: r.estimated });
  }
  // The closest day first: the likeliest receipt is at the top.
  return out.sort((a, b) => Math.abs(booked - dayNumber(a.day)) - Math.abs(booked - dayNumber(b.day)));
}

export function loopState(payment: LoopPayment, ctx: LoopContext): LoopState {
  if (payment.linkCount > 0) return { state: 'has_receipt' };
  const notNeeded = notNeededReason(payment, ctx);
  if (notNeeded) return { state: 'not_needed', reason: notNeeded };
  const answered = ctx.noReceipt.get(payment.id);
  if (answered !== undefined) return { state: 'no_receipt', reason: answered };
  const candidates = receiptCandidates(payment, ctx);
  if (candidates.length > 0) return { state: 'proposed', candidates };
  const mails = ctx.mailCandidates?.get(payment.id) ?? [];
  if (mails.length > 0) return { state: 'in_mailbox', mails: [...mails] };
  return { state: 'missing' };
}

/** Payments booked at most this many days ago are notified about; older ones only wait in the open checks. */
export const NOTIFY_WITHIN_DAYS = 14;

/** Is a missing receipt recent enough to notify about? Importing a year of history must not send a year of messages. */
export function notifiable(payment: Pick<LoopPayment, 'bookingDay'>, today: string): boolean {
  const age = dayNumber(today) - dayNumber(payment.bookingDay);
  return age >= 0 && age <= NOTIFY_WITHIN_DAYS;
}

/** The key that makes a payment's missing-receipt notification happen at most once, ever. */
export const missingReceiptSubject = (paymentId: string) => `missing_receipt:${paymentId}`;

/** The key of the one "invoice found in the mailbox" message of a payment, apart from its "receipt missing" message. */
export const mailFoundSubject = (paymentId: string) => `mail_found:${paymentId}`;
