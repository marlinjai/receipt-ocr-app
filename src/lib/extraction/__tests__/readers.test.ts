import { describe, expect, it } from 'vitest';
import { extractReceiptFields } from '@/lib/extract-receipt-fields';
import { amountsInText, ratesOn, readAmounts } from '../amounts';
import { mealEvidence } from '../meal-evidence';
import { chooseVendor, readVendor } from '../vendor';
import * as F from './fixtures';

/**
 * The seven extraction defects of the first live upload (roadmap, 2026-10-08),
 * each as a receipt in the layout that produced it. See fixtures.ts.
 */

const ocr = (fullText: string) => ({ fullText, blocks: [], confidence: 0.95 });

describe('amounts: what is money and what only looks like it', () => {
  it('a receipt number with a decimal point is not an amount', () => {
    const values = amountsInText('Duplikat C916752.448\nA916752.8837\nRechnung für Quittung R916752.8746\n€ 58.70').map((a) => a.cents);
    expect(values).toEqual([5870]);
  });

  it('a date, a rate, a volume and a tax number are not amounts', () => {
    const values = amountsInText('02.05.2025 21:19\n19,00%\nWasser 0,75L\nSt.-Nr. 27/138/50536\nTel: 030 28 03 55 08\n*34.20').map((a) => a.cents);
    expect(values).toEqual([3420]);
  });

  it('reads thousands separators either way round', () => {
    expect(amountsInText('1.234,56\n2,345.67').map((a) => a.cents)).toEqual([123456, 234567]);
  });
});

describe('defect 1: a receipt number was read as the total', () => {
  it('takes the total the tax line confirms, and the tip as a tip', () => {
    const a = readAmounts(F.CAFE_WITH_RECEIPT_NUMBERS, { date: '2025-02-19' });
    expect(a.gross).toBe(58.7);
    expect(a.net).toBe(49.33);
    expect(a.taxRate).toBe(19);
    expect(a.tip).toBe(2.7);
    expect(a.checks).toEqual([]);
  });

  it('never returns a total above what the receipt can add up to', () => {
    const fields = extractReceiptFields(ocr(F.CAFE_WITH_RECEIPT_NUMBERS));
    expect(fields.gross).toBe(58.7);
    expect(fields.net).toBeLessThan(fields.gross!);
  });

  it('a total that includes the tip is split into bill and tip', () => {
    expect(readAmounts(F.THAI_TOTAL_TIP_GRAND_TOTAL, { date: '2025-04-02' })).toMatchObject({ gross: 45.2, net: 37.98, tip: 4.8, taxRate: 19 });
    // Here the bill itself is printed nowhere: net plus tax plus tip is the only total on the receipt.
    expect(readAmounts(F.GRILL_TOTAL_INCLUDES_TIP, { date: '2025-10-09' })).toMatchObject({ gross: 44, net: 36.97, tip: 4.4, taxRate: 19 });
    expect(readAmounts(F.CROPPED_HEAD, { date: '2025-12-11' })).toMatchObject({ gross: 32.6, net: 27.39, tip: 2.4, taxRate: 19 });
  });

  it('a tip that happens to be seven percent of the bill is not read as a tax line', () => {
    expect(readAmounts(F.RISTORANTE_TIP_LOOKS_LIKE_TAX, { date: '2025-11-21' })).toMatchObject({ gross: 140.3, net: 117.9, tip: 9.82, taxRate: 19 });
  });

  it('cash handed over minus the bill is change, not a tip', () => {
    const text = 'Gasthaus Beispiel\nSumme 45,20\nTrinkgeld\nGegeben 50,00\nZurück 4,80\nNetto 37,98\nMwSt 19% 7,22';
    expect(readAmounts(text).tip).toBeNull();
    expect(readAmounts(text).gross).toBe(45.2);
  });

  it('a labelled total without arithmetic to back it is taken, and reported as unconfirmed', () => {
    const a = readAmounts(F.PARKING_LABEL_ONLY, { date: '2025-06-12' });
    expect(a.gross).toBe(7.5);
    expect(a.checks).toContain('total_unconfirmed');
    // In any currency: a label alone is a label alone.
    expect(readAmounts('Shop Inc\nTotal: $50.00', { currency: 'USD' }).checks).toEqual(['total_unconfirmed']);
  });

  it('takes the total after the discount, not the subtotal the old reader took', () => {
    expect(readAmounts(F.DOLLAR_INVOICE_WITH_DISCOUNT, { currency: 'USD' }).gross).toBe(360);
  });

  it('a second reading that disagrees with the arithmetic is reported, and the arithmetic wins', () => {
    const a = readAmounts(F.BREAKFAST_LABELS_ABOVE_VALUES, { date: '2025-02-09', modelGross: 916752.88 });
    expect(a.gross).toBe(34.2);
    expect(a.checks).toContain('total_conflict');
  });

  it('a second reading that agrees with a labelled total confirms it', () => {
    const a = readAmounts(F.DOLLAR_INVOICE_WITH_DISCOUNT, { currency: 'USD', modelGross: 360 });
    expect(a.gross).toBe(360);
    expect(a.checks).not.toContain('total_unconfirmed');
    expect(a.checks).not.toContain('total_conflict');
  });

  it('no total on the receipt is no total: nothing is guessed from the largest number', () => {
    const a = readAmounts('Beispiel GmbH\nArtikel A 12.50\nArtikel B 25.00');
    expect(a.gross).toBeNull();
    expect(a.checks).toEqual(['total_missing']);
  });
});

