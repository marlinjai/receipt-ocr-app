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
    const a = readAmounts(F.DOLLAR_INVOICE_WITH_DISCOUNT, { currency: 'USD' });
    // The total after the discount, not the subtotal the old reader took.
    expect(a.gross).toBe(360);
    expect(a.checks).toContain('total_unconfirmed');
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
    const fields = extractReceiptFields(ocr(F.DOLLAR_INVOICE_WITH_DISCOUNT));
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
