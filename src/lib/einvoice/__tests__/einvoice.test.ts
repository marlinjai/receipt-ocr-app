import { describe, expect, it } from 'vitest';
import { readStructuredInvoice, structuredReceiptFields } from '../index';
import { centsOf, readInvoiceXml } from '../parse';
import { parseXml, XmlError } from '../xml';
import { CII_INVOICE, pdfWithEmbeddedXml, pdfWithLayout, UBL_CREDIT_NOTE, UBL_INVOICE } from './samples';

const bytes = (text: string) => new TextEncoder().encode(text);

describe('parseXml', () => {
  it('reads local names, attributes, entities and CDATA', () => {
    const root = parseXml('<?xml version="1.0"?><a:Root xmlns:a="x" b:k=\'v &amp; w\'><!-- c --><a:T>1 &lt; 2 &#x41;</a:T><a:U><![CDATA[<raw>]]></a:U><a:E/></a:Root>');
    expect(root.name).toBe('Root');
    expect(root.attributes.k).toBe('v & w');
    expect(root.children.map((c) => c.name)).toEqual(['T', 'U', 'E']);
    expect(root.children[0].text).toBe('1 < 2 A');
    expect(root.children[1].text).toBe('<raw>');
  });

  it('refuses a document type declaration, an unknown entity, and broken structure', () => {
    expect(() => parseXml('<!DOCTYPE x [<!ENTITY a "b">]><x>&a;</x>')).toThrow(XmlError);
    expect(() => parseXml('<x>&nbsp;</x>')).toThrow(XmlError);
    expect(() => parseXml('<x><y></x>')).toThrow(XmlError);
    expect(() => parseXml('<x></x><y></y>')).toThrow(XmlError);
    expect(() => parseXml('<x>')).toThrow(XmlError);
    expect(() => parseXml('nothing')).toThrow(XmlError);
  });
});

describe('centsOf', () => {
  it('reads decimal text exactly, rounding the third decimal half away from zero', () => {
    expect(centsOf('172.50')).toBe(17_250);
    expect(centsOf('0.1')).toBe(10);
    expect(centsOf('12.345')).toBe(1_235);
    expect(centsOf('-12.345')).toBe(-1_235);
    expect(centsOf('1,50')).toBeNull();
    expect(centsOf(null)).toBeNull();
  });
});

describe('readInvoiceXml', () => {
  it('reads an XRechnung in UBL syntax with two tax rates', () => {
    const invoice = readInvoiceXml(UBL_INVOICE);
    expect(invoice).toMatchObject({
      syntax: 'ubl',
      kind: 'invoice',
      number: 'BSP-2026-0042',
      issueDate: '2026-09-14',
      dueDate: '2026-09-28',
      currency: 'EUR',
      seller: { name: 'Muster Software GmbH', vatId: 'DE000000000', taxNumber: '00/000/00000' },
      netCents: 15_000,
      taxCents: 2_250,
      grossCents: 17_250,
      payableCents: 17_250,
      problems: [],
    });
    expect(invoice?.specification).toContain('xrechnung');
    expect(invoice?.taxGroups).toEqual([
      { ratePercent: 19, category: 'S', netCents: 10_000, taxCents: 1_900 },
      { ratePercent: 7, category: 'S', netCents: 5_000, taxCents: 350 },
    ]);
  });

  it('reads a UBL credit note as a credit note', () => {
    expect(readInvoiceXml(UBL_CREDIT_NOTE)).toMatchObject({ kind: 'credit_note', number: 'GS-7', grossCents: 1_190, problems: [] });
  });

  it('reads a CII invoice, its date in format 102 and what is still payable after a prepayment', () => {
    expect(readInvoiceXml(CII_INVOICE)).toMatchObject({
      syntax: 'cii',
      number: 'RE-2026-913',
      issueDate: '2026-10-02',
      dueDate: '2026-10-16',
      seller: { name: 'Beispiel Hosting AG', vatId: 'DE111111111', taxNumber: null },
      netCents: 20_000,
      taxCents: 3_800,
      grossCents: 23_800,
      payableCents: 18_800,
      taxGroups: [{ ratePercent: 19, category: 'S', netCents: 20_000, taxCents: 3_800 }],
      problems: [],
    });
  });

  it('reports figures that do not add up instead of correcting them', () => {
    const broken = UBL_INVOICE.replace('<cbc:TaxInclusiveAmount currencyID="EUR">172.50', '<cbc:TaxInclusiveAmount currencyID="EUR">180.00');
    expect(readInvoiceXml(broken)?.problems).toContain('Netto und Steuer ergeben nicht den Rechnungsbetrag.');
    const wrongRate = CII_INVOICE.replace('<ram:CalculatedAmount>38.00', '<ram:CalculatedAmount>30.00');
    expect(readInvoiceXml(wrongRate)?.problems).toEqual(expect.arrayContaining(['Die Steuer der Gruppe 19 % passt nicht zu ihrem Satz.']));
  });

  it('takes the tax in the invoice currency when it is stated twice', () => {
    const twice = UBL_INVOICE.replace('<cac:TaxTotal>', '<cac:TaxTotal><cbc:TaxAmount currencyID="USD">99.99</cbc:TaxAmount></cac:TaxTotal><cac:TaxTotal>');
    expect(readInvoiceXml(twice)?.taxCents).toBe(2_250);
  });

  it('is null for XML of another kind and for anything that is no XML', () => {
    expect(readInvoiceXml('<Order><ID>1</ID></Order>')).toBeNull();
    expect(readInvoiceXml('Rechnung 42')).toBeNull();
    expect(readInvoiceXml('<Invoice><ID>1</Invoice>')).toBeNull();
  });

  it('refuses an impossible date instead of rolling it over', () => {
    expect(readInvoiceXml(UBL_INVOICE.replace('2026-09-14', '2026-02-30'))).toMatchObject({ issueDate: null, problems: expect.arrayContaining(['Kein gültiges Rechnungsdatum angegeben.']) });
  });
});

