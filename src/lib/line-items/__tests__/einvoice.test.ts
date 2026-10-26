import { describe, expect, it } from 'vitest';
import { readInvoiceXml } from '@/lib/einvoice/parse';
import { structuredReceiptFields } from '@/lib/einvoice';
import { CII_INVOICE_WITH_LINES, UBL_CREDIT_NOTE, UBL_INVOICE, UBL_INVOICE_WITH_LINES } from '@/lib/einvoice/__tests__/samples';
import { linesFromInvoice } from '../einvoice';
import { checkLines, type ReceiptLine } from '../lines';

const fields = (xml: string) => structuredReceiptFields(readInvoiceXml(xml)!);

describe('the lines of an electronic invoice, from its XML (forward)', () => {
  it('reads the UBL lines with quantity, net price and rate, and the document discount and shipping as lines of their own', () => {
    const invoice = readInvoiceXml(UBL_INVOICE_WITH_LINES)!;
    expect(invoice.problems).toEqual([]);
    expect(invoice.lines).toEqual([
      { name: 'Lizenz Pro', quantity: 2, unitPriceCents: 5000, netCents: 10000, ratePercent: 19 },
      { name: 'Handbuch', quantity: 1, unitPriceCents: 5000, netCents: 5000, ratePercent: 7 },
    ]);
    expect(invoice.allowanceCharges).toEqual([
      { charge: false, reason: 'Treuerabatt', netCents: 1000, ratePercent: 19 },
      { charge: true, reason: 'Versand', netCents: 500, ratePercent: 19 },
    ]);
    const result = linesFromInvoice(fields(UBL_INVOICE_WITH_LINES), null)!;
    expect(result.lines.map((l) => [l.text, l.netCents, l.grossCents, l.kind])).toEqual([
      ['Lizenz Pro', 10000, 11900, 'other'],
      ['Handbuch', 5000, 5350, 'other'],
      ['Treuerabatt', -1000, -1190, 'deposit_discount'],
      ['Versand', 500, 595, 'shipping'],
    ]);
    expect(result).toMatchObject({ linesNetCents: 14500, totalNetCents: 14500 });
    // Checked on net: the lines add up to the invoice.
    expect(checkLines({ lineCount: 4, linesSumCents: 16655, linesNetCents: result.linesNetCents, totalNetCents: result.totalNetCents }, 166.55)).toMatchObject({ basis: 'net', addsUp: true });
  });

  it('reads the CII lines', () => {
    const result = linesFromInvoice(fields(CII_INVOICE_WITH_LINES), null)!;
    expect(result.lines.map((l) => [l.text, l.quantity, l.unitPriceCents, l.netCents, l.grossCents, l.taxRate])).toEqual([
      ['Hosting M', 1, 12000, 12000, 14280, 19],
      ['Domain .de', 2, 4000, 8000, 9520, 19],
    ]);
    expect(result).toMatchObject({ linesNetCents: 20000, totalNetCents: 20000 });
  });

  it('lists the positions in the receipt text, so the model reading it names what was bought', () => {
    expect(fields(UBL_INVOICE_WITH_LINES).text).toContain('2 x Lizenz Pro: netto 100.00 EUR (19 %)');
    expect(fields(UBL_INVOICE_WITH_LINES).text).toContain('Nachlass Treuerabatt: netto 10.00 EUR');
  });

  it('takes the kind of the model line with the same text, else of the line at the same place', () => {
    const model = (text: string, kind: ReceiptLine['kind']): ReceiptLine => ({ text, quantity: null, unitPriceCents: null, grossCents: 0, netCents: null, taxRate: null, kind });
    const byText = linesFromInvoice(fields(CII_INVOICE_WITH_LINES), [model('domain  .DE', 'software_services'), model('Hosting-M', 'software_services'), model('extra', 'other')])!;
    expect(byText.lines.map((l) => l.kind)).toEqual(['software_services', 'software_services']);
    const byPlace = linesFromInvoice(fields(CII_INVOICE_WITH_LINES), [model('Server', 'software_services'), model('Name', 'electronics')])!;
    expect(byPlace.lines.map((l) => l.kind)).toEqual(['software_services', 'electronics']);
  });

  it('says when the XML lines do not reach the net total', () => {
    const partial = linesFromInvoice(fields(UBL_INVOICE), null)!;
    expect(partial).toMatchObject({ linesNetCents: 10000, totalNetCents: 15000 });
    expect(checkLines({ lineCount: 1, linesSumCents: 10000, linesNetCents: partial.linesNetCents, totalNetCents: partial.totalNetCents }, 172.5)).toMatchObject({ addsUp: false, differenceCents: -5000 });
  });

  it('has no lines for an invoice whose XML lists none: the reading of the page gives them', () => {
    expect(linesFromInvoice(fields(UBL_CREDIT_NOTE), null)).toBeNull();
  });

  it('keeps the stated signs of an invoice with negative amounts, and of a credit note with negative amounts', () => {
    const negate = (xml: string) => xml.replace(/>(\d+\.\d{2})</g, '>-$1<');
    const refund = linesFromInvoice(fields(negate(CII_INVOICE_WITH_LINES)), null)!;
    expect(fields(negate(CII_INVOICE_WITH_LINES)).creditNote).toBe(true);
    expect(refund).toMatchObject({ linesNetCents: -20000, totalNetCents: -20000 });
    const charge = negate(UBL_INVOICE_WITH_LINES.replace('<cbc:InvoiceTypeCode>380</cbc:InvoiceTypeCode>', '<cbc:InvoiceTypeCode>381</cbc:InvoiceTypeCode>'));
    expect(fields(charge).creditNote).toBe(false);
    expect(linesFromInvoice(fields(charge), null)!.lines.slice(0, 2).map((l) => l.netCents)).toEqual([10000, 5000]);
  });

  it('signs a credit note negative, like the receipt it is stored as', () => {
    const credit = UBL_INVOICE_WITH_LINES.replace('<cbc:InvoiceTypeCode>380</cbc:InvoiceTypeCode>', '<cbc:InvoiceTypeCode>381</cbc:InvoiceTypeCode>');
    const result = linesFromInvoice(fields(credit), null)!;
    expect(result.lines.map((l) => l.netCents)).toEqual([-10000, -5000, 1000, -500]);
    expect(result).toMatchObject({ linesNetCents: -14500, totalNetCents: -14500 });
  });
});
