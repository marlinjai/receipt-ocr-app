/**
 * A receipt's lines as plain data: the strict reading of the model's answer,
 * the check that the lines add up to the receipt's total, and the keys a
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
  /** What the line cost, as printed: negative for a discount or a returned deposit. */
  grossCents: number;
  /** The net amount, where the source states one (an electronic invoice); null from a printed receipt. */
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

/** How the lines stand against the receipt: their sum, the difference to the total, and whether that is within the tolerance. */
export interface LinesCheck {
  sumCents: number;
  totalCents: number;
  /** Lines minus total: positive when the lines say more than the receipt. */
  differenceCents: number;
  addsUp: boolean;
  /** 'gross' for a printed receipt; 'net' for an electronic invoice, whose lines are net amounts. */
  basis: 'gross' | 'net';
}

/**
 * Check stored lines against the receipt as it is now. A printed receipt's
 * lines are checked against the total the row holds (a corrected total shows
 * its difference at once); an electronic invoice's against its own net total,
 * because its lines are net amounts and their gross is rounded per line. Null
 * when there is nothing to check against (no lines, no total).
 */
export function checkLines(reading: { lineCount: number; linesSumCents: number | null; linesNetCents: number | null; totalNetCents: number | null }, totalGross: number | null): LinesCheck | null {
  if (reading.lineCount === 0) return null;
  if (reading.linesNetCents !== null && reading.totalNetCents !== null) {
    const differenceCents = reading.linesNetCents - reading.totalNetCents;
    return { sumCents: reading.linesNetCents, totalCents: reading.totalNetCents, differenceCents, addsUp: Math.abs(differenceCents) <= ADD_UP_TOLERANCE_CENTS, basis: 'net' };
  }
  if (reading.linesSumCents === null || totalGross === null || !Number.isFinite(totalGross)) return null;
  const totalCents = cents(totalGross);
  const differenceCents = reading.linesSumCents - totalCents;
  return { sumCents: reading.linesSumCents, totalCents, differenceCents, addsUp: Math.abs(differenceCents) <= ADD_UP_TOLERANCE_CENTS, basis: 'gross' };
}

/** A shop as the kind answers are remembered: case, spaces and punctuation do not count. */
export function vendorKey(vendor: string | null | undefined): string {
  return (vendor ?? '').toLocaleLowerCase('de-DE').replace(/[^\p{L}\p{N}]+/gu, '');
}

/** A line's text as the kind answers are remembered: case, punctuation and repeated spaces do not count. */
export function textKey(text: string): string {
  return text.toLocaleLowerCase('de-DE').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}
