import { describe, expect, it } from 'vitest';
import { cleanInvoiceNumber, invoiceNumberKey, parseInvoiceNumber, settleInvoiceNumber } from '../invoice-number';
import { ADOBE_DATE_IN_A_COLUMN } from './invoice-fixtures';
import * as invoices from './invoice-fixtures';

const sources = (over: Partial<Parameters<typeof settleInvoiceNumber>[0]>) => ({ structured: null, text: '', model: null, fromImageOnly: false, creditNote: false, ...over });

describe('cleanInvoiceNumber', () => {
  it('keeps the printed form, without a leading "#", "Nr." or "No." and with whitespace collapsed', () => {
    expect(cleanInvoiceNumber('  #RE-2026-0042 ')).toBe('RE-2026-0042');
    expect(cleanInvoiceNumber('Nr. 2026/17')).toBe('2026/17');
    expect(cleanInvoiceNumber('No.  A  12345')).toBe('A 12345');
    expect(cleanInvoiceNumber('Nº 778899')).toBe('778899');
  });

  it('is null for nothing, a non-string and a sentence', () => {
    expect(cleanInvoiceNumber('   ')).toBeNull();
    expect(cleanInvoiceNumber(42)).toBeNull();
    expect(cleanInvoiceNumber('x'.repeat(61))).toBeNull();
  });
});

describe('invoiceNumberKey', () => {
  it('compares case folded, without spaces, separators and leading labels', () => {
    const key = invoiceNumberKey('RE-2026/0042');
    expect(key).toBe('RE20260042');
    for (const same of ['re 2026 0042', '#RE.2026.0042', 'Nr. RE_2026-0042', 'RE20260042']) expect(invoiceNumberKey(same)).toBe(key);
    expect(invoiceNumberKey('RE-2026-0043')).not.toBe(key);
  });

  it('gives a weak number no key: short, without a digit, or a few digits only', () => {
    for (const weak of ['17', '4711', 'A12', 'ABCDEF', '', null, 'Nr. 1234']) expect(invoiceNumberKey(weak)).toBeNull();
    expect(invoiceNumberKey('12345')).toBe('12345');
    expect(invoiceNumberKey('R-1234')).toBe('R1234');
  });
});