describe('defect 2: tax rates of 526 and 844 percent', () => {
  it('reads net and tax from a block below their labels', () => {
    const a = readAmounts(F.BREAKFAST_LABELS_ABOVE_VALUES, { date: '2025-02-09' });
    expect(a).toMatchObject({ gross: 34.2, net: 28.74, taxRate: 19 });
    expect(a.taxGroups).toEqual([{ rate: 19, net: 28.74, tax: 5.46, gross: 34.2 }]);
  });

  it('reads two rates on one receipt and names the one that carries most of the bill', () => {
    const a = readAmounts(F.FOODBAR_TWO_RATES, { date: '2025-03-21' });
    expect(a.gross).toBe(37.7);
    expect(a.net).toBe(35.14);
    expect(a.taxRate).toBe(7);
    expect(a.taxGroups.map((g) => g.rate)).toEqual([7, 19]);
  });

  it('adds up two groups at one rate when only their common total is printed', () => {
    const a = readAmounts(F.BAR_WITH_SERVER, { date: '2025-12-05' });
    expect(a).toMatchObject({ gross: 40.5, net: 34.04, taxRate: 19 });
    expect(a.taxGroups).toHaveLength(2);
  });

  it('reads the tax table printed as one row, and a total with only the tax it includes', () => {
    expect(readAmounts(F.THAI_TAX_TABLE_ROW, { date: '2025-08-01' })).toMatchObject({ gross: 48.5, net: 40.76, taxRate: 19 });
    expect(readAmounts(F.ONLINE_ORDER_TAX_INCLUDED, { date: '2025-11-07' })).toMatchObject({ gross: 22.42, net: 18.84, taxRate: 19 });
  });

  it('no rate that a receipt cannot carry ever comes out of the full extraction', () => {
    for (const text of Object.values(F)) {
      const fields = extractReceiptFields(ocr(text));
      expect(fields.taxRate).toBeGreaterThanOrEqual(0);
      expect(fields.taxRate).toBeLessThanOrEqual(27.5);
      if (fields.gross !== null && fields.net !== null) expect(fields.net).toBeLessThanOrEqual(fields.gross);
    }
  });

  it('marks a rate as estimated when the receipt prints none', () => {
    const fields = extractReceiptFields(ocr(F.PARKING_LABEL_ONLY));
    expect(fields.taxRate).toBe(19);
    expect(fields.taxRatePrinted).toBe(false);
    expect(fields.amountChecks).toContain('tax_estimated');
  });

  it('accepts a foreign rate when net, tax and total are stated and add up', () => {
    const a = readAmounts('Diner Example\nSubtotal: $30.80\nSales Tax: $2.77\nTotal: $33.57', { currency: 'USD' });
    expect(a).toMatchObject({ gross: 33.57, net: 30.8 });
    expect(a.taxRate).toBeCloseTo(8.99, 1);
  });

  it('knows the reduced rates of the second half of 2020', () => {
    expect(ratesOn('2020-08-01')).toContain(16);
    expect(ratesOn('2025-08-01')).toEqual([19, 7]);
    expect(readAmounts('Summe 116,00\nNetto 100,00\nMwSt 16% 16,00', { date: '2020-08-01' }).taxRate).toBe(16);
  });
});

