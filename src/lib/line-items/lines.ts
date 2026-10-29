/**
 * A receipt's lines as plain data: the strict reading of the model's answer,
 * whether its printed amounts are gross or net (`priceLines`), the check that
 * the lines add up to the receipt's total, and the keys a
 * person's kind answer is remembered under. Pure: no database, no network.
 *
 * Strict means all or nothing. One malformed entry (no text, an amount that is
 * no number, a kind outside the list) voids the whole list: a receipt with
 * half its lines would add up wrong and look read, which is worse than a
 * receipt that says its lines were not read.
 */

import { isPurchaseKind, type PurchaseKind } from './kinds';

/** One line as it is stored: amounts in cents of the receipt's currency. */
export interface ReceiptLine {
  text: string;
  /** How many, as printed; null when the line prints no quantity. */
  quantity: number | null;
  unitPriceCents: number | null;
  /** What the line cost with its tax: negative for a discount, a returned deposit or an amount deducted. As printed, unless the line is priced before tax (`netCents`). */
  grossCents: number;
  /** The net amount, where the document states the line before tax (an electronic invoice, an invoice that adds the tax at the end, see `priceLines`); null otherwise. */
  netCents: number | null;
  taxRate: number | null;
  kind: PurchaseKind;
}

/** How many lines one receipt may have; a longer list is no receipt read line by line. */
export const MAX_LINES = 300;
const MAX_TEXT = 200;
const MAX_AMOUNT = 1_000_000;

/** The lines may differ from the total by this much (rounding on a till receipt) and still add up. */
export const ADD_UP_TOLERANCE_CENTS = 2;

const cents = (value: number) => Math.round(value * 100);

function amountCents(value: unknown, { nullable }: { nullable: boolean }): number | null | undefined {
  if (value === null || value === undefined) return nullable ? null : undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > MAX_AMOUNT) return undefined;
  return cents(value);
}

/**
 * The model's `items` array as lines, or null when it is missing or any entry
 * is malformed. An empty array is an answer: the document shows no lines.
 */
export function parseModelLines(raw: unknown): ReceiptLine[] | null {
  if (!Array.isArray(raw) || raw.length > MAX_LINES) return null;
  const lines: ReceiptLine[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
    const e = entry as Record<string, unknown>;
    const text = typeof e.text === 'string' ? e.text.replace(/\s+/g, ' ').trim() : '';
    if (text.length === 0 || text.length > MAX_TEXT) return null;
    const grossCents = amountCents(e.gross, { nullable: false });
    if (grossCents === undefined || grossCents === null) return null;
    const unitPriceCents = amountCents(e.unitPrice, { nullable: true });
    if (unitPriceCents === undefined) return null;
    let quantity: number | null = null;
    if (e.quantity !== null && e.quantity !== undefined) {
      if (typeof e.quantity !== 'number' || !Number.isFinite(e.quantity) || e.quantity === 0 || Math.abs(e.quantity) > 100_000) return null;
      // A negative quantity is printed only for money back: returned bottles ("-6 x 0,25"), a cancelled item.
      if (e.quantity < 0 && e.kind !== 'deposit_discount') return null;
      quantity = Math.round(e.quantity * 1000) / 1000;
    }
    let taxRate: number | null = null;
    if (e.taxRate !== null && e.taxRate !== undefined) {
      if (typeof e.taxRate !== 'number' || !Number.isFinite(e.taxRate) || e.taxRate < 0 || e.taxRate > 100) return null;
      taxRate = e.taxRate;
    }
    if (!isPurchaseKind(e.kind)) return null;
    lines.push({ text, quantity, unitPriceCents, grossCents, netCents: null, taxRate, kind: e.kind });
  }
  return lines;
}

export const sumGrossCents = (lines: readonly Pick<ReceiptLine, 'grossCents'>[]) => lines.reduce((sum, l) => sum + l.grossCents, 0);

/** What the receipt's row says, in the receipt's currency and in its units (euros, dollars), as the cells hold them. */
export interface ReceiptTotals {
  gross: number | null;
  /** The row's net total ("Net"). */
  net: number | null;
  /** A tip the row holds apart from its gross ("Tip", a meal): the gross does not include it. */
  tip: number | null;
}

