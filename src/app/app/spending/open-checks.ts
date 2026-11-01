import type { PaymentCheck } from '@/lib/spending/loop-service';

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
