/**
 * Electronic invoices received (decision D8 of the invoicing plan,
 * docs/plans/2026-10-14-invoicing-and-income.md): an XRechnung arrives as an
 * XML file with no page to read, a ZUGFeRD or Factur-X invoice as a PDF with
 * the same XML inside. Their figures are read from that XML, and they take
 * precedence over text recognition and the language model: the structured
 * data is the invoice, the page is only its picture.
 *
 * This is the entry point the upload and the expenses mailbox call with a
 * file's bytes before anything is recognized. It returns null for every
 * ordinary receipt, which is then read as before.
 */

import type { TaxGroup } from '@/lib/extraction/amounts';
import { embeddedInvoiceXml } from './pdf';
import { readInvoiceXml, type StructuredInvoice } from './parse';

export type { StructuredInvoice, StructuredTaxGroup } from './parse';

export interface StructuredReading {
  /** Where the XML came from: the file itself, or the file embedded in a PDF (its name). */
  source: { kind: 'xml' } | { kind: 'pdf_embedded'; name: string };
  invoice: StructuredInvoice;
  /** The XML as received, to keep with the receipt as the original. */
  xml: string;
}

/** The receipt's fields as the structured invoice states them, in the shapes the receipt row stores. */
export interface StructuredReceiptFields {
  vendor: string | null;
  /** ISO 8601 instant of the invoice day (midnight UTC), as the text reader gives it. */
  date: string | null;
  /** Total including tax, in currency units; positive for a credit note too (`creditNote` says which). */
  gross: number | null;
  net: number | null;
  /** The rate of the group with the largest net amount; null when the invoice states no group. */
  taxRate: number | null;
  /** Every tax group, largest net first, in the text reader's shape. */
  taxGroups: TaxGroup[];
  currency: string | null;
  invoiceNumber: string | null;
  creditNote: boolean;
  /** Figures that do not add up, for the review list; empty when consistent. */
  problems: string[];
  /** A plain text of the figures, for the receipt's text column and its search. */
  text: string;
}

const looksLikeXml = (bytes: Uint8Array) => {
  const head = new TextDecoder('utf-8').decode(bytes.subarray(0, 200)).replace(/^﻿/, '').trimStart();
  return head.startsWith('<?xml') || head.startsWith('<');
};
const looksLikePdf = (bytes: Uint8Array) => bytes.length > 4 && String.fromCharCode(...bytes.subarray(0, 5)) === '%PDF-';

/**
 * Read a received file as an electronic invoice. XML is recognized by its
 * content (an issuer may send "rechnung.txt" or "invoice" without suffix), a
 * PDF by its signature; the name and the media type are only hints.
 */
export async function readStructuredInvoice(bytes: Uint8Array): Promise<StructuredReading | null> {
  if (looksLikePdf(bytes)) {
    const embedded = await embeddedInvoiceXml(bytes);
    if (!embedded) return null;
    const invoice = readInvoiceXml(embedded.xml);
    return invoice ? { source: { kind: 'pdf_embedded', name: embedded.name }, invoice, xml: embedded.xml } : null;
  }
  if (!looksLikeXml(bytes)) return null;
  const xml = new TextDecoder('utf-8').decode(bytes);
  const invoice = readInvoiceXml(xml);
  return invoice ? { source: { kind: 'xml' }, invoice, xml } : null;
}

const units = (cents: number | null) => (cents === null ? null : Math.abs(cents) / 100);
const amountText = (cents: number | null, currency: string | null) => (cents === null ? '' : `${(cents / 100).toFixed(2)} ${currency ?? ''}`.trim());

/** The receipt's fields from a structured invoice. */
export function structuredReceiptFields(invoice: StructuredInvoice): StructuredReceiptFields {
  const groups = [...invoice.taxGroups].sort((a, b) => Math.abs(b.netCents) - Math.abs(a.netCents));
  const text = [
    invoice.kind === 'credit_note' ? 'Gutschrift (elektronisch)' : 'Rechnung (elektronisch)',
    invoice.seller.name ? `Verkäufer: ${invoice.seller.name}` : '',
    invoice.seller.vatId ? `USt-IdNr.: ${invoice.seller.vatId}` : '',
    invoice.seller.taxNumber ? `Steuernummer: ${invoice.seller.taxNumber}` : '',
    invoice.number ? `Rechnungsnummer: ${invoice.number}` : '',
    invoice.issueDate ? `Rechnungsdatum: ${invoice.issueDate}` : '',
    invoice.dueDate ? `Fällig: ${invoice.dueDate}` : '',
    ...groups.map((g) => `Steuer ${g.ratePercent} % (${g.category ?? '?'}): netto ${amountText(g.netCents, invoice.currency)}, Steuer ${amountText(g.taxCents, invoice.currency)}`),
    invoice.netCents !== null ? `Netto: ${amountText(invoice.netCents, invoice.currency)}` : '',
    invoice.taxCents !== null ? `Steuer: ${amountText(invoice.taxCents, invoice.currency)}` : '',
    invoice.grossCents !== null ? `Gesamt: ${amountText(invoice.grossCents, invoice.currency)}` : '',
    invoice.payableCents !== null && invoice.payableCents !== invoice.grossCents ? `Zu zahlen: ${amountText(invoice.payableCents, invoice.currency)}` : '',
  ].filter(Boolean);
  return {
    vendor: invoice.seller.name,
    date: invoice.issueDate ? `${invoice.issueDate}T00:00:00.000Z` : null,
    gross: units(invoice.grossCents),
    net: units(invoice.netCents),
    taxRate: groups[0]?.ratePercent ?? null,
    taxGroups: groups.map((g) => ({ rate: g.ratePercent, net: Math.abs(g.netCents) / 100, tax: Math.abs(g.taxCents) / 100, gross: Math.abs(g.netCents + g.taxCents) / 100 })),
    currency: invoice.currency,
    invoiceNumber: invoice.number,
    creditNote: invoice.kind === 'credit_note',
    problems: invoice.problems,
    text: text.join('\n'),
  };
}
