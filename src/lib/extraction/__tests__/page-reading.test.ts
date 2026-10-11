import { describe, expect, it } from 'vitest';
import { readAmounts } from '../amounts';

/**
 * The total a model read from the page, as a second reading the receipt's own
 * arithmetic and the recognized text check. All documents here are invented,
 * in the layout text recognition returns for real ones: labels in one run,
 * amounts in another.
 */

/** A customs invoice: duties without tax next to a taxed service, labels torn from their amounts. */
const CUSTOMS_INVOICE = [
  'Musterfracht Express GmbH',
  'Rechnung',
  'Rechnungsdatum 14.05.2025',
  'Einfuhrabgaben',
  'Zoll',
  'Einfuhrumsatzsteuer',
  'Vorlageprovision',
  'Nettobetrag',
  'MwSt 19 %',
  'Rechnungsbetrag',
  '38,40',
  '130,65',
  '47,97',
  '217,02',
  '9,12',
  '57,09',
  '226,14',
].join('\n');

/** A dollar invoice whose totals block came back as labels, then values. */
const TORN_DOLLAR_INVOICE = [
  'Example Cloud Inc.',
  'Invoice',
  'Date of issue March 3, 2025',
  'Description',
  'Compute usage',
  'Subtotal',
  'VAT',
  'Total',
  '$100.00',
  '$19.00',
  '$119.00',
  '$40.00',
].join('\n');

/** An application for a leasing contract: a monthly rate, no total to pay. */
const LEASING_APPLICATION = ['Musterleasing AG', 'Leasingantrag', 'Antragsdatum 02.04.2025', 'Laufzeit 24 Monate', 'Monatlicher Betrag 49,90 EUR', 'Anzahlung 0,00 EUR'].join('\n');

/** An order page that prints "Total" for the items and "Grand Total" below. */
const ORDER_PAGE = ['Musterversand', 'Order date 12 Jun 2025', 'Total 84.00 EUR', 'Shipping 5.90 EUR', 'Grand Total 89.90 EUR'].join('\n');