/**
 * A course invoice in dollars with a 20 percent discount (2026-10-10). The
 * total was read right, and then 19 percent German value-added tax was
 * estimated on a dollar invoice that prints no tax line.
 */
describe('a receipt in another currency carries no German tax', () => {
  it('a dollar invoice that prints no tax is given none: the net is the total, the rate 0, nothing estimated', () => {
    expect(readAmounts(F.DOLLAR_INVOICE_WITH_DISCOUNT, { date: '2025-11-26', currency: 'USD' })).toEqual({
      gross: 360,
      net: 360,
      taxRate: 0,
      taxPrinted: false,
      taxGroups: [],
      tip: null,
      checks: [],
    });
  });

  it('the full extraction says the same, in dollars, with no estimate to look at', () => {
    const fields = extractReceiptFields(ocr(F.DOLLAR_INVOICE_WITH_DISCOUNT));
    expect(fields).toMatchObject({ gross: 360, net: 360, taxRate: 0, currency: 'USD', currencyShown: true, taxRatePrinted: false, amountChecks: [], taxGroups: [] });
    expect(fields.name).toBe('Example Courses, 360.00 USD, 26.11.2025');
  });

  it('the same total in euros still gets the German default, marked as an estimate', () => {
    const a = readAmounts('Kurse Beispiel\nSumme 360,00 €', { date: '2025-11-26', currency: 'EUR' });
    expect(a).toMatchObject({ gross: 360, net: null, taxRate: null, taxPrinted: false });
    expect(a.checks).toContain('tax_estimated');
    expect(extractReceiptFields(ocr('Kurse Beispiel\nSumme 360,00 €'))).toMatchObject({ net: 302.52, taxRate: 19, currency: 'EUR' });
  });

  it('a total by its label alone stays unconfirmed, and still gets no German tax', () => {
    expect(readAmounts('Shop Inc\nTotal: $50.00', { currency: 'USD' })).toMatchObject({ gross: 50, net: 50, taxRate: 0, checks: ['total_unconfirmed'] });
    // A second reading that disagrees is still reported.
    expect(readAmounts(F.DOLLAR_INVOICE_WITH_DISCOUNT, { currency: 'USD', modelGross: 450 })).toMatchObject({ gross: 360, net: 360, taxRate: 0, checks: ['total_conflict'] });
  });

  it('no total at all is no total, and no rate either', () => {
    expect(readAmounts('Shop Inc\nThank you', { currency: 'USD' })).toMatchObject({ gross: null, net: null, taxRate: 0, checks: ['total_missing'] });
  });

  it('keeps the tax a foreign receipt states with its label, on the same line', () => {
    expect(readAmounts('Diner Example\nSubtotal: $30.80\nSales Tax: $2.77\nTotal: $33.57', { currency: 'USD' })).toMatchObject({ gross: 33.57, net: 30.8, taxRate: 9, taxPrinted: true, checks: [] });
    expect(readAmounts('Shop Ltd\nTotal £120.00\nIncludes VAT of £20.00', { currency: 'GBP' })).toMatchObject({ gross: 120, net: 100, taxRate: 20, taxPrinted: true });
    // A stated zero is a statement, not an absence.
    expect(readAmounts('Host Inc.\nSubtotal: $25.00\nTax (0%): $0.00\nTotal Due: $25.00', { currency: 'USD' })).toMatchObject({ gross: 25, net: 25, taxRate: 0, taxPrinted: true });
  });

  it('keeps it where every label stands above its amount, with a discount in between', () => {
    expect(readAmounts(F.DOLLAR_INVOICE_WITH_TAX, { date: '2025-11-27', currency: 'USD' })).toEqual({
      gross: 428.4,
      net: 360,
      taxRate: 19,
      taxPrinted: true,
      taxGroups: [],
      tip: null,
      checks: [],
    });
    // The subtotal before the discount is not the net: 40.00 less 9.20 plus 2.77 is the total.
    expect(readAmounts('Diner Example\nSubtotal: $40.00\nDiscount: -$9.20\nSales Tax: $2.77\nTotal: $33.57', { currency: 'USD' })).toMatchObject({ gross: 33.57, net: 30.8, taxRate: 9 });
  });

  it('a subtotal alone states no tax: shipping between it and the total is not a tax rate', () => {
    const a = readAmounts('Shop Inc\nSubtotal: $300.00\nShipping: $60.00\nTotal: $360.00', { currency: 'USD' });
    expect(a).toMatchObject({ gross: 360, net: 360, taxRate: 0, taxPrinted: false });
  });

  it('a tax number and a "before tax" line are not the tax amount', () => {
    const text = 'Shop Inc\nTax ID: 12-3456789\n$450.00\nTotal before tax: $100.00\nVAT: $20.00\nTotal: $120.00';
    expect(readAmounts(text, { currency: 'USD' })).toMatchObject({ gross: 120, net: 100, taxRate: 20, taxPrinted: true });
  });

  it('a total the figures do not bear out stays unconfirmed, and keeps the tax its label names', () => {
    // The last labelled total includes the tip: 30.80 plus 2.77 is not 38.57.
    const text = 'Diner Example\nSubtotal: $30.80\nSales Tax: $2.77\nTotal: $33.57\nTip: $5.00\nGrand Total: $38.57';
    const a = readAmounts(text, { currency: 'USD' });
    expect(a).toMatchObject({ gross: 38.57, net: 35.8, taxPrinted: true, checks: ['total_unconfirmed'] });
    // Shipping between subtotal and total: the tax is the tax, the total is for a person to look at.
    const shipped = readAmounts('Shop Inc\nSubtotal: $40.00\nShipping: $5.00\nTax: $2.77\nTotal: $47.77', { currency: 'USD' });
    expect(shipped).toMatchObject({ gross: 47.77, net: 45, taxPrinted: true, checks: ['total_unconfirmed'] });
  });

  it('a total only the second reading gave is still read for the tax its label names', () => {
    const a = readAmounts('Shop Inc\nPaid\n$50.00\nTax: $4.00', { currency: 'USD', modelGross: 50 });
    expect(a).toMatchObject({ gross: 50, net: 46, taxRate: 8.7, taxPrinted: true, checks: ['total_unconfirmed'] });
  });
});

