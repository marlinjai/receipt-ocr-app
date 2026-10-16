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

describe('a tax needs a line that names it', () => {
  it('two usage lines that happen to fit 7 percent are no tax: the bill is the net, at rate 0', () => {
    const reading = readAmounts(F.USAGE_TWO_LINES_NO_TAX, { currency: 'USD' });
    // The invoice prints its tax of 0 itself, so the rate 0 is printed, not assumed.
    expect(reading).toMatchObject({ gross: 20.06, net: 20.06, taxRate: 0, taxPrinted: true, taxGroups: [] });
    // The same figures in euros: no rate is made up from them; the rate is the default, and the check says so.
    const euros = readAmounts(F.USAGE_TWO_LINES_NO_TAX.replaceAll('US$', '€'), { currency: 'EUR' });
    expect(euros.gross).toBe(20.06);
    expect(euros.taxGroups).toEqual([]);
    expect(euros.checks).toContain('tax_estimated');
  });

  it('a page of cent amounts holds a pair for a rate, which is not the bill', () => {
    expect(readAmounts(F.USAGE_TABLE_OF_CENTS, { currency: 'USD' })).toMatchObject({ gross: 5, taxGroups: [] });
    expect(readAmounts(F.USAGE_TABLE_OF_CENTS.replaceAll('$', '€').replace(' USD', ''), { currency: 'EUR' })).toMatchObject({ gross: 5, taxGroups: [] });
  });

  it('a word that only contains the letters of a tax word names no tax', () => {
    // "Musterversand" holds "ust": shipping of 5.90 is about 7 percent of 84.00 and was taken as its tax.
    const order = ['Musterversand', 'Total 84.00 EUR', 'Shipping 5.90 EUR', 'Grand Total 89.90 EUR'].join('\n');
    expect(readAmounts(order)).toMatchObject({ gross: 89.9, taxGroups: [], checks: ['total_unconfirmed', 'tax_estimated'] });
  });

  it('a tax named on its own line still counts, and so does one a label names in a torn block', () => {
    expect(readAmounts('Shop\nItem 20.00\nVAT 19% 3.80\nTotal 23.80', { currency: 'USD' })).toMatchObject({ gross: 23.8, net: 20, taxRate: 19 });
    expect(readAmounts('Netto\nMwSt\nSumme\n20,00\n3,80\n23,80')).toMatchObject({ gross: 23.8, net: 20, taxRate: 19, checks: [] });
  });

  it('a VAT identification number or a tax number is no tax label', () => {
    expect(readAmounts('Shop\nUSt-IdNr. DE123456789\nItem 20,00\nVersand 3,80\nGesamt 23,80')).toMatchObject({ gross: 23.8, taxGroups: [] });
    expect(readAmounts('Shop\nSteuernummer 12/345/67890\nItem 20,00\nVersand 3,80\nGesamt 23,80')).toMatchObject({ gross: 23.8, taxGroups: [] });
  });
});