/** How the lines stand against the receipt: their sum, the difference to the total, and whether that is within the tolerance. */
export interface LinesCheck {
  sumCents: number;
  totalCents: number;
  /** Lines minus total: positive when the lines say more than the receipt. */
  differenceCents: number;
  addsUp: boolean;
  /** 'gross' against the receipt's total; 'net' against its net total, for lines priced before tax (an electronic invoice, an invoice that adds the tax at the end). */
  basis: 'gross' | 'net';
  /** The row's tip, counted in `totalCents` because the lines include it; 0 when none is. */
  tipCents: number;
}

const centsOf = (value: number | null | undefined) => (value === null || value === undefined || !Number.isFinite(value) ? null : cents(value));
const withinTolerance = (differenceCents: number) => Math.abs(differenceCents) <= ADD_UP_TOLERANCE_CENTS;

function measured(sumCents: number, totalCents: number, basis: LinesCheck['basis'], tipCents = 0): LinesCheck {
  const differenceCents = sumCents - totalCents;
  return { sumCents, totalCents, differenceCents, addsUp: withinTolerance(differenceCents), basis, tipCents };
}

/**
 * Check stored lines against the receipt as it is now, so a corrected total
 * shows its difference (or ends it) at once. Null when there is nothing to
 * check against (no lines, no total). In this order:
 *
 *  1. Lines whose net sum is stored are checked on net: an electronic
 *     invoice's against its own net total (its gross is rounded per line, and
 *     on twenty lines that rounding alone can exceed the tolerance), a printed
 *     invoice priced before tax against the row's net.
 *  2. Otherwise the lines' sum against the row's gross.
 *  3. A row with a tip holds it apart from its gross (the meal's "Tip"). A tip
 *     printed as a line of its own is one of the lines, so lines that miss the
 *     gross and match the gross plus the tip add up, with the tip counted; a
 *     receipt whose lines carry no tip line matched the gross in step 2. The
 *     rule is the arithmetic only, never the line's wording: the review list
 *     checks from the reading record, which keeps no line's text.
 *  4. Lines stored before prices before tax were told apart (their printed net
 *     amounts taken as gross) add up when their sum matches the row's net and
 *     not its gross. `repriceStoredLines` gives them their gross.
 *
 * When none of these adds up, the difference against the gross is reported.
 */
export function checkLines(reading: { lineCount: number; linesSumCents: number | null; linesNetCents: number | null; totalNetCents: number | null }, totals: ReceiptTotals): LinesCheck | null {
  if (reading.lineCount === 0) return null;
  const netCents = centsOf(totals.net);
  if (reading.linesNetCents !== null) {
    const totalNetCents = reading.totalNetCents ?? netCents;
    if (totalNetCents !== null) return measured(reading.linesNetCents, totalNetCents, 'net');
  }
  const grossCents = centsOf(totals.gross);
  if (reading.linesSumCents === null || grossCents === null) return null;
  const onGross = measured(reading.linesSumCents, grossCents, 'gross');
  if (onGross.addsUp) return onGross;
  const tipCents = centsOf(totals.tip);
  if (tipCents !== null && tipCents > 0) {
    const withTip = measured(reading.linesSumCents, grossCents + tipCents, 'gross', tipCents);
    if (withTip.addsUp) return withTip;
  }
  if (reading.linesNetCents === null && netCents !== null) {
    const onNet = measured(reading.linesSumCents, netCents, 'net');
    if (onNet.addsUp) return onNet;
  }
  return onGross;
}

/** The row's figures a reading is priced with: its totals and its single tax rate ("Tax Rate", the one that carries most of the bill). */
export interface PricingTotals extends ReceiptTotals {
  taxRate: number | null;
}

export interface PricedLines {
  lines: ReceiptLine[];
  /** The lines' net sum, for lines priced before tax; null when their printed amounts are gross. */
  linesNetCents: number | null;
}

/** Where the cents of rounding go: the line with the largest amount (the first of equal ones). */
function largestAt(amounts: readonly number[]): number {
  let at = 0;
  for (let i = 1; i < amounts.length; i++) if (Math.abs(amounts[i]) > Math.abs(amounts[at])) at = i;
  return at;
}