describe('readStructuredInvoice', () => {
  it('reads an XRechnung file by its content, whatever its name', async () => {
    const reading = await readStructuredInvoice(bytes(UBL_INVOICE));
    expect(reading?.source).toEqual({ kind: 'xml' });
    expect(reading?.invoice.number).toBe('BSP-2026-0042');
    expect(reading?.xml).toBe(UBL_INVOICE);
  });

  it('reads the XML inside a Factur-X PDF and ignores what the page prints', async () => {
    const reading = await readStructuredInvoice(await pdfWithEmbeddedXml(CII_INVOICE));
    expect(reading?.source).toEqual({ kind: 'pdf_embedded', name: 'factur-x.xml' });
    expect(reading?.invoice.grossCents).toBe(23_800);
  });

  it('reads a ZUGFeRD PDF under its older file name', async () => {
    const reading = await readStructuredInvoice(await pdfWithEmbeddedXml(CII_INVOICE, 'ZUGFeRD-invoice.xml'));
    expect(reading?.source).toEqual({ kind: 'pdf_embedded', name: 'ZUGFeRD-invoice.xml' });
  });

  it('is null for an ordinary PDF, a PDF with other XML inside, an image and a broken file', async () => {
    expect(await readStructuredInvoice(await pdfWithEmbeddedXml(null))).toBeNull();
    expect(await readStructuredInvoice(await pdfWithEmbeddedXml('<Order/>', 'order.xml'))).toBeNull();
    expect(await readStructuredInvoice(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0]))).toBeNull();
    expect(await readStructuredInvoice(bytes('%PDF-1.7 broken'))).toBeNull();
  });
});

describe('structuredReceiptFields', () => {
  it('gives the receipt its fields from the structured data, largest tax group first', () => {
    const fields = structuredReceiptFields(readInvoiceXml(UBL_INVOICE)!);
    expect(fields).toMatchObject({
      vendor: 'Muster Software GmbH',
      date: '2026-09-14T00:00:00.000Z',
      gross: 172.5,
      net: 150,
      taxRate: 19,
      currency: 'EUR',
      invoiceNumber: 'BSP-2026-0042',
      creditNote: false,
      problems: [],
    });
    expect(fields.taxGroups).toEqual([
      { rate: 19, net: 100, tax: 19, gross: 119 },
      { rate: 7, net: 50, tax: 3.5, gross: 53.5 },
    ]);
    expect(fields.text).toContain('Rechnungsnummer: BSP-2026-0042');
    expect(fields.text).toContain('Gesamt: 172.50 EUR');
  });

  it('marks a credit note and keeps its amount positive', () => {
    expect(structuredReceiptFields(readInvoiceXml(UBL_CREDIT_NOTE)!)).toMatchObject({ creditNote: true, gross: 11.9 });
  });
});