describe('what still names a tax, and what states that there is none', () => {
  it('a bottle deposit at 0 percent next to the 19 percent line keeps the 19 percent group, with the labels on their lines and torn off', () => {
    const inline = ['Getränkemarkt', 'Saft 10,00 A', 'Pfand 0,25 B', 'MwSt 19% 10,00 1,90 11,90', 'MwSt 0% 0,25 0,00 0,25', 'Summe 12,15'].join('\n');
    const torn = ['Getränkemarkt', 'Saft', '10,00', 'Pfand', '0,25', 'MwSt 19%', 'MwSt 0%', 'Summe', '11,90', '0,25', '12,15', '1,90'].join('\n');
    for (const text of [inline, torn]) {
      const reading = readAmounts(text, { date: '2026-03-01' });
      expect(reading).toMatchObject({ taxRate: 19, taxPrinted: true });
      expect(reading.taxGroups).toEqual([{ rate: 19, net: 10, tax: 1.9, gross: 11.9 }]);
    }
  });

  it('the column heading "VAT Code" is a tax label, "VAT-Code: XX-0000" is not', () => {
    const uk = ['Shop Ltd', 'VAT Code Rate Net VAT', 'A 20% 10.00 2.00', 'Total 12.00'].join('\n');
    expect(readAmounts(uk, { currency: 'GBP' })).toMatchObject({ gross: 12, net: 10, taxRate: 20 });
    const german = ['Laden', 'MwSt-Code Netto MwSt Brutto', 'A 19% 10,00 1,90 11,90', 'Summe 11,90'].join('\n');
    expect(readAmounts(german, { date: '2026-03-01' })).toMatchObject({ gross: 11.9, net: 10, taxRate: 19, checks: [] });
  });

  it('a long till line with its figures names its tax; a long sentence without any does not', () => {
    const long = 'Gesamtbetrag 11,90 EUR enthaelt 19% Mehrwertsteuer 1,90 EUR Nettobetrag 10,00 EUR';
    expect(readAmounts(long, { date: '2026-03-01' })).toMatchObject({ gross: 11.9, net: 10, taxRate: 19 });
    const sentence = ['Example Inc.', 'Item 18.76', 'Item 1.30', 'Tax will vary based on your jurisdiction and is calculated at checkout', 'Total 20.06'].join('\n');
    expect(readAmounts(sentence, { currency: 'USD' })).toMatchObject({ gross: 20.06, taxGroups: [] });
  });

  it('"Steuerberatung" is no tax word, and an invoice stating that no tax is charged gets none', () => {
    expect(readAmounts('Kanzlei\nSteuerberatung 100,00\nAuslagen 7,00\nGesamt 107,00', { date: '2026-03-01' }).taxGroups).toEqual([]);
    const smallBusiness = ['Grafikbüro', 'Leistung 10,00', 'Betrag 1,90', 'Gesamt 11,90', 'Gemäß § 19 UStG wird keine Umsatzsteuer berechnet.'].join('\n');
    expect(readAmounts(smallBusiness, { date: '2026-03-01' }).taxGroups).toEqual([]);
    expect(readAmounts(['Agentur', 'Leistung 100,00', 'Gesamt 100,00', 'Reverse Charge'].join('\n')).taxGroups).toEqual([]);
  });

  it('a till receipt that prints only its rate ("A 19%") still proves its tax', () => {
    expect(readAmounts(['Laden', 'A 19%', '10,00', '1,90', 'Summe 11,90'].join('\n'), { date: '2026-03-01' })).toMatchObject({ gross: 11.9, net: 10, taxRate: 19 });
  });

  it('a tax line of 0,00 % or 0 states no tax; one of 10 % does not', () => {
    expect(readAmounts(['Shop', 'Item 20,00', 'Versand 1,40', 'MwSt 0,00 %', 'Gesamt 21,40'].join('\n'), { date: '2026-03-01' }).taxGroups).toEqual([]);
    expect(readAmounts(['Shop', 'Item 100.00', 'VAT 10% 10.00', 'Total 110.00'].join('\n'), { currency: 'USD' })).toMatchObject({ gross: 110, net: 100, taxRate: 10 });
  });

  it('a tax amount on the line below its label counts with a "US$" in front', () => {
    expect(readAmounts(['Example Inc.', 'Subtotal', 'US$20.00', 'VAT', 'US$3.80', 'Total', 'US$23.80'].join('\n'), { currency: 'USD' })).toMatchObject({ gross: 23.8, net: 20, taxRate: 19 });
  });

  it('a tax number named "St.-Nr." is no tax label', () => {
    expect(readAmounts('Shop\nSt.-Nr. 12/345/67890\nItem 20,00\nVersand 3,80\nGesamt 23,80').taxGroups).toEqual([]);
  });
});