describe('parseInvoiceNumber', () => {
  it('reads the number after the common labels, on the line or below it', () => {
    expect(parseInvoiceNumber('Rechnungsnummer: RE-2026-0042\nDatum 01.02.2026')).toBe('RE-2026-0042');
    expect(parseInvoiceNumber('Rechnungs-Nr.: 2026/17')).toBe('2026/17');
    expect(parseInvoiceNumber('Rechnung Nr. 100200300 vom 03.02.2026')).toBe('100200300');
    expect(parseInvoiceNumber('Rechnungsnummer: 554433, Datum 01.02.2026')).toBe('554433');
    expect(parseInvoiceNumber('Re.-Nr. 55667788')).toBe('55667788');
    expect(parseInvoiceNumber('Invoice #A-INV-000001')).toBe('A-INV-000001');
    expect(parseInvoiceNumber('Invoice number 00000000-0005')).toBe('00000000-0005');
    expect(parseInvoiceNumber('Invoice No.: INV-998877')).toBe('INV-998877');
    expect(parseInvoiceNumber('Receipt #2345-6789')).toBe('2345-6789');
    expect(parseInvoiceNumber('Rechnungsnummer\nRN-445566\nRechnungsdatum')).toBe('RN-445566');
    expect(parseInvoiceNumber(ADOBE_DATE_IN_A_COLUMN)).toBe('IEN0000000001');
  });

  it('reads the fixtures of real invoices that print a number', () => {
    for (const text of Object.values(invoices)) {
      if (typeof text !== 'string' || !/rechnungsnummer|invoice (?:number|#)|invoice #/i.test(text)) continue;
      expect(parseInvoiceNumber(text)).not.toBeNull();
    }
  });

  it('takes the invoice number over a receipt number, and one number printed twice once', () => {
    expect(parseInvoiceNumber('Receipt #1111-2222\nInvoice number ABCD-0001')).toBe('ABCD-0001');
    expect(parseInvoiceNumber('Rechnungsnummer: R-998877\n...\nRechnungsnummer: R-998877')).toBe('R-998877');
  });

  it('gives none for two different numbers under the same kind of label', () => {
    expect(parseInvoiceNumber('Rechnungsnummer: R-111111\nRechnungsnummer: R-222222')).toBeNull();
  });

  it('never takes an order, customer, contract, till or transaction number', () => {
    for (const text of [
      'Bestellnummer: 302-1234567-7654321',
      'Kundennummer 123456789',
      'Vertragsnummer V-778899',
      'Bon-Nr. 4711',
      'Beleg-Nr. 12345',
      'Trans.-Nr. 998877',
      'TSE-Transaktion 445566',
    ]) {
      expect(parseInvoiceNumber(text)).toBeNull();
    }
  });

  it('never takes a date, an amount or a word after the label, nor a column header row', () => {
    expect(parseInvoiceNumber('Rechnungsnummer 01.02.2026')).toBeNull();
    expect(parseInvoiceNumber('Rechnungsnummer 1.234,56')).toBeNull();
    expect(parseInvoiceNumber('Rechnungsnummer Kundennummer Datum\n12345 67890 01.01.2026')).toBeNull();
    expect(parseInvoiceNumber('Rechnungsdatum 01.02.2026')).toBeNull();
  });

  it('skips the number of another document ("zu Rechnung Nr.", "Storno")', () => {
    expect(parseInvoiceNumber('Gutschrift zu Rechnungsnummer R-445566')).toBeNull();
    expect(parseInvoiceNumber('Bezieht sich auf Rechnung: R-445566')).toBeNull();
    expect(parseInvoiceNumber('Payment for invoice #INV-1234')).toBeNull();
  });

  it('reads a credit note by its own number only', () => {
    const text = 'Gutschrift (elektronisch)\nGutschriftsnummer: G-2026-7\nRechnungsnummer: R-2026-17';
    expect(parseInvoiceNumber(text, { creditNote: true })).toBe('G-2026-7');
    expect(parseInvoiceNumber('Rechnungsnummer: R-2026-17', { creditNote: true })).toBeNull();
  });

  it('reads the text an electronic invoice is stored with', () => {
    expect(parseInvoiceNumber('Rechnung (elektronisch)\nVerkäufer: Beispiel GmbH\nRechnungsnummer: BSP-2026-0042\nRechnungsdatum: 2026-01-15')).toBe('BSP-2026-0042');
  });
});

describe('settleInvoiceNumber', () => {
  it("takes the XML's number first", () => {
    expect(settleInvoiceNumber(sources({ structured: 'BSP-1', text: 'Rechnungsnummer: OTHER-77', model: 'X' }))).toBe('BSP-1');
  });

  it("takes the text's number over the model's", () => {
    expect(settleInvoiceNumber(sources({ text: 'Rechnungsnummer: R-123456\nBestellung 998877', model: '998877' }))).toBe('R-123456');
  });

  it("takes the model's number only where the text carries it as a whole token", () => {
    const text = 'Beispiel GmbH\nNr. 2026-55 / Datum 01.02.2026';
    expect(settleInvoiceNumber(sources({ text, model: '2026-55' }))).toBe('2026-55');
    expect(settleInvoiceNumber(sources({ text, model: '2026-555' }))).toBeNull();
    expect(settleInvoiceNumber(sources({ text, model: 'R-1' }))).toBeNull();
  });

  it('gives none for a reading from the image alone, unless the XML states one', () => {
    expect(settleInvoiceNumber(sources({ fromImageOnly: true, model: 'R-123456' }))).toBeNull();
    expect(settleInvoiceNumber(sources({ fromImageOnly: true, structured: 'R-9' }))).toBe('R-9');
  });

  it('never invents one: no text, no label, no model answer', () => {
    expect(settleInvoiceNumber(sources({ text: 'Bäckerei Beispiel\nBrötchen 0,50\nSumme 0,50' }))).toBeNull();
  });
});
