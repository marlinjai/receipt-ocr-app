import { describe, expect, it } from 'vitest';
import { readAmounts } from '../amounts';
import * as F from './invoice-fixtures';

/**
 * Totals of the 2025 import that were stored wrong (roadmap, 2026-10-11): 26
 * receipts, mostly the net amount for the gross. Text recognition returns an
 * invoice one cell per line, so "Total" stands in a run of labels and its
 * amount in a run of amounts. The reader then had no total of its own, took
 * the second reading's word for it, and that reading had named the net.
 * Every case is read here without a second reading, with a right one and with
 * the wrong one production got. See invoice-fixtures.ts.
 */

describe('net, tax and their printed sum settle the total in any currency', () => {
  it('OpenAI: 23.80, not the net of 20.00 the second reading named', () => {
    expect(readAmounts(F.OPENAI_TORN, { currency: 'USD' })).toMatchObject({ gross: 23.8, net: 20, taxRate: 19, taxPrinted: true, checks: [] });
    expect(readAmounts(F.OPENAI_TORN, { currency: 'USD', modelGross: 23.8 }).checks).toEqual([]);
    expect(readAmounts(F.OPENAI_TORN, { currency: 'USD', modelGross: 20 })).toMatchObject({ gross: 23.8, checks: ['total_conflict'] });
  });

  it('Leap: a printed rate that is not a German one, 30.00 and not 24.00', () => {
    expect(readAmounts(F.LEAP_TORN, { currency: 'USD' })).toMatchObject({ gross: 30, net: 24, taxRate: 25, checks: [] });
    expect(readAmounts(F.LEAP_TORN, { currency: 'USD', modelGross: 24 })).toMatchObject({ gross: 30, checks: ['total_conflict'] });
  });

  it('Webflow: three labels above five amounts', () => {
    expect(readAmounts(F.WEBFLOW_LABELS_THEN_AMOUNTS, { currency: 'USD' })).toMatchObject({ gross: 21.42, net: 18, taxRate: 19, checks: [] });
    expect(readAmounts(F.WEBFLOW_LABELS_THEN_AMOUNTS, { currency: 'USD', modelGross: 18 })).toMatchObject({ gross: 21.42, checks: ['total_conflict'] });
  });

  it('a tax named without its rate counts where its sum with the net is printed', () => {
    expect(readAmounts(F.NOTION_TAX_WITHOUT_RATE, { currency: 'USD' })).toMatchObject({ gross: 26.18, net: 22, taxRate: 19, checks: [] });
  });

  it('no rate is worked out for a foreign receipt that prints no tax', () => {
    // 20.00 and 3.80 would be 19 percent, but nothing on the receipt names a tax or a rate.
    expect(readAmounts('Shop\nItem 20.00\nShipping 3.80\nTotal 23.80', { currency: 'USD' })).toMatchObject({ gross: 23.8, net: 23.8, taxRate: 0, taxPrinted: false });
    // A printed percentage that is a discount, not a rate: the pair it fits is not borne out by a printed sum.
    expect(readAmounts('Course\nSubtotal $450.00\nDiscount (20% off) -$90.00\nTotal $360.00', { currency: 'USD' })).toMatchObject({ gross: 360, taxRate: 0 });
  });
});

describe('a second reading that agrees with a part of the bill', () => {
  it('A2 Hosting: "Total" as a column heading above the items, 22.54 and not 9.47', () => {
    const none = readAmounts(F.HOSTING_TOTAL_AS_A_COLUMN_HEADING, { date: '2025-02-17' });
    expect(none).toMatchObject({ gross: 22.54, checks: ['total_unconfirmed', 'tax_estimated'] });
    expect(readAmounts(F.HOSTING_TOTAL_AS_A_COLUMN_HEADING, { date: '2025-02-17', modelGross: 22.54 }).checks).toEqual(['tax_estimated']);
    // Production: the second reading said 9.47, a labelled amount, and was believed.
    const part = readAmounts(F.HOSTING_TOTAL_AS_A_COLUMN_HEADING, { date: '2025-02-17', modelGross: 9.47 });
    expect(part.gross).toBe(22.54);
    expect(part.checks).toContain('total_conflict');
  });

  it('still takes its word where no larger total is labelled below it', () => {
    expect(readAmounts('Summe 40,00\nBetrag Gutschein 5,00', { modelGross: 40 })).toMatchObject({ gross: 40, checks: ['tax_estimated'] });
  });
});

