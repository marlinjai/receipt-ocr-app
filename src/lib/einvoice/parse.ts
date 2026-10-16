/**
 * The figures of an electronic invoice, read from its structured data: an
 * XRechnung in UBL syntax (root `Invoice` or `CreditNote`) or in CII syntax
 * (root `CrossIndustryInvoice`, also the XML inside a ZUGFeRD or Factur-X
 * PDF). Decision D8 of the invoicing plan: these figures are the invoice, so
 * they take precedence over anything read from the page. Pure.
 *
 * Money is kept in cents, parsed from the decimal text exactly (no floating
 * point on the way). What does not add up is reported in `problems`, never
 * corrected silently.
 */

import { child, children, parseXml, textAt, XmlError, type XmlElement } from './xml';

export interface StructuredTaxGroup {
  /** Percent, as stated (19, 7, 0). */
  ratePercent: number;
  /** The tax category code of EN 16931: S standard, Z zero, E exempt, AE reverse charge, K intra-community, G export, O outside scope. */
  category: string | null;
  netCents: number;
  taxCents: number;
}

export interface StructuredInvoice {
  syntax: 'ubl' | 'cii';
  /** The specification the issuer names (an XRechnung or a ZUGFeRD profile), as stated. */
  specification: string | null;
  kind: 'invoice' | 'credit_note';
  /** The type code as stated (380 invoice, 381 credit note, 384 corrected invoice, ...). */
  typeCode: string | null;
  number: string | null;
  /** ISO day. */
  issueDate: string | null;
  dueDate: string | null;
  currency: string | null;
  seller: { name: string | null; vatId: string | null; taxNumber: string | null };
  /** Sum of the net amounts the tax is computed on. */
  netCents: number | null;
  taxCents: number | null;
  /** The invoice total including tax. */
  grossCents: number | null;
  /** What is still to be paid: the total minus what was prepaid, plus rounding. */
  payableCents: number | null;
  taxGroups: StructuredTaxGroup[];
  /** Figures that do not add up, in plain words; empty when the invoice is consistent. */
  problems: string[];
}

/** Cents from a decimal text ("1234.5", "-12.345"), rounded half away from zero; null when it is no number. */
export function centsOf(text: string | null): number | null {
  if (text === null) return null;
  const match = /^([+-]?)(\d+)(?:\.(\d+))?$/.exec(text.trim());
  if (!match) return null;
  const [, sign, whole, fraction = ''] = match;
  const padded = (fraction + '000').slice(0, 3);
  let cents = Number(whole) * 100 + Number(padded.slice(0, 2));
  if (Number(padded[2]) >= 5) cents += 1;
  return sign === '-' ? -cents : cents;
}

function percentOf(text: string | null): number | null {
  if (text === null) return null;
  const value = Number(text.trim());
  return Number.isFinite(value) ? value : null;
}

