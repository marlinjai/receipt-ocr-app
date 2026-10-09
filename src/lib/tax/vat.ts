import type { VatEvent } from './types';

/**
 * The advance return periods of a year under regular value-added taxation:
 * per period the tax charged to clients, the input tax from purchases, and
 * what is due. Pure; the figures of a period are computed on read like every
 * other figure.
 *
 * Two things are settings of the business, asked once, and nothing is
 * computed without them:
 * - how often a return is filed (monthly or quarterly, as the tax office set it);
 * - whether the tax on an invoice is owed when the invoice is issued or when
 *   it is paid (the second needs the tax office's permission).
 * Input tax counts in the period of the purchase in both cases.
 */

export type VatFrequency = 'monthly' | 'quarterly';
/** `issued`: owed when the invoice is issued. `received`: owed when the client pays. */
export type VatMethod = 'issued' | 'received';

export interface VatPeriod {
  /** 1 to 12 for months, 1 to 4 for quarters. */
  index: number;
  /** ISO days, inclusive. */
  from: string;
  to: string;
  outputVatCents: number;
  inputVatCents: number;
  /** Output minus input: positive is owed to the tax office, negative is a refund. */
  dueCents: number;
  /** The events behind the two figures, so each can be traced to its invoice or receipt. */
  output: VatEvent[];
  input: VatEvent[];
}

export interface VatYear {
  periods: VatPeriod[];
  outputVatCents: number;
  inputVatCents: number;
  dueCents: number;
}

function lastDayOfMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

const pad = (n: number) => String(n).padStart(2, '0');

export function vatYear(
  year: number,
  frequency: VatFrequency,
  method: VatMethod,
  events: { inputVat: VatEvent[]; outputVatByIssue: VatEvent[]; outputVatByPayment: VatEvent[] },
): VatYear {
  const monthsPerPeriod = frequency === 'monthly' ? 1 : 3;
  const count = 12 / monthsPerPeriod;
  const periods: VatPeriod[] = Array.from({ length: count }, (_, i) => {
    const firstMonth = i * monthsPerPeriod + 1;
    const lastMonth = firstMonth + monthsPerPeriod - 1;
    return {
      index: i + 1,
      from: `${year}-${pad(firstMonth)}-01`,
      to: `${year}-${pad(lastMonth)}-${pad(lastDayOfMonth(year, lastMonth))}`,
      outputVatCents: 0,
      inputVatCents: 0,
      dueCents: 0,
      output: [],
      input: [],
    };
  });
  const periodOf = (isoDay: string): VatPeriod | null => {
    if (Number(isoDay.slice(0, 4)) !== year) return null;
    return periods[Math.floor((Number(isoDay.slice(5, 7)) - 1) / monthsPerPeriod)] ?? null;
  };

  for (const event of method === 'issued' ? events.outputVatByIssue : events.outputVatByPayment) {
    const period = periodOf(event.date);
    if (!period) continue;
    period.outputVatCents += event.cents;
    period.output.push(event);
  }
  for (const event of events.inputVat) {
    const period = periodOf(event.date);
    if (!period) continue;
    period.inputVatCents += event.cents;
    period.input.push(event);
  }
  for (const period of periods) period.dueCents = period.outputVatCents - period.inputVatCents;

  const total = (pick: (p: VatPeriod) => number) => periods.reduce((s, p) => s + pick(p), 0);
  return {
    periods,
    outputVatCents: total((p) => p.outputVatCents),
    inputVatCents: total((p) => p.inputVatCents),
    dueCents: total((p) => p.dueCents),
  };
}