function withRemainder(amounts: readonly number[], totalCents: number): number[] {
  const out = [...amounts];
  out[largestAt(out)] += totalCents - out.reduce((sum, a) => sum + a, 0);
  return out;
}

/**
 * The gross of lines printed before tax, in cents, or null when no rate is
 * known for them. Each line's own rate first, else the row's rate: per line,
 * net plus its tax rounded to the cent. Where that misses the row's gross only
 * by rounding (at most a cent a line), the remainder goes to the largest line,
 * so the lines add up to the gross exactly. A larger gap is no rounding but a
 * wrong rate (a receipt with two rates whose lines name none) or a wrong line:
 * where the net lines add up to the row's net, the row's own ratio of gross to
 * net prices them (right in sum for any mix of rates), the remainder again on
 * the largest line; otherwise the per-line gross stands with its gap, so the
 * check still shows it.
 */
function grossFromNet(lines: readonly ReceiptLine[], totals: PricingTotals): number[] | null {
  const nets = lines.map((l) => l.grossCents);
  const netSum = sumGrossCents(lines);
  const grossCents = centsOf(totals.gross);
  const netCents = centsOf(totals.net);
  const rates = lines.map((l) => l.taxRate ?? totals.taxRate);
  const byRate = rates.every((r): r is number => r !== null) ? nets.map((n, i) => n + Math.round((n * rates[i]!) / 100)) : null;
  const byRatio = (gross: number, net: number) => nets.map((n) => Math.round((n * gross) / net));
  if (grossCents !== null) {
    if (byRate && Math.abs(grossCents - byRate.reduce((sum, g) => sum + g, 0)) <= lines.length) return withRemainder(byRate, grossCents);
    if (netCents !== null && netSum !== 0 && withinTolerance(netSum - netCents)) return withRemainder(byRatio(grossCents, netSum), grossCents);
  }
  if (byRate) return byRate;
  if (grossCents !== null && netCents !== null && netCents !== 0) return byRatio(grossCents, netCents);
  return null;
}

/**
 * Settle what a reading's printed amounts are: gross (a till receipt) or net
 * (an invoice that prints its positions before tax and adds the tax once at
 * the end). Pure; `lines` carry their printed amounts in `grossCents`.
 *
 * The row's figures decide first, the model's word only where they say
 * nothing: lines that add up to the gross (with the tip rule of `checkLines`)
 * are gross whatever the model said, so nothing is taxed twice; lines that add
 * up to the row's net and not its gross are net; lines that add up to neither
 * are net only when the model said the document prints its positions before
 * tax (`pricesNet`). Net lines keep the printed amount in `netCents` and get
 * their gross from `grossFromNet`, so every reader of `grossCents` (the
 * overview's kinds, a receipt's lines) sees what was paid. Lines without a
 * known rate on a row that names none keep their printed amounts.
 */
export function priceLines(lines: readonly ReceiptLine[], totals: PricingTotals, pricesNet: boolean | null): PricedLines {
  const asPrinted: PricedLines = { lines: lines.map((l) => ({ ...l, netCents: null })), linesNetCents: null };
  if (lines.length === 0) return asPrinted;
  const sumCents = sumGrossCents(lines);
  if (checkLines({ lineCount: lines.length, linesSumCents: sumCents, linesNetCents: null, totalNetCents: null }, { ...totals, net: null })?.addsUp) return asPrinted;
  const netCents = centsOf(totals.net);
  const onNet = netCents !== null && withinTolerance(sumCents - netCents);
  if (!onNet && pricesNet !== true) return asPrinted;
  const gross = grossFromNet(lines, totals);
  if (!gross) return asPrinted;
  return { lines: lines.map((l, i) => ({ ...l, netCents: l.grossCents, grossCents: gross[i] })), linesNetCents: sumCents };
}

/** A shop as the kind answers are remembered: case, spaces and punctuation do not count. */
export function vendorKey(vendor: string | null | undefined): string {
  return (vendor ?? '').toLocaleLowerCase('de-DE').replace(/[^\p{L}\p{N}]+/gu, '');
}

/** A line's text as the kind answers are remembered: case, punctuation and repeated spaces do not count. */
export function textKey(text: string): string {
  return text.toLocaleLowerCase('de-DE').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}
