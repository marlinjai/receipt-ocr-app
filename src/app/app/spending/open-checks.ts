import { RECEIPT_NOT_FOUND } from '@/lib/spending/loop';
import type { PaymentCheck } from '@/lib/spending/loop-service';

/** What an action does to a payment on screen until the server has answered; null takes it off the lists. */
export type CheckEdit = (check: PaymentCheck) => PaymentCheck | null;

export const receiptLinked: CheckEdit = (c) => ({ ...c, state: { state: 'has_receipt' } });

export const answeredNoReceipt =
  (reason: string): CheckEdit =>
  (c) => ({ ...c, state: { state: 'no_receipt', reason: reason.trim() } });

/** Open again, as `missing` until the server says what fits by now. An answer about a payment gone to another company was all that listed it here. */
export const answerTakenBack: CheckEdit = (c) => (c.state.state === 'no_receipt' && c.state.movedAway ? null : { ...c, state: { state: 'missing' } });

export const mailSetAside =
  (mailId: string): CheckEdit =>
  (c) => {
    if (c.state.state !== 'in_mailbox') return c;
    const mails = c.state.mails.filter((m) => m.id !== mailId);
    return { ...c, state: mails.length > 0 ? { state: 'in_mailbox', mails } : { state: 'missing' } };
  };

/** How many open payments the list adds at a time: a phone cannot carry thousands of rows with their buttons. */
export const CHECKS_PAGE = 30;

export interface ChecksChoice {
  /** The booking year, or null for every year. */
  year: string | null;
  /** Only payments for which the app proposes a receipt. */
  onlyProposed: boolean;
  limit: number;
}

export type OpenCheckItem = Pick<PaymentCheck, 'paymentId' | 'bookingDay' | 'state'>;

/** The years the open payments fall in, newest first, with how many. */
export function checkYears(open: readonly OpenCheckItem[]): Array<{ year: string; count: number }> {
  const years = new Map<string, number>();
  for (const c of open) {
    const year = c.bookingDay.slice(0, 4);
    years.set(year, (years.get(year) ?? 0) + 1);
  }
  return [...years].map(([year, count]) => ({ year, count })).sort((a, b) => b.year.localeCompare(a.year));
}

/**
 * What the list shows of the open payments, in their order. The payment a
 * notification points at is always there, whatever the choice, because the page
 * scrolls to it: it stands first when the choice would leave it out.
 */
export function chooseChecks<T extends OpenCheckItem>(open: readonly T[], choice: ChecksChoice, focusPaymentId: string | null): { shown: T[]; matching: number } {
  const matches = open.filter((c) => (choice.year === null || c.bookingDay.startsWith(choice.year)) && (!choice.onlyProposed || c.state.state === 'proposed'));
  const shown = matches.slice(0, choice.limit);
  const focused = focusPaymentId === null ? undefined : open.find((c) => c.paymentId === focusPaymentId);
  return { shown: focused && !shown.includes(focused) ? [focused, ...shown] : shown, matching: matches.length };
}

/** The answered payments: those whose receipt could not be found stand apart, in red, because they may be business expenses. */
export function splitAnswered<T extends Pick<PaymentCheck, 'state'>>(answered: readonly T[]): { lost: T[]; answered: T[] } {
  const isLost = (c: T) => c.state.state === 'no_receipt' && c.state.reason === RECEIPT_NOT_FOUND;
  return { lost: answered.filter(isLost), answered: answered.filter((c) => !isLost(c)) };
}