describe('a discount above the total', () => {
  it('is neither the tip nor a tax amount: the receipt keeps its total, its tax group and no tip', () => {
    const a = readAmounts(F.SHOP_WITH_DISCOUNT, { date: '2025-05-02' });
    expect(a).toMatchObject({ gross: 25, net: 21.01, taxRate: 19, tip: null, checks: [] });
    expect(a.taxGroups).toEqual([{ rate: 19, net: 21.01, tax: 3.99, gross: 25 }]);
  });

  it('with its minus glued to the digits it is not read as an amount at all', () => {
    expect(amountsInText('Zwischensumme 30,00\nRabatt -5,00\nSumme 25,00').map((a) => a.cents)).toEqual([3000, 2500]);
  });

  // A coupon of 5,00 on a bill of 31,32 is 19 percent of the 26,32 that are left,
  // and the bill before the coupon is printed: without the label it is a tax group.
  it.each([
    ['plain', 'Rabatt 5,00'],
    ['minus before the euro sign', 'Rabatt -€5,00'],
    ['minus behind the amount', 'Rabatt 5,00-'],
    ['a compound word, the amount on the line below', 'Sofortrabatt\n5,00'],
  ])('a coupon that happens to be 19 percent of what is left is not read as the tax (%s)', (_, discount) => {
    const a = readAmounts(`Laden Beispiel GmbH\nZwischensumme 31,32\n${discount}\nSumme 26,32`, { date: '2025-05-02' });
    expect(a.gross).toBe(26.32);
    expect(a.taxGroups).toEqual([]);
    expect(a.taxRate).toBeNull();
    // The rate is the default, and said to be: nothing was confirmed that is not on the receipt.
    expect(a.checks).toEqual(['tax_estimated']);
  });

  it('is not read as the tax a total includes either, where the receipt mentions tax', () => {
    const a = readAmounts('Laden Beispiel GmbH\nZwischensumme 31,32\nRabatt 5,00\nSumme 26,32\ninkl. MwSt', { date: '2025-05-02' });
    expect(a).toMatchObject({ gross: 26.32, taxGroups: [], taxRate: null });
  });

  it('is not the tip a receipt leaves a line for', () => {
    const tail = 'Summe 45,00\nNetto 37,82\nMwSt 19% 7,18';
    for (const text of [
      `Restaurant Beispiel\nTisch 4\nZwischensumme 50,00\nRabatt 5,00\n${tail}\nTrinkgeld`,
      `Restaurant Beispiel\nTisch 4\nZwischensumme 50,00\nRabatt -€5,00\n${tail}\nTrinkgeld`,
      `Restaurant Beispiel\nTisch 4\nZwischensumme\n50,00\nRabatt\n5,00\n${tail}\nTip:`,
    ]) {
      expect(readAmounts(text, { date: '2025-05-02' })).toMatchObject({ gross: 45, net: 37.82, taxRate: 19, tip: null, checks: [] });
    }
  });

  it('a real tip next to a discount is still found', () => {
    const text = 'Restaurant Beispiel\nTisch 4\nZwischensumme 50,00\nRabatt 5,00\nSumme 45,00\nNetto 37,82\nMwSt 19% 7,18\nTrinkgeld 4,00\nGesamt 49,00';
    expect(readAmounts(text, { date: '2025-05-02' })).toMatchObject({ gross: 45, net: 37.82, tip: 4 });
  });

  it('a word that only mentions a discount names none', () => {
    // "rabattfähig" on the tax line does not make the tax a discount: the group is still found.
    const text = 'Laden Beispiel GmbH\nSumme 26,32\nNetto 22,12\nMwSt 19% (nicht rabattfähig) 4,20';
    expect(readAmounts(text, { date: '2025-05-02' }).taxGroups).toEqual([{ rate: 19, net: 22.12, tax: 4.2, gross: 26.32 }]);
  });

  it('subtotal less discount is the total: the receipt has confirmed it itself', () => {
    // No second reading is needed for the dollar invoice: 450.00 less 90.00 is 360.00.
    expect(readAmounts(F.DOLLAR_INVOICE_WITH_DISCOUNT, { currency: 'USD' }).checks).toEqual([]);
    // In euros the total is confirmed the same way; the rate is still an estimate.
    expect(readAmounts('Laden Beispiel GmbH\nZwischensumme 30,00\nRabatt -5,00\nSumme 25,00').checks).toEqual(['tax_estimated']);
    // Every discount counts.
    expect(readAmounts('Laden Beispiel GmbH\nZwischensumme 30,00\nRabatt -5,00\nGutschein -10,00\nSumme 15,00').checks).toEqual(['tax_estimated']);
  });

  it('figures that do not add up confirm nothing', () => {
    expect(readAmounts('Laden Beispiel GmbH\nZwischensumme 30,00\nRabatt -5,00\nSumme 26,00').checks).toContain('total_unconfirmed');
    expect(readAmounts('Laden Beispiel GmbH\nZwischensumme 30,00\nSumme 25,00').checks).toContain('total_unconfirmed');
  });
});