describe('readAmounts with a model that saw the page', () => {
  it('the customs invoice: the text alone proves only the taxed part', () => {
    expect(readAmounts(CUSTOMS_INVOICE, { date: '2025-05-14' }).gross).toBe(57.09);
  });

  it('the customs invoice: the page names the total, and the printed total less the tax proves it', () => {
    const reading = readAmounts(CUSTOMS_INVOICE, { date: '2025-05-14', modelGross: 226.14, modelSawPage: true });
    expect(reading.gross).toBe(226.14);
    expect(reading.net).toBe(217.02);
    expect(reading.taxRate).toBe(19);
    expect(reading.checks).not.toContain('total_conflict');
  });

  it('a model that read the text alone does not complete that proof: the proven part stands and a person looks', () => {
    const reading = readAmounts(CUSTOMS_INVOICE, { date: '2025-05-14', modelGross: 226.14 });
    expect(reading.gross).toBe(57.09);
    expect(reading.checks).toContain('total_conflict');
  });

  it('a page total the arithmetic does not bear out never replaces a proven one', () => {
    const reading = readAmounts(CUSTOMS_INVOICE, { date: '2025-05-14', modelGross: 130.65, modelSawPage: true });
    expect(reading.gross).toBe(57.09);
    expect(reading.checks).toContain('total_conflict');
  });

  it('three printed figures that add up are a proof, whatever the labels were torn into', () => {
    const reading = readAmounts(TORN_DOLLAR_INVOICE, { currency: 'USD', modelGross: 119, modelNet: 100, modelSawPage: true });
    expect(reading).toMatchObject({ gross: 119, net: 100, taxRate: 19, checks: [] });
  });

  it('nothing proven and a label names another amount: the page reading is taken and the conflict is recorded', () => {
    // The one label the text keeps next to an amount is the unit price's; the page shows 48.00 next to "Amount paid".
    const text = ['Example Tools Ltd', 'Invoice', 'Unit price total $12.00', '4 seats', 'Amount paid', 'Thank you', '$48.00'].join('\n');
    expect(readAmounts(text, { currency: 'USD' }).gross).toBe(12);
    const reading = readAmounts(text, { currency: 'USD', modelGross: 48, modelSawPage: true });
    expect(reading.gross).toBe(48);
    expect(reading.checks).toEqual(['total_conflict']);
  });

  it('a page total that is not printed in the recognized text is never stored', () => {
    const withLabel = readAmounts(ORDER_PAGE, { modelGross: 98.9, modelSawPage: true });
    expect(withLabel.gross).toBe(89.9);
    expect(withLabel.checks).toContain('total_conflict');
    const withoutAny = readAmounts('Musterladen\nDanke für Ihren Einkauf', { modelGross: 12.5, modelSawPage: true });
    expect(withoutAny.gross).toBeNull();
    expect(withoutAny.checks).toEqual(['total_missing']);
  });

  it('"Total" and "Grand Total": the page and the last label agree, nothing to look at beyond the estimated tax', () => {
    const reading = readAmounts(ORDER_PAGE, { modelGross: 89.9, modelSawPage: true });
    expect(reading.gross).toBe(89.9);
    expect(reading.checks).not.toContain('total_conflict');
    expect(reading.checks).not.toContain('total_unconfirmed');
  });

  it('a total printed above a table with a larger "Total" of its own: the page reading stands, a text-only one does not', () => {
    // An invoice settled partly from a credit: the amount to pay on top, the usage table with its own total below.
    const text = ['Example Editor Inc.', 'Invoice', 'Total $19.22', 'Usage', 'Requests 1 $30.20', 'Total usage $30.20'].join('\n');
    const page = readAmounts(text, { currency: 'USD', modelGross: 19.22, modelSawPage: true });
    expect(page.gross).toBe(19.22);
    expect(page.checks).toContain('total_conflict');
    const textOnly = readAmounts(text, { currency: 'USD', modelGross: 19.22 });
    expect(textOnly.gross).toBe(30.2);
    expect(textOnly.checks).toContain('total_conflict');
  });

  it('a document with no total: the monthly rate is not stored as one', () => {
    expect(readAmounts(LEASING_APPLICATION, {}).gross).toBe(49.9);
    const reading = readAmounts(LEASING_APPLICATION, { modelGross: null, modelNoTotal: true, modelSawPage: true });
    expect(reading.gross).toBeNull();
    expect(reading.net).toBeNull();
    expect(reading.checks).toEqual(['total_missing']);
  });

  it('"no total" is only believed from a model that saw the page', () => {
    expect(readAmounts(LEASING_APPLICATION, { modelGross: null, modelNoTotal: true }).gross).toBe(49.9);
  });

  it('"no total" against a total the arithmetic proves: the proven total stands and a person looks', () => {
    const receipt = ['Musterbäckerei', 'Brot 3,50', 'Netto 3,27', 'MwSt 7% 0,23', 'Summe 3,50'].join('\n');
    const reading = readAmounts(receipt, { date: '2025-03-01', modelGross: null, modelNoTotal: true, modelSawPage: true });
    expect(reading.gross).toBe(3.5);
    expect(reading.checks).toContain('total_conflict');
  });

  it('tax lines of the model count only where their figures are printed', () => {
    const text = ['Musterhandel', 'Rechnung', 'Gesamt 119,00'].join('\n');
    const invented = readAmounts(text, { date: '2025-03-01', modelGross: 119, modelTaxLines: [{ rate: 19, net: 100, tax: 19 }], modelSawPage: true });
    expect(invented.taxGroups).toEqual([]);
    expect(invented.taxPrinted).toBe(false);
    const printed = readAmounts(`${text}\n100,00\n19,00`, { date: '2025-03-01', modelGross: 119, modelTaxLines: [{ rate: 19, net: 100, tax: 19 }], modelSawPage: true });
    expect(printed.taxGroups).toEqual([{ rate: 19, net: 100, tax: 19, gross: 119 }]);
  });

  it('a postage slip: one taxed item among tax-free postage, the sum named by a label and by the page', () => {
    const slip = ['Musterpost AG', 'Filiale 12', '14.03.2025', 'Paket 2 kg 6,19', 'Einschreiben 13,30', 'Versandtasche 1,99 A', 'Summe EUR 21,48', 'A 19% Netto 1,67 MwSt 0,32 Brutto 1,99'].join('\n');
    // The text alone proves the taxed item and takes it for the bill.
    expect(readAmounts(slip, { date: '2025-03-14' }).gross).toBe(1.99);
    const reading = readAmounts(slip, { date: '2025-03-14', modelGross: 21.48, modelSawPage: true });
    expect(reading).toMatchObject({ gross: 21.48, net: 21.16, basis: 'label_agreed' });
    expect(reading.checks).toContain('total_conflict');
    // A page amount no label names does not move a proven bill.
    expect(readAmounts(slip, { date: '2025-03-14', modelGross: 13.3, modelSawPage: true }).gross).toBe(1.99);
  });

  it('a bill with a tip on top: the amount paid is not taken for the bill', () => {
    const receipt = ['Trattoria Beispiel', 'Netto 40,76', 'MwSt 19% 7,74', 'Summe 48,50', 'Trinkgeld 5,00', 'Gesamt 53,50'].join('\n');
    const reading = readAmounts(receipt, { date: '2025-03-14', modelGross: 53.5, modelSawPage: true });
    expect(reading).toMatchObject({ gross: 48.5, tip: 5 });
    expect(reading.checks).not.toContain('total_conflict');
  });

  it('a booking page: the total is printed where the text reader counts no money, and the page names it', () => {
    const booking = ['Musterbahn', 'Ihre Buchung', 'Auftragsnummer 123456789012 Gesamtpreis EUR63,98', 'Hinfahrt 12.05.2025'].join('\n');
    expect(readAmounts(booking, {}).gross).toBeNull();
    const reading = readAmounts(booking, { modelGross: 63.98, modelSawPage: true });
    expect(reading).toMatchObject({ gross: 63.98, basis: 'model_alone' });
    expect(reading.checks).toContain('total_unconfirmed');
    // An amount that is not printed at all stays out.
    expect(readAmounts(booking, { modelGross: 68.93, modelSawPage: true }).gross).toBeNull();
    // And so does one a model names that never saw the page.
    expect(readAmounts(booking, { modelGross: 63.98 }).gross).toBeNull();
  });

  it('"Subtotal" and "Total" only, the tax implied by the difference: the net the page reads is stored with its rate', () => {
    const invoice = ['Example Hosting Inc.', 'Invoice', 'Status -', 'Web hosting 12 months', 'Sub Total', 'Total', '$242.51', '$288.59'].join('\n');
    const reading = readAmounts(invoice, { currency: 'USD', modelGross: 288.59, modelNet: 242.51, modelSawPage: true });
    expect(reading).toMatchObject({ gross: 288.59, net: 242.51, taxRate: 19, taxPrinted: true });
    // A difference that is no rate in force and not printed proves nothing: no rate is made up.
    const odd = readAmounts(invoice.replace('$242.51', '$250.00'), { currency: 'USD', modelGross: 288.59, modelNet: 250, modelSawPage: true });
    expect(odd).toMatchObject({ gross: 288.59, net: 288.59, taxRate: 0 });
  });

  it('a foreign invoice that prints its tax: the rate is stored whatever the currency', () => {
    const invoice = ['Example Deploy AB', 'Invoice', 'Subtotal', 'VAT 25%', 'Total', 'Amount due', '$80.00', '$20.00', '$100.00', '$100.00'].join('\n');
    const reading = readAmounts(invoice, { currency: 'USD', modelGross: 100, modelNet: 80, modelSawPage: true });
    expect(reading).toMatchObject({ gross: 100, net: 80, taxRate: 25, taxPrinted: true });
  });
});
