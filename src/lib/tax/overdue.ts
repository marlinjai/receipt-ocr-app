/**
 * Issued invoices that are overdue: the reminder of decision D6 of the
 * invoicing plan (docs/plans/2026-10-14-invoicing-and-income.md). Pure.
 *
 * Every invoice is payable within 14 days of its issue date (decision D5: the
 * default term the invoices state). An invoice still not fully paid 14 days
 * after that due date is listed in the finance area's open checks, which is
 * the reminder. Money counts as received when it is recorded: a payment day
 * typed in, or a bank payment linked to the invoice.
 *
 * The record holds no due date of its own yet; when issued invoices come from
 * the invoicing tier with their own due date, `dueDate` takes it and the
 * default term only fills the gap.
 */

/** Payable within this many days of the issue date ("zahlbar innerhalb von 14 Tagen ohne Abzug"). */
export const PAYMENT_TERM_DAYS = 14;
/** An invoice is listed as overdue this many days after its due date. */
export const REMINDER_AFTER_DAYS = 14;

export interface OverdueInput {
  id: string;
  number: string;
  /** ISO day; an invoice without one cannot be overdue (it has its own check). */
  issueDate: string | null;
  /** Stated due day, when the record has one; otherwise the issue date plus the term. */
  dueDate?: string | null;
  grossCents: number;
  /** Booked out as never to be paid (a fee the client deducted) on `writtenOffOn`: from that day no longer open. */
  writtenOffCents?: number;
  writtenOffOn?: string | null;
  payments: ReadonlyArray<{ date: string; cents: number }>;
}

export interface OverdueInvoice {
  invoiceId: string;
  number: string;
  issueDate: string;
  dueDate: string;
  /** Unpaid as of today. */
  openCents: number;
  /** Whole days since the due date. At least `REMINDER_AFTER_DAYS`. */
  daysPastDue: number;
}

const DAY_MS = 86_400_000;
const dayNumber = (day: string) => Math.round(Date.parse(`${day}T00:00:00Z`) / DAY_MS);
const isoDay = (n: number) => new Date(n * DAY_MS).toISOString().slice(0, 10);
/** A real calendar day in ISO form: "2026-02-30" is refused, not rolled over into March. */
const isIsoDay = (day: string) => /^\d{4}-\d{2}-\d{2}$/.test(day) && !Number.isNaN(Date.parse(`${day}T00:00:00Z`)) && isoDay(dayNumber(day)) === day;

/** The issue day plus the payment term. */
export function defaultDueDate(issueDate: string): string {
  return isoDay(dayNumber(issueDate) + PAYMENT_TERM_DAYS);
}

/**
 * The invoices that are overdue on `today` (an ISO day), oldest due date
 * first. Every recorded payment counts, whatever its day: an invoice is
 * outstanding until a payment is linked to it, so a linked payment ends the
 * reminder. An invoice paid in full (or more) is never overdue.
 */
export function overdueInvoices(invoices: readonly OverdueInput[], today: string): OverdueInvoice[] {
  if (!isIsoDay(today)) throw new Error(`overdueInvoices: today must be an ISO day, got ${today}`);
  const todayNumber = dayNumber(today);
  const overdue: OverdueInvoice[] = [];
  for (const invoice of invoices) {
    if (invoice.issueDate === null || !isIsoDay(invoice.issueDate) || invoice.grossCents <= 0) continue;
    const dueDate = invoice.dueDate && isIsoDay(invoice.dueDate) ? invoice.dueDate : defaultDueDate(invoice.issueDate);
    const daysPastDue = todayNumber - dayNumber(dueDate);
    if (daysPastDue < REMINDER_AFTER_DAYS) continue;
    const paid = invoice.payments.reduce((sum, p) => sum + p.cents, 0);
    const writtenOff = invoice.writtenOffOn != null && invoice.writtenOffOn <= today ? (invoice.writtenOffCents ?? 0) : 0;
    const openCents = invoice.grossCents - paid - writtenOff;
    if (openCents <= 0) continue;
    overdue.push({ invoiceId: invoice.id, number: invoice.number, issueDate: invoice.issueDate, dueDate, openCents, daysPastDue });
  }
  return overdue.sort((a, b) => (a.dueDate < b.dueDate ? -1 : a.dueDate > b.dueDate ? 1 : a.number.localeCompare(b.number, 'de', { numeric: true })));
}