describe('a line that is tax-free does not make the receipt tax-free', () => {
  it('a till row "A 19%" and a deposit line at 0 percent: the 19 percent stands', () => {
    for (const text of [
      ['Getränkemarkt', 'Summe 2,15', 'A 19% 1,60 0,30 1,90', 'MwSt C 0% 0,25 0,00'].join('\n'),
      ['Getränkemarkt', 'Summe 2,15', 'MwSt 0,00 % 0,00', 'A 19 % 0,30 1,60 1,90'].join('\n'),
      ['Getränkemarkt', '19%', 'MwSt 0% 0,00', '1,60', '0,30', '1,90', 'Summe 2,15'].join('\n'),
    ]) {
      const reading = readAmounts(text, { date: '2026-03-01' });
      expect(reading.taxRate).toBe(19);
      expect(reading.taxGroups[0]).toMatchObject({ rate: 19, net: 1.6, tax: 0.3 });
    }
  });

  it('a deposit or a voucher marked "steuerfrei" leaves the printed tax of the other lines', () => {
    const deposit = ['Discounter', 'Pfand steuerfrei 0,25', 'zu zahlen 2,15', 'MWST% MWST NETTO BRUTTO', 'A 19,00% 0,30 1,60 1,90'].join('\n');
    expect(readAmounts(deposit, { date: '2026-03-01' }).taxGroups).toEqual([{ rate: 19, net: 1.6, tax: 0.3, gross: 1.9 }]);
    const voucher = ['Buchladen', 'Gutschein steuerfrei 10,00', 'MwSt', '1,87', '0,13', '2,00', 'Summe 2,00'].join('\n');
    expect(readAmounts(voucher, { date: '2026-03-01' }).taxGroups).toEqual([{ rate: 7, net: 1.87, tax: 0.13, gross: 2 }]);
  });

  it('another tax that ends in "steuer" names no value-added tax', () => {
    const utility = ['Stadtwerke Beispiel', 'Grundsteuer 107,00', 'Wasser 100,00', 'Muell 7,00', 'Gesamtbetrag 214,00'].join('\n');
    expect(readAmounts(utility, { date: '2026-03-01' })).toMatchObject({ gross: 214, taxGroups: [] });
    expect(readAmounts(['Zulassungsstelle', 'Kfz-Steuer 100,00', 'Gebühr 7,00', 'Gesamt 107,00'].join('\n'), { date: '2026-03-01' }).taxGroups).toEqual([]);
  });
});

describe('a payment or a net figure set off by a dash is no deduction', () => {
  // A mail-scanning invoice, paid on issue: the net is printed after a dash, the payment with a minus.
  const PAID_ON_ISSUE = [
    'Example Post GmbH',
    'Rechnungsbetrag 3,99 €',
    'USt.-Nr. : DE123456789',
    'BESCHREIBUNG',
    'BETRAG (EUR)',
    'Tarif "Minimal", Jahresabonnement',
    '3,99 €',
    '3,99 €',
    'Gesamtsumme',
    '3,99 €',
    'Zahlungen',
    '-3,99 €',
    'Fälliger Betrag (EUR)',
    '0,00 €',
    '(inkl. USt.)',
    'UST.-DETAILS',
    'Gesamtsumme (zzgl. USt.) - 3,35 €',
    'USt. bei 19 % (0,64 €).',
    '3,99 € wurden am 01 Feb, 2021 bezahlt.',
  ].join('\n');

  it('3.99 is the total, not the tax of 0.64 that was left after taking off the net', () => {
    expect(readAmounts(PAID_ON_ISSUE, { date: '2021-02-01' })).toMatchObject({ gross: 3.99, net: 3.35, taxRate: 19, checks: [] });
    expect(readAmounts(PAID_ON_ISSUE.replaceAll('3,99', '12,99').replace('3,35', '10,92').replace('0,64', '2,07'), { date: '2023-04-01' })).toMatchObject({ gross: 12.99, net: 10.92, taxRate: 19 });
  });

  it('a page reading of the tax amount does not move it', () => {
    expect(readAmounts(PAID_ON_ISSUE, { date: '2021-02-01', modelGross: 0.64, modelSawPage: true })).toMatchObject({ gross: 3.99, checks: ['total_conflict'] });
  });

  it('a real deduction with a minus still counts', () => {
    expect(readAmounts(F.MARKETPLACE_PROMOTION_TORN).gross).toBe(197.7);
  });
});

