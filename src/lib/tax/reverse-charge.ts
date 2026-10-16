import { isIsoDay } from './decisions';
import type { LedgerItem } from './types';

/**
 * Tax the buyer owes on services from abroad (reverse charge, section 13b of
 * the value-added tax act). Pure.
 *
 * A foreign supplier of a service whose place of supply is Germany invoices
 * without German tax; the business that receives it owes the tax itself
 * (section 13b (5) sentence 1, as an entrepreneur). A small business is an
 * entrepreneur too, so it owes the tax under the same sentence 1 (sentence 9,
 * on buyers under section 19 (1), concerns only the cases of sentences 2 and
 * 5, construction work and building cleaning). It cannot deduct it, because a
 * small business's own turnover is tax free (section 19 (1)) and tax on
 * purchases used for tax-free turnover is excluded from deduction (section 15
 * (2) sentence 1 number 1). Under regular taxation the tax is deductible as
 * input tax (section 15 (1) sentence 1 number 4), for the business share
 * only. The tax is owed in full also for a share used outside the business
 * (section 13b (5) sentence 7): that share is neither deductible nor a
 * business expense.
 *
 * When it arises: for a service from another member state of the European
 * Union at the end of the advance return period in which it was performed
 * (section 13b (1)); in the other cases with the invoice, at the latest at the
 * end of the following month (section 13b (2)); a payment made before the
 * service makes it arise in the period of that payment (section 13b (4)
 * sentence 2). The app approximates this with the earlier of the receipt's
 * document day and the day it was paid.
 *
 * Whether a receipt is such a purchase is a statement of the owner: per
 * receipt, or per vendor from a day on, like the other parts of a treatment.
 * The receipt's own statement wins; it can also say "not under section 13b"
 * against its vendor's entry.
 */

export const REVERSE_CHARGE_RATES_BP = [1900, 700] as const;
export type ReverseChargeRateBp = (typeof REVERSE_CHARGE_RATES_BP)[number];

export interface ReverseChargeEntry {
  id: string;
  scope: 'row' | 'vendor';
  /** The receipt row id for `row`, the vendor key for `vendor`. */
  subject: string;
  /** For `vendor`: the name as typed, for the screen. */
  label: string;
  /** ISO day, or '' for "from the beginning". Always '' for `row`. */
  effectiveFrom: string;
  /** The rate in basis points; null states that the purchase is NOT under section 13b. */
  rateBp: ReverseChargeRateBp | null;
}

export type ReverseChargeOrigin = 'item' | 'vendor_rule';

/**
 * The statement in force for a receipt: its own, else the vendor entry in
 * force on its document day (the latest that starts on or before it). Null
 * when nothing says the receipt is under section 13b.
 */
export function reverseChargeFor(
  entries: readonly ReverseChargeEntry[],
  rowId: string,
  vendorKey: string | null,
  documentDay: string | null,
): { rateBp: ReverseChargeRateBp; origin: ReverseChargeOrigin; entryId: string } | null {
  const own = entries.find((e) => e.scope === 'row' && e.subject === rowId);
  if (own) return own.rateBp === null ? null : { rateBp: own.rateBp, origin: 'item', entryId: own.id };
  if (!vendorKey) return null;
  let best: ReverseChargeEntry | null = null;
  for (const entry of entries) {
    if (entry.scope !== 'vendor' || entry.subject !== vendorKey) continue;
    if (entry.effectiveFrom !== '' && (documentDay === null || entry.effectiveFrom > documentDay)) continue;
    if (best === null || entry.effectiveFrom > best.effectiveFrom) best = entry;
  }
  if (!best || best.rateBp === null) return null;
  return { rateBp: best.rateBp, origin: 'vendor_rule', entryId: best.id };
}

/** The earlier of two ISO days; null only when both are. */
export function earlierDay(a: string | null | undefined, b: string | null | undefined): string | null {
  if (!a) return b ?? null;
  if (!b) return a;
  return a < b ? a : b;
}

/**
 * Put the statement on a resolved item. The supplier's invoice shows no
 * German tax, so the amount paid is the net amount: under regular taxation
 * the item then counts with its whole amount and no input tax of its own; the
 * tax owed is computed beside it, on `taxDay` (see above) and with the
 * section 19 status of that day, which decides whether it is deductible. A
 * meal is never a reverse-charge purchase here (the meal register judges a
 * meal), so a statement on one is ignored.
 */
export function withReverseCharge(
  item: LedgerItem,
  rateBp: ReverseChargeRateBp | null,
  taxDay: string | null,
  smallBusinessOnTaxDay: boolean | null,
): LedgerItem {
  if (rateBp === null || item.meal) return item;
  return {
    ...item,
    netCents: item.amountCents,
    reverseCharge: { rateBp, taxDay: taxDay ?? item.vatDate ?? item.date, smallBusinessOnTaxDay },
  };
}

/** The tax owed on a base, rounded to the cent, a credit note the same way as an invoice. */
export function reverseChargeTax(baseCents: number, rateBp: number): number {
  const tax = Math.round((Math.abs(baseCents) * rateBp) / 10_000);
  return baseCents < 0 ? -tax : tax;
}

export type ReverseChargeInputErrorCode = 'invalid_reverse_charge_rate' | 'invalid_reverse_charge_date';

export class ReverseChargeInputError extends Error {
  readonly code: ReverseChargeInputErrorCode;
  constructor(code: ReverseChargeInputErrorCode) {
    super(code);
    this.name = 'ReverseChargeInputError';
    this.code = code;
  }
}

/** A rate as sent by the screen: 1900, 700, or null for "not under section 13b". */
export function validateReverseChargeRate(raw: unknown): ReverseChargeRateBp | null {
  if (raw === null) return null;
  if (typeof raw === 'number' && (REVERSE_CHARGE_RATES_BP as readonly number[]).includes(raw)) return raw as ReverseChargeRateBp;
  throw new ReverseChargeInputError('invalid_reverse_charge_rate');
}

/** '' or a valid ISO day. */
export function validateEffectiveFrom(raw: unknown): string {
  if (raw === undefined || raw === null || raw === '') return '';
  if (!isIsoDay(raw)) throw new ReverseChargeInputError('invalid_reverse_charge_date');
  return raw;
}