describe('hostile and unusual input', () => {
  it('refuses unfinished comments, instructions and CDATA near the size limit quickly', () => {
    for (const opener of ['<!--', '<?', '<![CDATA[']) {
      const hostile = '<r>' + opener.repeat(Math.floor(4_000_000 / opener.length));
      const start = performance.now();
      expect(() => parseXml(hostile)).toThrow(XmlError);
      expect(performance.now() - start).toBeLessThan(500);
    }
  });

  it('is strict about names, attributes and ampersands', () => {
    expect(() => parseXml('<a:x xmlns:a="1" xmlns:b="2"></b:x>')).toThrow(XmlError);
    expect(() => parseXml('<x k="1" k="2"/>')).toThrow(XmlError);
    expect(() => parseXml('<x>A & B</x>')).toThrow(XmlError);
    expect(() => parseXml('<x k="<"/>')).toThrow(XmlError);
  });

  it('refuses an XML file over the size limit before decoding it', async () => {
    const huge = new Uint8Array(5_000_001).fill(0x20);
    huge[0] = 0x3c;
    expect(await readStructuredInvoice(huge)).toBeNull();
  });

  it('reads an invoice from a name tree with Kids and from the associated files only', async () => {
    const file = { name: 'factur-x.xml', bytes: bytes(CII_INVOICE) };
    expect((await readStructuredInvoice(await pdfWithLayout({ files: [file], tree: 'kids' })))?.invoice.number).toBe('RE-2026-913');
    expect((await readStructuredInvoice(await pdfWithLayout({ files: [file], tree: 'af' })))?.invoice.number).toBe('RE-2026-913');
    expect((await readStructuredInvoice(await pdfWithLayout({ files: [{ ...file, compress: false }], tree: 'flat' })))?.invoice.number).toBe('RE-2026-913');
  });

  it('visits each node of a looping name tree once', async () => {
    const start = performance.now();
    const reading = await readStructuredInvoice(await pdfWithLayout({ files: [{ name: 'factur-x.xml', bytes: bytes(CII_INVOICE) }], tree: 'loop' }));
    expect(reading?.invoice.number).toBe('RE-2026-913');
    expect(performance.now() - start).toBeLessThan(2_000);
  });

  it('tries every embedded XML file: an unrelated one listed first does not hide the invoice', async () => {
    const pdf = await pdfWithLayout({
      files: [
        { name: 'metadata.xml', bytes: bytes('<Order><ID>1</ID></Order>') },
        { name: 'rechnung-daten.xml', bytes: bytes(UBL_INVOICE) },
      ],
      tree: 'flat',
    });
    expect((await readStructuredInvoice(pdf))?.source).toEqual({ kind: 'pdf_embedded', name: 'rechnung-daten.xml' });
  });

  it('stops inflating an embedded file at the bound, and trusts no declared size over it', async () => {
    const bomb = new Uint8Array(6_000_000).fill(0x20);
    expect(await readStructuredInvoice(await pdfWithLayout({ files: [{ name: 'factur-x.xml', bytes: bomb }], tree: 'flat' }))).toBeNull();
    const declared = { name: 'factur-x.xml', bytes: bytes(CII_INVOICE), declaredSize: 9_000_000 };
    expect(await readStructuredInvoice(await pdfWithLayout({ files: [declared], tree: 'flat' }))).toBeNull();
  });

  it('reads nothing from an encrypted PDF', async () => {
    expect(await readStructuredInvoice(await pdfWithLayout({ files: [{ name: 'factur-x.xml', bytes: bytes(CII_INVOICE) }], tree: 'flat', encrypted: true }))).toBeNull();
  });
});