describe('the total a mobile bill names as its own', () => {
  // A taxed part (net with four decimals, tax 7.18), a fee at 0 percent, then the sum to pay with an earlier balance
  // and a list of account movements whose "Summe Brutto" is the earlier invoice.
  const BILL = [
    'Ihre Mobilfunk Rechnung',
    'Rechnungsbetrag netto (0% USt.)',
    'Rechnungsbetrag netto (19% USt.)',
    '4,5000 €',
    '37,7732 €',
    'USt. Betrag (0%)',
    'USt. Betrag (19%)',
    '0,00 €',
    '7,18 €',
    'Rechnungsbetrag gesamt',
    '49,45 €',
    'Kontostand vom 15.04.2026',
    'Zu zahlender Betrag',
    '44,95 €',
    '94,40 €',
    'Kontobewegungen',
    'Rechnung vom 17.03.2026',
    '44,95 €',
    'Summe Brutto',
    '44,95 €',
  ].join('\n');

  it('the invoice total with the fee at 0 percent stands over the taxed part and over the sum to pay', () => {
    expect(readAmounts(BILL, { date: '2026-04-16' })).toMatchObject({ gross: 49.45, net: 42.27, taxRate: 19 });
    // A page reading of the earlier invoice's sum is a conflict, never the total.
    expect(readAmounts(BILL, { date: '2026-04-16', modelGross: 44.95, modelSawPage: true })).toMatchObject({ gross: 49.45, checks: ['total_conflict'] });
  });

  it('without a fee, a small balance on top is not the total either', () => {
    const plain = [
      'Ihre Mobilfunk Rechnung',
      'Rechnungsbetrag netto',
      'USt.-Betrag (19%)',
      '37,7732 €',
      '7,18 €',
      'Rechnungsbetrag gesamt',
      '44,95 €',
      'Kontostand vom 16.08.2026',
      'Zu zahlender Betrag',
      '0,04 €',
      '44,99 €',
    ].join('\n');
    expect(readAmounts(plain, { date: '2026-08-17' })).toMatchObject({ gross: 44.95, net: 37.77, taxRate: 19 });
  });
});

describe('what still is a deduction, and what is no earlier balance', () => {
  const bill = (minusLine: string) => ['Musterladen', 'Netto 10,00', 'MwSt 19% 1,90', 'Zwischensumme 11,90', minusLine, 'Summe 9,90'].join('\n');

  it('a discount, a coupon or a promotion stays a deduction whatever else its line says', () => {
    for (const line of ['Rabatt bei Zahlung per App -2,00', 'Netto-Coupon -2,00', 'Exklusiv-Aktion -2,00', 'Prepaid Bonus -2,00', 'Zuzahlung Kasse -2,00', 'Sommeraktion netto -2,00', 'Neukundenbonus (zzgl. MwSt.) -2,00']) {
      expect(readAmounts(bill(line), { date: '2026-03-01' }).gross).toBe(9.9);
    }
    // A label above a bare amount, too.
    expect(readAmounts(['Musterladen', 'Netto 10,00', 'MwSt 19% 1,90', 'Zwischensumme 11,90', 'Gutschein netto', '-2,00', 'Summe 9,90'].join('\n'), { date: '2026-03-01' }).gross).toBe(9.9);
  });

  it('"Transaktion" is no promotion: a payment line that names one is still a payment', () => {
    expect(readAmounts(bill('Zahlung Transaktion 4711 -2,00'), { date: '2026-03-01' }).gross).toBe(11.9);
  });

  it('a payment, also with its label above the amount, is none', () => {
    expect(readAmounts(['Musterladen', 'Netto 10,00', 'MwSt 19% 1,90', 'Gesamtsumme 11,90', 'Zahlungen', '-11,90', 'Fälliger Betrag 0,00'].join('\n'), { date: '2026-03-01' })).toMatchObject({ gross: 11.9, checks: [] });
  });

  it('a new account balance is no balance set against the bill', () => {
    const slip = ['Musterladen', 'Netto 10,00', 'MwSt 19% 1,90', 'Summe 11,90', 'Neuer Kontostand 20,00', 'Zu zahlender Betrag 11,90'].join('\n');
    expect(readAmounts(slip, { date: '2026-03-01' }).gross).toBe(11.9);
  });
});

describe('the invoice total above the taxed part needs the part to be printed', () => {
  it('a gap no printed figure explains keeps the taxed part', () => {
    const misread = ['Ihre Rechnung', 'Netto 10,00', 'MwSt 19% 1,90', 'Leistung brutto 11,90', 'Gebühr USt 0 %', 'Rechnungsbetrag gesamt', '1.190,00 €'].join('\n');
    expect(readAmounts(misread, { date: '2026-03-01' }).gross).toBe(11.9);
  });
});