describe('defect 4: a bar filed as software, a taverna as "other"', () => {
  it('a table, a waiter and dishes make a restaurant receipt, whatever keyword follows', () => {
    expect(mealEvidence(F.BAR_WITH_SERVER).strong).toBe(true);
    expect(extractReceiptFields(ocr(F.BAR_WITH_SERVER)).category).toBe('Bewirtung');
  });

  it('a taverna is a restaurant', () => {
    expect(mealEvidence(F.TAVERNA).strong).toBe(true);
    expect(extractReceiptFields(ocr(F.TAVERNA))).toMatchObject({ category: 'Bewirtung', konto: '4650' });
  });

  it('a table named in the middle of a line counts, a word that only contains "tisch" does not', () => {
    expect(mealEvidence(F.CAFE_WITH_RECEIPT_NUMBERS)).toMatchObject({ strong: true });
    expect(mealEvidence(F.CAFE_WITH_RECEIPT_NUMBERS).signs).toContain('table');
    expect(mealEvidence('Schreibtisch 3 Stück\nSumme 300,00').signs).not.toContain('table');
  });

  it('"Server:" on a hosting invoice does not make a meal, however many weak signs add up', () => {
    const invoice = 'Hosting Beispiel GmbH\nRechnung 2025-118\nServer: web-01.example.net\nGuests: 4 virtual machines\nTip: restart nightly\nPlan: Food Delivery Starter\nSumme 49,00';
    const evidence = mealEvidence(invoice);
    expect(evidence.score).toBeGreaterThanOrEqual(4);
    expect(evidence.strong).toBe(false);
    expect(extractReceiptFields(ocr(invoice)).category).not.toBe('Bewirtung');
  });

  it('the printed hospitality form alone decides', () => {
    expect(mealEvidence('Beispiel\nSumme 20,00\nBewirtungsaufwand-Angaben\nBewirtete Personen:\nAnlass der Bewirtung:').strong).toBe(true);
  });

  it('every restaurant receipt of the first upload is filed as a meal', () => {
    for (const text of [F.CAFE_WITH_RECEIPT_NUMBERS, F.BREAKFAST_LABELS_ABOVE_VALUES, F.FOODBAR_TWO_RATES, F.INDIAN_NAME_IN_THREE_LINES, F.THAI_TOTAL_TIP_GRAND_TOTAL, F.GRILL_TOTAL_INCLUDES_TIP, F.RISTORANTE_TIP_LOOKS_LIKE_TAX, F.CROPPED_HEAD, F.THAI_TAX_TABLE_ROW]) {
      expect(extractReceiptFields(ocr(text)).category).toBe('Bewirtung');
    }
  });

  it('an online order and an invoice are not meals', () => {
    expect(mealEvidence(F.ONLINE_ORDER_TAX_INCLUDED).strong).toBe(false);
    expect(extractReceiptFields(ocr(F.DOLLAR_INVOICE_WITH_DISCOUNT)).category).not.toBe('Bewirtung');
  });

  it('a supermarket receipt is not a meal, however much food it lists', () => {
    const text = 'REWE Markt GmbH\nBeispielstr. 1\nCappuccino 2,49\nPizza 3,99\nBier 0,99\nWasser 0,59\nSumme 8,06';
    expect(mealEvidence(text).strong).toBe(false);
  });

  it('a vendor name decides only as a whole word', () => {
    // "total" is a filling station brand in the vendor list; it must not match inside another name.
    expect(extractReceiptFields(ocr('Totally Vegan Supplies\nRechnung\nSumme 12,00')).category).not.toBe('Reisekosten');
    expect(extractReceiptFields(ocr('Telekom\nMobilfunk Rechnung\nTotal: 39,99 €')).category).toBe('Telefon & Internet');
  });
});