describe('Cursor: the amount due and the invoice total', () => {
  it('the headline "US$19.22 due ..." is the total of a long usage invoice, not the limit a note mentions', () => {
    expect(readAmounts(F.CURSOR_USAGE_HEADLINE_ONLY, { currency: 'USD' })).toMatchObject({ gross: 19.22, checks: ['total_unconfirmed'] });
    // Production: the second reading saw only the first pages and answered 200.00.
    expect(readAmounts(F.CURSOR_USAGE_HEADLINE_ONLY, { currency: 'USD', modelGross: 200 })).toMatchObject({ gross: 19.22, checks: ['total_conflict'] });
    expect(readAmounts(F.CURSOR_USAGE_HEADLINE_ONLY, { currency: 'USD', modelGross: 19.22 }).checks).toEqual([]);
  });

  it('an earlier balance added on top: the invoice total is 20.00, not the 20.40 due', () => {
    expect(readAmounts(F.CURSOR_BALANCE_ADDED_TORN, { currency: 'USD' }).gross).toBe(20);
    expect(readAmounts(F.CURSOR_BALANCE_ADDED_TORN, { currency: 'USD', modelGross: 20.4 })).toMatchObject({ gross: 20, checks: ['total_conflict'] });
  });

  it('paid from a credit balance: 0.40, although nothing is left to pay', () => {
    for (const text of [F.CURSOR_PAID_FROM_BALANCE, F.CURSOR_PAID_FROM_BALANCE_TORN]) {
      expect(readAmounts(text, { currency: 'USD' }).gross).toBe(0.4);
      expect(readAmounts(text, { currency: 'USD', modelGross: 0.4 })).toMatchObject({ gross: 0.4, checks: [] });
    }
  });

  it('without a credit or balance the amount due is the total', () => {
    expect(readAmounts(F.CURSOR_DUE_LATER, { currency: 'USD' }).gross).toBe(20);
    expect(readAmounts('Total 100,00\nVersand 5,00\nFälliger Betrag 105,00').gross).toBe(105);
  });

  it('a label inside a run of labels names nothing by its position', () => {
    // "Amount due" stands above 3.80, the value of the first label of the run.
    expect(readAmounts('Shop\nTax\nTotal\nAmount due\n$3.80\n$23.80\n$23.80', { currency: 'USD' })).toMatchObject({ gross: null, checks: ['total_missing'] });
  });
});

describe('a total the tax lines do not add up to', () => {
  it('a promotion after the tax lines: the grand total is what was paid', () => {
    const a = readAmounts(F.MARKETPLACE_PROMOTION_AFTER_TAX);
    expect(a).toMatchObject({ gross: 197.7, net: null, taxRate: 19, taxPrinted: true, taxGroups: [], checks: [] });
  });

  it('the same with labels and amounts torn apart: the minus sign names the deduction', () => {
    expect(readAmounts(F.MARKETPLACE_PROMOTION_TORN)).toMatchObject({ gross: 197.7, taxRate: 19, taxPrinted: true, checks: [] });
    // Without its sign the amount is not known to be taken off, and above the tax lines it is no deduction from their sum.
    expect(readAmounts(F.MARKETPLACE_PROMOTION_TORN.replace('-€1.96', '€1.96')).gross).toBe(199.66);
    expect(readAmounts('-€1.96\n€197.70\n€167.78\n€31.88\n€199.66\nVAT 19%').gross).toBe(199.66);
  });

  it('a total printed below the tax lines without a deduction between them is not taken', () => {
    expect(readAmounts('Netto 100,00\nMwSt 19% 19,00\nSumme 119,00\nAnzahlung 50,00').gross).toBe(119);
    expect(readAmounts('Netto 100,00\nMwSt 19% 19,00\nSumme 119,00\nRestbetrag 69,00').gross).toBe(119);
  });

  it('a customs invoice: the tax lines cover the service fees, the total covers the duties too', () => {
    const a = readAmounts(F.CUSTOMS_TAXED_AND_UNTAXED, { date: '2025-05-06' });
    expect(a).toMatchObject({ gross: 226.14, net: 217.02, taxRate: 19, taxPrinted: true, checks: [] });
    expect(a.taxGroups).toEqual([{ rate: 19, net: 47.97, tax: 9.12, gross: 57.09 }]);
  });

  it('a tip on top of the bill is not such a total', () => {
    const a = readAmounts('Netto 49,33\nMwSt 19% 9,37\nSumme 58,70\nTrinkgeld 2,70\nBezahlter Betrag 61,40');
    expect(a).toMatchObject({ gross: 58.7, tip: 2.7 });
  });
});

describe('totals that had no label, or the wrong one', () => {
  it('a total with no label under its tax line: net and tax add up to it', () => {
    expect(readAmounts(F.RESELLER_TOTAL_WITHOUT_LABEL, { currency: 'USD' })).toMatchObject({ gross: 14.28, net: 12, taxRate: 19, checks: [] });
  });

  it('a tax breakdown below the total: the last labelled amount is the tax, the total stays', () => {
    expect(readAmounts(F.TAX_BREAKDOWN_BELOW_THE_TOTAL, { currency: 'USD' })).toMatchObject({ gross: 17.84, net: 14.99, taxRate: 19, checks: [] });
  });

  it('an invoice paid in full, with a conversion next to it: the total, not the zero left to pay', () => {
    expect(readAmounts(F.TWO_CURRENCIES_PAID_IN_FULL, { currency: 'USD' })).toMatchObject({ gross: 23.79, net: 19.99, taxRate: 19, checks: [] });
  });

  it('"Gesamtpreis" names a total', () => {
    expect(readAmounts('Fahrkarte Musterstadt - Beispielstadt\nGesamtpreis 35,90 €').gross).toBe(35.9);
    expect(readAmounts('Gesamtpreis\n35,90 €').gross).toBe(35.9);
  });
});