describe('the net set off by a dash, whatever it is called, and an earlier invoice with the same label', () => {
  const paid = (netLine: string) =>
    ['Example Post GmbH', 'Gesamtsumme', '3,99 €', 'Zahlungen', '-3,99 €', 'Fälliger Betrag (EUR)', '0,00 €', netLine, 'USt. bei 19 % (0,64 €).'].join('\n');

  it('a minus that leaves exactly the tax is never a deduction', () => {
    for (const line of ['Nettobetrag - 3,35 €', 'Zwischensumme - 3,35 €', 'Subtotal - 3,35 €', 'Gesamtsumme Aktionstarif (zzgl. USt.) - 3,35 €', 'Transaktion - 3,35 €']) {
      expect(readAmounts(paid(line), { date: '2021-02-01' }).gross).toBe(3.99);
    }
  });

  it('an earlier invoice listed below with the same label does not take the place of the invoice own total', () => {
    const bill = [
      'Ihre Mobilfunk Rechnung',
      'Rechnungsbetrag netto (0% USt.)',
      'Rechnungsbetrag netto (19% USt.)',
      '4,5000 €',
      '37,7732 €',
      'USt. Betrag (0%)',
      'USt. Betrag (19%)',
      '0,00 €',
      '7,18 €',
      'Rechnungsbetrag gesamt',
      '49,45 €',
      'Kontobewegungen',
      'Rechnung vom 17.03.2026',
      'Rechnungsbetrag gesamt 44,95 €',
    ].join('\n');
    expect(readAmounts(bill, { date: '2026-04-16' })).toMatchObject({ gross: 49.45, net: 42.27 });
  });
});

describe('the amount reader names the first rate in the one order', () => {
  it('two 7 percent groups that together carry more than the 19 percent one: 7 comes first', () => {
    // 7 percent: 50.00/3.50 and 40.00/2.80 (96.30 together); 19 percent: 80.00/15.20 (95.20).
    const text = ['Musterladen', 'MwSt 7% 50,00 3,50 53,50', 'MwSt 7% 40,00 2,80 42,80', 'MwSt 19% 80,00 15,20 95,20', 'Summe 191,50'].join('\n');
    const reading = readAmounts(text, { date: '2026-03-01' });
    expect(reading.taxRate).toBe(7);
    expect(reading.taxGroups.map((g) => g.rate)).toEqual([7, 7, 19]);
  });

  it('a tie goes to the higher rate', () => {
    const text = ['Musterladen', 'MwSt 7% 100,00 7,00 107,00', 'MwSt 19% 89,92 17,08 107,00', 'Summe 214,00'].join('\n');
    expect(readAmounts(text, { date: '2026-03-01' }).taxRate).toBe(19);
  });
});

describe('a tip nothing names, between the bill and what was paid', () => {
  const CAFE_SLIP = ['Example Bakery', '09.07.2026', 'Zimtschnecke 5,00', 'Kaffee 4,50', 'Total', '19,30', 'Grand total', '21,23', 'Given (Kartenzahlung)', '21,23', 'MwSt 7% 1,26'].join('\n');

  it('the bill stays the total, and the difference to the paid amount is the tip', () => {
    expect(readAmounts(CAFE_SLIP, { date: '2026-07-09' })).toMatchObject({ gross: 19.3, tip: 1.93 });
  });

  it('a difference printed as a figure of its own (shipping, a fee) is no tip', () => {
    const order = CAFE_SLIP.replace('Grand total', 'Versand 1,93\nGrand total');
    expect(readAmounts(order, { date: '2026-07-09' }).tip).toBeNull();
  });

  it('more than 30 percent on top is no tip, and a paid amount above the bill line is not looked at', () => {
    expect(readAmounts(CAFE_SLIP.replaceAll('21,23', '29,00'), { date: '2026-07-09' }).tip).toBeNull();
    const before = ['Example Bakery', 'Grand total 21,23', 'Total', '19,30', 'MwSt 7% 1,26'].join('\n');
    expect(readAmounts(before, { date: '2026-07-09' }).tip).toBeNull();
  });

  it('a named tip is read as before', () => {
    const named = ['Example Cafe', 'Summe 11,30', 'MwSt 19% 1,80', 'TIP / TOTAL', '3,70', '15,00'].join('\n');
    expect(readAmounts(named, { date: '2026-04-05' })).toMatchObject({ gross: 11.3, tip: 3.7 });
  });
});