describe('defect 5: the first printed line taken as the vendor', () => {
  it('skips a slogan and takes the line that names the business', () => {
    expect(readVendor(F.FOODBAR_TWO_RATES)).toEqual({ vendor: 'Fantastic Foodbar', confidence: 'confirmed' });
  });

  it('joins a name set in three short lines', () => {
    expect(readVendor(F.INDIAN_NAME_IN_THREE_LINES)).toEqual({ vendor: 'Indisches Restaurant Shanti', confidence: 'confirmed' });
  });

  it('gives no name when the head of the receipt is missing, instead of an item line', () => {
    expect(readVendor(F.CROPPED_HEAD)).toEqual({ vendor: null, confidence: 'none' });
    expect(extractReceiptFields(ocr(F.CROPPED_HEAD)).vendor).toBeNull();
  });

  it('skips a misread logo for the name printed below it', () => {
    expect(readVendor(F.ONLINE_ORDER_TAX_INCLUDED).vendor).toBe('SHOPIX');
  });

  it('keeps an ordinary first line, and a company line with its legal form', () => {
    expect(readVendor(F.TAVERNA).vendor).toBe('TAVERNA BEISPIEL');
    expect(readVendor(F.BAR_WITH_SERVER).vendor).toBe('Hopfen Retail Germany GmbH');
    expect(readVendor(F.CAFE_WITH_RECEIPT_NUMBERS).vendor).toBe('Cafe Morgenrot');
  });

  it('prefers the trading name printed above a company line', () => {
    const text = 'das fruehstueckshaus\n526 Gastronomiebetrieb UG\nBeispielstraße 26\n10435 Musterstadt';
    expect(readVendor(text).vendor).toBe('das fruehstueckshaus');
  });

  it('does not take a contact line, a price line or a heading for a name', () => {
    expect(readVendor('Tel.: 030 000\nwww.example.org\nRechnung\nSumme 12,00').vendor).toBeNull();
    expect(readVendor('Telekom\nMobilfunk Rechnung').vendor).toBe('Telekom');
  });

  it("takes the model's name when the receipt text contains it", () => {
    const reading = readVendor(F.FOODBAR_TWO_RATES);
    expect(chooseVendor(reading, 'Fantastic Foodbar', F.FOODBAR_TWO_RATES).vendor).toBe('Fantastic Foodbar');
  });

  it("does not take a name from the model that the receipt does not show, unless the text gave nothing", () => {
    const reading = readVendor(F.TAVERNA);
    expect(chooseVendor(reading, 'Some Other Chain', F.TAVERNA).vendor).toBe('TAVERNA BEISPIEL');
    expect(chooseVendor(readVendor(F.CROPPED_HEAD), 'Cafe Sophie', F.CROPPED_HEAD)).toEqual({ vendor: 'Cafe Sophie', confidence: 'likely' });
    expect(chooseVendor(readVendor(F.CROPPED_HEAD), '+ mit Haferdrink', F.CROPPED_HEAD).vendor).toBeNull();
  });
});

describe('the receipt date', () => {
  it('is the printed day at midnight UTC, whatever time zone the server runs in', () => {
    expect(extractReceiptFields(ocr(F.BREAKFAST_LABELS_ABOVE_VALUES)).date).toBe('2025-02-09T00:00:00.000Z');
  });
});
