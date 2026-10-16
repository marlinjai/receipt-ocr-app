import { describe, expect, it } from 'vitest';
import { readStructuredInvoice, structuredReceiptFields } from '../index';
import { centsOf, readInvoiceXml } from '../parse';
import { parseXml, XmlError } from '../xml';
import { CII_INVOICE, pdfWithEmbeddedXml, UBL_CREDIT_NOTE, UBL_INVOICE } from './samples';

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
