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

/** Turnover and the tax on it at one rate, as the advance return asks for them. */
export interface RateTotal {
  rateBp: number;
  netCents: number;
  vatCents: number;
}

export interface VatPeriod {
  /** 1 to 12 for months, 1 to 4 for quarters. */
  index: number;
  /** ISO days, inclusive. */
  from: string;
  to: string;
  outputVatCents: number;
  inputVatCents: number;
  /** Tax owed as the buyer of services from abroad (section 13b), and the part of it deductible as input tax. */
  reverseChargeVatCents: number;
  reverseChargeInputVatCents: number;
  /** Output plus section 13b tax, minus input tax: positive is owed to the tax office, negative is a refund. */
  dueCents: number;
  /** The tax charged to clients split by rate, highest rate first, each with the turnover it was charged on. */
  outputByRate: RateTotal[];
  /** The events behind the figures, so each can be traced to its invoice or receipt. */
  output: VatEvent[];
  input: VatEvent[];
  reverseCharge: VatEvent[];
}

export interface VatYear {
  periods: VatPeriod[];
  outputByRate: RateTotal[];
  outputVatCents: number;
  inputVatCents: number;
  reverseChargeVatCents: number;
  reverseChargeInputVatCents: number;
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
  events: {
    inputVat: VatEvent[];
    outputVatByIssue: VatEvent[];
    outputVatByPayment: VatEvent[];
    /** Section 13b: arises on its own day under either method (section 13b (1) and (2)). */
    reverseCharge?: VatEvent[];
    reverseChargeInput?: VatEvent[];
  },
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
      reverseChargeVatCents: 0,
      reverseChargeInputVatCents: 0,
      dueCents: 0,
      outputByRate: [],
      output: [],
      input: [],
      reverseCharge: [],
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
  for (const event of events.reverseCharge ?? []) {
    const period = periodOf(event.date);
    if (!period) continue;
    period.reverseChargeVatCents += event.cents;
    period.reverseCharge.push(event);
  }
  for (const event of events.reverseChargeInput ?? []) {
    const period = periodOf(event.date);
    if (!period) continue;
    period.reverseChargeInputVatCents += event.cents;
  }
  for (const period of periods) {
    period.dueCents = period.outputVatCents + period.reverseChargeVatCents - period.inputVatCents - period.reverseChargeInputVatCents;
    period.outputByRate = byRate(period.output);
  }

  const total = (pick: (p: VatPeriod) => number) => periods.reduce((s, p) => s + pick(p), 0);
  return {
    periods,
    outputByRate: byRate(periods.flatMap((p) => p.output)),
    outputVatCents: total((p) => p.outputVatCents),
    inputVatCents: total((p) => p.inputVatCents),
    reverseChargeVatCents: total((p) => p.reverseChargeVatCents),
    reverseChargeInputVatCents: total((p) => p.reverseChargeInputVatCents),
    dueCents: total((p) => p.dueCents),
  };
}

/** Sum output events by rate; an event without a rate is left to the period's totals. */
function byRate(events: readonly VatEvent[]): RateTotal[] {
  const totals = new Map<number, RateTotal>();
  for (const event of events) {
    if (event.rateBp === undefined) continue;
    const total = totals.get(event.rateBp) ?? { rateBp: event.rateBp, netCents: 0, vatCents: 0 };
    total.netCents += event.netCents ?? 0;
    total.vatCents += event.cents;
    totals.set(event.rateBp, total);
  }
  return [...totals.values()].sort((a, b) => b.rateBp - a.rateBp);
}