describe('what between the bill and the paid amount is no tip', () => {
  const groups = (between: string[], paid: string) => ['Pizzeria Beispiel', 'Netto 15,13', 'MwSt 19% 2,87', 'Summe', '18,00', ...between, paid].join('\n');

  it('delivery fees or deposits, however many', () => {
    expect(readAmounts(groups(['Lieferkosten 2,49', 'Servicegebühr 0,99'], 'Bezahlt 21,48'), { date: '2026-03-01' }).tip).toBeNull();
    expect(readAmounts(groups(['Pfand 0,25', 'Pfand 0,25'], 'Endsumme 18,50'), { date: '2026-03-01' }).tip).toBeNull();
  });

  it('a balance carried over, cash handed over, another currency', () => {
    expect(readAmounts(groups(['Status: Bezahlt'], 'Gesamt inkl. Vorsaldo 22,40'), { date: '2026-03-01' }).tip).toBeNull();
    expect(readAmounts(groups(['Bar 20,00'], 'Bezahlt 20,00'), { date: '2026-03-01' }).tip).toBeNull();
    expect(readAmounts(groups([], 'Grand total CHF 20,00').replace('18,00', '18,00 EUR'), { date: '2026-03-01' }).tip).toBeNull();
  });

  it('paid by card, the difference is the tip, also where the model read the paid amount from the page', () => {
    const slip = groups([], 'Grand total 20,00') + '\nKartenzahlung';
    expect(readAmounts(slip, { date: '2026-03-01' })).toMatchObject({ gross: 18, tip: 2, checks: [] });
    expect(readAmounts(slip, { date: '2026-03-01', modelGross: 20, modelSawPage: true })).toMatchObject({ gross: 18, tip: 2, checks: [] });
  });
});

describe('an unnamed tip after the recheck', () => {
  it('the own tax lines of the bill between the bill and the paid amount are no fee', () => {
    const taxAfter = ['Example Cafe', 'Summe 18,00', 'MwSt 19% 2,87', 'Netto 15,13', 'Kartenzahlung', 'Bezahlt 20,00'].join('\n');
    expect(readAmounts(taxAfter, { date: '2026-03-01' })).toMatchObject({ gross: 18, tip: 2 });
    const itemThenSum = ['Example Cafe', 'Kaffee 18,00', 'Summe 18,00', 'enth. MwSt 2,87', 'Grand total 20,00', 'Karte'].join('\n');
    expect(readAmounts(itemThenSum, { date: '2026-03-01' })).toMatchObject({ gross: 18, tip: 2 });
    expect(readAmounts(itemThenSum, { date: '2026-03-01', modelGross: 20, modelSawPage: true }).checks).not.toContain('total_conflict');
  });

  it('a terminal status line, a bar in the venue name: still a tip; cash next to an amount: none', () => {
    const slip = (extra: string) => ['Sky Bar', 'Netto 15,13', 'MwSt 19% 2,87', 'Summe', '18,00', 'Grand total 20,00', extra].join('\n');
    expect(readAmounts(slip('Status: Approved'), { date: '2026-03-01' }).tip).toBe(2);
    expect(readAmounts(slip('Danke'), { date: '2026-03-01' }).tip).toBe(2);
    expect(readAmounts(slip('Barzahlung 20,00'), { date: '2026-03-01' }).tip).toBeNull();
  });

  it('a paid amount in another currency, also one not kept by the app, is no tip; a word holding "eur" names none', () => {
    const slip = (paid: string) => ['Example Cafe', 'Netto 15,13', 'MwSt 19% 2,87', 'Summe', '18,00', paid, 'Karte'].join('\n');
    expect(readAmounts(slip('Grand total DKK 20,00'), { date: '2026-03-01' }).tip).toBeNull();
    expect(readAmounts(slip('Grand total 20,00 kr'), { date: '2026-03-01' }).tip).toBeNull();
    expect(readAmounts(slip('Grand total Friseur 20,00'), { date: '2026-03-01' }).tip).toBe(2);
  });
});