describe('more of the standards', () => {
  it('reads a CII credit note and the tax stated twice in two currencies', () => {
    const credit = CII_INVOICE.replace('<ram:TypeCode>380</ram:TypeCode>', '<ram:TypeCode>381</ram:TypeCode>').replace(
      '<ram:TaxTotalAmount currencyID="EUR">38.00</ram:TaxTotalAmount>',
      '<ram:TaxTotalAmount currencyID="USD">41.00</ram:TaxTotalAmount><ram:TaxTotalAmount currencyID="EUR">38.00</ram:TaxTotalAmount>',
    );
    expect(readInvoiceXml(credit)).toMatchObject({ kind: 'credit_note', taxCents: 3_800, problems: [] });
  });

  it('takes the UBL tax total in the invoice currency when it comes second', () => {
    const twice = UBL_INVOICE.replace('<cac:TaxTotal>', '<cac:TaxTotal><cbc:TaxAmount currencyID="USD">25.00</cbc:TaxAmount></cac:TaxTotal><cac:TaxTotal>');
    expect(readInvoiceXml(twice)).toMatchObject({ taxCents: 2_250, taxGroups: [expect.objectContaining({ ratePercent: 19 }), expect.objectContaining({ ratePercent: 7 })] });
  });

  it('reads a credit note due date from its payment means, and type codes 81 and 83 as credit notes', () => {
    const due = UBL_CREDIT_NOTE.replace('<cac:TaxTotal>', '<cac:PaymentMeans><cbc:PaymentMeansCode>58</cbc:PaymentMeansCode><cbc:PaymentDueDate>2026-10-31</cbc:PaymentDueDate></cac:PaymentMeans><cac:TaxTotal>');
    expect(readInvoiceXml(due)?.dueDate).toBe('2026-10-31');
    expect(readInvoiceXml(UBL_INVOICE.replace('<cbc:InvoiceTypeCode>380', '<cbc:InvoiceTypeCode>81'))?.kind).toBe('credit_note');
    expect(readInvoiceXml(UBL_INVOICE.replace('<cbc:InvoiceTypeCode>380', '<cbc:InvoiceTypeCode>83'))?.kind).toBe('credit_note');
  });

  it('checks the amount due against prepaid and rounding amounts', () => {
    const prepaid = UBL_INVOICE.replace(
      '<cbc:PayableAmount currencyID="EUR">172.50</cbc:PayableAmount>',
      '<cbc:PrepaidAmount currencyID="EUR">72.50</cbc:PrepaidAmount><cbc:PayableRoundingAmount currencyID="EUR">0.01</cbc:PayableRoundingAmount><cbc:PayableAmount currencyID="EUR">100.01</cbc:PayableAmount>',
    );
    expect(readInvoiceXml(prepaid)).toMatchObject({ prepaidCents: 7_250, roundingCents: 1, payableCents: 10_001, problems: [] });
    expect(readInvoiceXml(prepaid.replace('>100.01<', '>90.00<'))?.problems).toContain('Zu zahlen passt nicht zu Gesamt minus Vorauszahlung.');
    expect(readInvoiceXml(CII_INVOICE.replace('<ram:DuePayableAmount>188.00', '<ram:DuePayableAmount>238.00'))?.problems).toContain('Zu zahlen passt nicht zu Gesamt minus Vorauszahlung.');
  });

  it('takes a tax number marked otherwise than "FC" when it is not the VAT identification number', () => {
    const other = UBL_INVOICE.replace('<cac:TaxScheme><cbc:ID>FC</cbc:ID></cac:TaxScheme>', '<cac:TaxScheme><cbc:ID>TAX</cbc:ID></cac:TaxScheme>');
    expect(readInvoiceXml(other)?.seller).toMatchObject({ vatId: 'DE000000000', taxNumber: '00/000/00000' });
  });

  it('treats an invoice with negative totals as money back, and a credit note with negative totals as a charge', () => {
    const negative = (xml: string) => xml.replace(/currencyID="EUR">(\d)/g, 'currencyID="EUR">-$1');
    expect(structuredReceiptFields(readInvoiceXml(negative(UBL_INVOICE))!)).toMatchObject({ creditNote: true, gross: 172.5 });
    expect(structuredReceiptFields(readInvoiceXml(negative(UBL_CREDIT_NOTE))!)).toMatchObject({ creditNote: false, gross: 11.9 });
  });

  it('reads decimal edge cases and refuses figures too long to stay exact', () => {
    expect(centsOf('.5')).toBe(50);
    expect(centsOf('5.')).toBe(500);
    expect(centsOf('.')).toBeNull();
    expect(centsOf('12345678901234')).toBeNull();
  });
});
