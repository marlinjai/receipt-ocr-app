/**
 * The lines of an electronic invoice (XRechnung, ZUGFeRD, Factur-X), from its
 * XML instead of the page. Pure.
 *
 * EN 16931 states a line's amount net and the tax per group, so a line's gross
 * is its net plus its tax rounded per line, and the lines are checked against
 * the invoice's own net total, not the rounded gross against the total (on an
 * invoice of twenty lines the per-line rounding alone can exceed two cents).
 * Discounts and surcharges on the whole document are no lines in the XML but
 * count towards the net total: they become lines of their own.
 *
 * No model is asked for an XML line's kind. Where the reading of the same
 * receipt returned lines (the model reads the invoice's text, which lists the
 * positions), a line takes the kind of the model's line with the same text,
 * else of the line at the same place when both lists are equally long, else
 * "other"; a person's answer corrects it like any other.
 */

import type { StructuredReceiptFields } from '@/lib/einvoice';
import type { PurchaseKind } from './kinds';
import { textKey, type ReceiptLine } from './lines';

export interface InvoiceLines {
  lines: ReceiptLine[];
  /** The lines' net sum and the invoice's net total, in cents, signed like the receipt (negative for a credit note). */
  linesNetCents: number;
  totalNetCents: number | null;
}

const SHIPPING = /versand|fracht|porto|lieferung|shipping|delivery|freight/i;

function kindFor(name: string, index: number, count: number, modelLines: readonly ReceiptLine[] | null): PurchaseKind {
  if (!modelLines || modelLines.length === 0) return 'other';
  const key = textKey(name);
  const same = key ? modelLines.find((l) => textKey(l.text) === key) : undefined;
  if (same) return same.kind;
  return modelLines.length === count ? modelLines[index].kind : 'other';
}

/** The invoice's lines as receipt lines, or null when the XML states none (the reading's lines are used then). */
export function linesFromInvoice(fields: Pick<StructuredReceiptFields, 'lines' | 'allowanceCharges' | 'creditNote' | 'net'>, modelLines: readonly ReceiptLine[] | null): InvoiceLines | null {
  if (fields.lines.length === 0) return null;
  const sign = fields.creditNote ? -1 : 1;
  const withTax = (net: number, rate: number | null) => net + (rate === null ? 0 : Math.round((net * rate) / 100));
  const lines: ReceiptLine[] = fields.lines.map((l, i) => {
    const text = (l.name ?? '').replace(/\s+/g, ' ').trim().slice(0, 200) || `Position ${i + 1}`;
    return {
      text,
      quantity: l.quantity,
      unitPriceCents: l.unitPriceCents === null ? null : sign * l.unitPriceCents,
      grossCents: sign * withTax(l.netCents, l.ratePercent),
      netCents: sign * l.netCents,
      taxRate: l.ratePercent,
      kind: kindFor(text, i, fields.lines.length, modelLines),
    };
  });
  for (const a of fields.allowanceCharges) {
    const direction = (a.charge ? 1 : -1) * sign;
    const text = (a.reason ?? '').replace(/\s+/g, ' ').trim().slice(0, 200) || (a.charge ? 'Zuschlag' : 'Nachlass');
    lines.push({
      text,
      quantity: null,
      unitPriceCents: null,
      grossCents: direction * withTax(a.netCents, a.ratePercent),
      netCents: direction * a.netCents,
      taxRate: a.ratePercent,
      kind: a.charge && SHIPPING.test(text) ? 'shipping' : 'deposit_discount',
    });
  }
  const linesNetCents = lines.reduce((sum, l) => sum + (l.netCents ?? 0), 0);
  return { lines, linesNetCents, totalNetCents: fields.net === null ? null : sign * Math.round(Math.abs(fields.net) * 100) };
}