/** ISO day from "2026-10-15" (UBL) or "20261015" with format 102 (CII). */
function dayOf(text: string | null): string | null {
  if (text === null) return null;
  const t = text.trim();
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(t) ?? /^(\d{4})(\d{2})(\d{2})$/.exec(t);
  if (!iso) return null;
  const day = `${iso[1]}-${iso[2]}-${iso[3]}`;
  const parsed = new Date(`${day}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === day ? day : null;
}

const CREDIT_NOTE_CODES = new Set(['381', '261', '262', '296', '308', '396', '420', '458', '532']);

function check(invoice: StructuredInvoice): string[] {
  const problems: string[] = [];
  const { netCents, taxCents, grossCents, taxGroups } = invoice;
  if (grossCents === null) problems.push('Kein Rechnungsbetrag angegeben.');
  if (netCents !== null && taxCents !== null && grossCents !== null && netCents + taxCents !== grossCents) {
    problems.push('Netto und Steuer ergeben nicht den Rechnungsbetrag.');
  }
  if (taxGroups.length > 0) {
    const groupNet = taxGroups.reduce((s, g) => s + g.netCents, 0);
    const groupTax = taxGroups.reduce((s, g) => s + g.taxCents, 0);
    if (netCents !== null && groupNet !== netCents) problems.push('Die Steuergruppen ergeben nicht den Nettobetrag.');
    if (taxCents !== null && groupTax !== taxCents) problems.push('Die Steuergruppen ergeben nicht die Steuer.');
    // One cent of rounding per group is what EN 16931 allows between the computed and the stated tax.
    for (const g of taxGroups) {
      if (Math.abs(Math.round((g.netCents * g.ratePercent) / 100) - g.taxCents) > 1) problems.push(`Die Steuer der Gruppe ${g.ratePercent} % passt nicht zu ihrem Satz.`);
    }
  }
  if (invoice.number === null) problems.push('Keine Rechnungsnummer angegeben.');
  if (invoice.issueDate === null) problems.push('Kein gültiges Rechnungsdatum angegeben.');
  return problems;
}

/** The tax amount in the invoice currency: an invoice may state it a second time in another tax currency. */
function amountInCurrency(elements: XmlElement[], currency: string | null): string | null {
  const own = elements.find((e) => currency !== null && e.attributes.currencyID === currency) ?? elements[0];
  const value = own?.text.trim() ?? '';
  return value === '' ? null : value;
}

function readUbl(root: XmlElement): StructuredInvoice {
  const creditNote = root.name === 'CreditNote';
  const currency = textAt(root, 'DocumentCurrencyCode');
  const party = child(root, 'AccountingSupplierParty', 'Party');
  const schemes = children(party, 'PartyTaxScheme');
  const scheme = (id: string) => textAt(schemes.find((s) => textAt(s, 'TaxScheme', 'ID') === id), 'CompanyID');
  const totals = child(root, 'LegalMonetaryTotal');
  const taxTotals = children(root, 'TaxTotal');
  const taxTotal = taxTotals.find((t) => currency !== null && child(t, 'TaxAmount')?.attributes.currencyID === currency) ?? taxTotals[0] ?? null;
  const typeCode = textAt(root, creditNote ? 'CreditNoteTypeCode' : 'InvoiceTypeCode');
  const groups: StructuredTaxGroup[] = children(taxTotal, 'TaxSubtotal').map((s) => ({
    ratePercent: percentOf(textAt(s, 'TaxCategory', 'Percent')) ?? 0,
    category: textAt(s, 'TaxCategory', 'ID'),
    netCents: centsOf(textAt(s, 'TaxableAmount')) ?? 0,
    taxCents: centsOf(textAt(s, 'TaxAmount')) ?? 0,
  }));
  const invoice: StructuredInvoice = {
    syntax: 'ubl',
    specification: textAt(root, 'CustomizationID'),
    kind: creditNote || (typeCode !== null && CREDIT_NOTE_CODES.has(typeCode)) ? 'credit_note' : 'invoice',
    typeCode,
    number: textAt(root, 'ID'),
    issueDate: dayOf(textAt(root, 'IssueDate')),
    dueDate: dayOf(textAt(root, 'DueDate') ?? textAt(root, 'PaymentMeans', 'PaymentDueDate')),
    currency,
    seller: {
      name: textAt(party, 'PartyLegalEntity', 'RegistrationName') ?? textAt(party, 'PartyName', 'Name'),
      vatId: scheme('VAT'),
      taxNumber: scheme('FC'),
    },
    netCents: centsOf(textAt(totals, 'TaxExclusiveAmount')),
    taxCents: centsOf(amountInCurrency(children(taxTotal, 'TaxAmount'), currency)),
    grossCents: centsOf(textAt(totals, 'TaxInclusiveAmount')),
    payableCents: centsOf(textAt(totals, 'PayableAmount')),
    taxGroups: groups,
    problems: [],
  };
  return invoice;
}

function readCii(root: XmlElement): StructuredInvoice {
  const document = child(root, 'ExchangedDocument');
  const transaction = child(root, 'SupplyChainTradeTransaction');
  const seller = child(transaction, 'ApplicableHeaderTradeAgreement', 'SellerTradeParty');
  const registrations = children(seller, 'SpecifiedTaxRegistration');
  const registration = (scheme: string) => textAt(registrations.find((r) => child(r, 'ID')?.attributes.schemeID === scheme), 'ID');
  const settlement = child(transaction, 'ApplicableHeaderTradeSettlement');
  const currency = textAt(settlement, 'InvoiceCurrencyCode');
  const summary = child(settlement, 'SpecifiedTradeSettlementHeaderMonetarySummation');
  const typeCode = textAt(document, 'TypeCode');
  const groups: StructuredTaxGroup[] = children(settlement, 'ApplicableTradeTax').map((t) => ({
    ratePercent: percentOf(textAt(t, 'RateApplicablePercent')) ?? 0,
    category: textAt(t, 'CategoryCode'),
    netCents: centsOf(textAt(t, 'BasisAmount')) ?? 0,
    taxCents: centsOf(textAt(t, 'CalculatedAmount')) ?? 0,
  }));
  return {
    syntax: 'cii',
    specification: textAt(root, 'ExchangedDocumentContext', 'GuidelineSpecifiedDocumentContextParameter', 'ID'),
    kind: typeCode !== null && CREDIT_NOTE_CODES.has(typeCode) ? 'credit_note' : 'invoice',
    typeCode,
    number: textAt(document, 'ID'),
    issueDate: dayOf(textAt(document, 'IssueDateTime', 'DateTimeString')),
    dueDate: dayOf(textAt(settlement, 'SpecifiedTradePaymentTerms', 'DueDateDateTime', 'DateTimeString')),
    currency,
    seller: { name: textAt(seller, 'Name'), vatId: registration('VA'), taxNumber: registration('FC') },
    netCents: centsOf(textAt(summary, 'TaxBasisTotalAmount')),
    taxCents: centsOf(amountInCurrency(children(summary, 'TaxTotalAmount'), currency)),
    grossCents: centsOf(textAt(summary, 'GrandTotalAmount')),
    payableCents: centsOf(textAt(summary, 'DuePayableAmount')),
    taxGroups: groups,
    problems: [],
  };
}

/**
 * Read an electronic invoice from its XML text. Null when the text is no XML
 * the reader accepts, or XML of another kind (an order, a delivery note).
 */
export function readInvoiceXml(xml: string): StructuredInvoice | null {
  let root: XmlElement;
  try {
    root = parseXml(xml);
  } catch (error) {
    if (error instanceof XmlError || error instanceof RangeError) return null;
    throw error;
  }
  let invoice: StructuredInvoice;
  if (root.name === 'Invoice' || root.name === 'CreditNote') invoice = readUbl(root);
  else if (root.name === 'CrossIndustryInvoice') invoice = readCii(root);
  else return null;
  invoice.problems = check(invoice);
  return invoice;
}
