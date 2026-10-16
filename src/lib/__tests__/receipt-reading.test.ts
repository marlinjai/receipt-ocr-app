import { describe, expect, it } from 'vitest';
import { extractReceiptFields } from '../extract-receipt-fields';
import { settleCurrency, settleDate, settleReading, type ModelReading } from '../receipt-reading';
import { EMPTY_MEAL_CLASSIFICATION } from '../meals/classify';

/** All documents here are invented, in the layout of real ones. */

const answer = (extra: Partial<ModelReading> = {}): ModelReading => ({
  item: 'Posten',
  category: 'Software & Lizenzen',
  konto: '4806',
  zuordnung: null,
  taxRate: null,
  vendor: null,
  gross: null,
  net: null,
  date: null,
  currency: null,
  noTotal: false,
  sawPage: true,
  meal: { ...EMPTY_MEAL_CLASSIFICATION },
  ...extra,
});

const day = (iso: string) => `${iso}T00:00:00.000Z`;
const settle = (text: string, ai: ModelReading | null) => settleReading(text, extractReceiptFields({ fullText: text, blocks: [], confidence: 0.95 }), ai);

describe('settleDate: the labelled date of the text stands', () => {
  const LABELLED = 'Example Cloud Inc.\nInvoice date: 5 Jan 2025\nDue date: 4 Feb 2025\nService period 1 Dec 2024 - 31 Dec 2024';

  it('agreeing readings raise nothing', () => {
    expect(settleDate(LABELLED, answer({ date: day('2025-01-05') }))).toEqual({ date: day('2025-01-05'), conflict: false });
  });

  it('a differing page date never overwrites a labelled one: it is a conflict', () => {
    expect(settleDate(LABELLED, answer({ date: day('2024-12-31') }))).toEqual({ date: day('2025-01-05'), conflict: true });
  });

  it('a date nothing names gives way to the page date, if the text prints that day', () => {
    const text = 'Example Hosting\n1 Mar 2025 - 31 Mar 2025\n4 Apr 2025\nTotal $10.00';
    // Without the page the reader can only take the first date it finds unlabelled.
    expect(settleDate(text, null).date).toBe(day('2025-04-04'));
    expect(settleDate(text, answer({ date: day('2025-04-04') }))).toEqual({ date: day('2025-04-04'), conflict: false });
    expect(settleDate('Example Hosting\n1 Mar 2025 - 31 Mar 2025\nTotal $10.00', answer({ date: day('2025-03-31') }))).toEqual({ date: day('2025-03-31'), conflict: false });
  });

  it('an order date gives way to the invoice date the page reads, and says so', () => {
    const text = 'Musterversand\nBestelldatum 24.04.2025\nRechnungsnummer DE-1\n26.04.2025\nGesamt 59,00';
    expect(settleDate(text, null).date).toBe(day('2025-04-24'));
    expect(settleDate(text, answer({ date: day('2025-04-26') }))).toEqual({ date: day('2025-04-26'), conflict: true });
    // A day the text does not print never replaces it.
    expect(settleDate(text, answer({ date: day('2025-04-27') }))).toEqual({ date: day('2025-04-24'), conflict: true });
  });

  it('fills a gap from the page; a day the text does not print is filled in as a conflict, never silently', () => {
    // A scanned till slip: the recognized text lost the date line.
    expect(settleDate('Musterladen\nSumme 5,00', answer({ date: day('2025-03-14') }))).toEqual({ date: day('2025-03-14'), conflict: true });
    // A due date is all the text finds: it is never the invoice date, so this is a gap too, and the day is printed.
    expect(settleDate('Example Cloud Inc.\nDue date: 4 Feb 2025\n5 Jan 25 09:12 Terminal 2', answer({ date: day('2025-01-05') })).conflict).toBe(false);
  });

  it('the page reading names no date: a date the text does not call the invoice date is kept as a conflict', () => {
    // A ticket that prints the day of the event only.
    const ticket = 'Mustermesse 2026\nTagesticket\n12.03.2026\nGesamt 25,00';
    expect(settleDate(ticket, answer({ date: null }))).toEqual({ date: day('2026-03-12'), conflict: true });
    expect(settleDate('Musterladen\nRechnungsdatum 14.03.2025', answer({ date: null }))).toEqual({ date: day('2025-03-14'), conflict: false });
    expect(settleDate('Musterladen\nSumme 5,00', answer({ date: null }))).toEqual({ date: null, conflict: false });
  });

  it('a page date that is not printed does not replace an unlabelled one, and says so', () => {
    expect(settleDate('Musterladen\n14.03.2025\nSumme 5,00', answer({ date: day('2025-03-15') }))).toEqual({ date: day('2025-03-14'), conflict: true });
  });

  it('a day the text calls the due date is not a printed invoice day: taken from the page only as a conflict', () => {
    const text = 'Example Cloud Inc.\nDue date: 4 Feb 2025\nTotal $10.00';
    expect(settleDate(text, answer({ date: day('2025-02-04') }))).toEqual({ date: day('2025-02-04'), conflict: true });
  });

  it('the date of a model that read the text alone is not used', () => {
    expect(settleDate('Musterladen\n14.03.2025\n20.03.2025', answer({ sawPage: false, date: day('2025-03-20') }))).toEqual({ date: day('2025-03-14'), conflict: false });
  });
});

describe('settleCurrency', () => {
  it('a currency the text settles stands', () => {
    expect(settleCurrency('Total USD 10.00', { currency: 'USD', currencyShown: true }, answer({ currency: 'EUR' }))).toBe('USD');
  });

  it('among mixed signs the page reading decides', () => {
    const text = 'Plan $20.00\nVAT €3.80\nTotal €23.80\nYou saved $2.00\nCredit $1.00';
    expect(settleCurrency(text, { currency: 'USD', currencyShown: false }, answer({ currency: 'EUR' }))).toBe('EUR');
  });

  it('a currency the text shows nothing of is not taken', () => {
    expect(settleCurrency('Summe 10,00', { currency: 'EUR', currencyShown: false }, answer({ currency: 'USD' }))).toBe('EUR');
    expect(settleCurrency('Total 10.00 $', { currency: 'USD', currencyShown: true }, answer({ currency: 'CHF' }))).toBe('USD');
  });
});

describe('settleReading: one receipt from its two readings', () => {
  it('no model answer: the text reading with a visible note, never a failure', () => {
    const settled = settle('Musterbäckerei\n14.03.2025\nNetto 3,27\nMwSt 7% 0,23\nSumme 3,50', null);
    expect(settled).toMatchObject({ gross: 3.5, date: day('2025-03-14') });
    expect(settled.flags).toEqual(['not_classified']);
  });

  it('a model that could not be given the page: its reading counts as before, and the receipt says so', () => {
    const settled = settle('Musterbäckerei\n14.03.2025\nNetto 3,27\nMwSt 7% 0,23\nSumme 3,50', answer({ sawPage: false, gross: 3.5 }));
    expect(settled.flags).toEqual(['page_not_read']);
    expect(settled.gross).toBe(3.5);
  });

  it('a photo of a paper receipt: arithmetic and page agree, nothing to look at', () => {
    const text = 'Musterbäckerei\nBeleg 4711\n14.03.2025 08:12\nBrötchen 3,50\nNetto 3,27\nMwSt 7% 0,23\nSumme 3,50\nBar 5,00\nRückgeld 1,50';
    const settled = settle(text, answer({ category: 'Sonstige Ausgaben', gross: 3.5, net: 3.27, date: day('2025-03-14'), currency: 'EUR' }));
    expect(settled).toMatchObject({ gross: 3.5, net: 3.27, taxRate: 7, currency: 'EUR', date: day('2025-03-14'), flags: [] });
  });

  it('a foreign-currency invoice: no German tax is assumed, the page total is the labelled one', () => {
    const text = 'Example Cloud Inc.\nInvoice\nDate of issue\nMarch 3, 2025\nPro plan\n$20.00\nTotal\n$20.00\nAmount due\n$20.00';
    const settled = settle(text, answer({ gross: 20, date: day('2025-03-03'), currency: 'USD' }));
    expect(settled).toMatchObject({ gross: 20, net: 20, taxRate: 0, currency: 'USD', date: day('2025-03-03') });
    expect(settled.flags).toEqual([]);
  });

  it('a leasing application: no total, not a guess', () => {
    const text = 'Musterleasing AG\nLeasingantrag\nAntragsdatum 02.04.2025\nLaufzeit 24 Monate\nMonatlicher Betrag 49,90 EUR';
    const settled = settle(text, answer({ category: 'Hardware & IT', gross: null, noTotal: true, date: day('2025-04-02') }));
    expect(settled.gross).toBeNull();
    expect(settled.net).toBeNull();
    // The missing amount is what the review list shows ("Betrag fehlt"); no doubt about a total that is not there.
    expect(settled.flags).toEqual([]);
  });

  it('a conflict about the date and one about the total are both recorded', () => {
    const text = 'Example Tools Ltd\nInvoice date: 5 Jan 2025\nUnit price total $12.00\n4 seats\n$48.00';
    const settled = settle(text, answer({ gross: 48, date: day('2025-01-06'), currency: 'USD' }));
    expect(settled).toMatchObject({ gross: 48, date: day('2025-01-05') });
    expect(settled.flags).toEqual(['date_conflict', 'total_conflict']);
  });

  it('a restaurant receipt the model filed elsewhere is kept as filed and put up for a look', () => {
    const text = 'Trattoria Beispiel\nTisch 4\nEs bediente Sie: Kellner 2\nPizza 12,00\nSumme 12,00\nTrinkgeld\n14.03.2025';
    expect(settle(text, answer({ category: 'Sonstige Ausgaben' })).flags).toContain('category_doubt');
  });
});

describe('a file that holds more than one document', () => {
  const INVOICE = 'Example Shop\nInvoice date: 5 Jan 2026\nTotal 10,00 €';

  it('is flagged where the model saw the pages and counts two', () => {
    expect(settle(INVOICE, answer({ documents: 2 })).flags).toContain('several_documents');
  });

  it('is not flagged for one document, for no count, or for a model that read the text alone', () => {
    expect(settle(INVOICE, answer({ documents: 1 })).flags).not.toContain('several_documents');
    expect(settle(INVOICE, answer({ documents: null })).flags).not.toContain('several_documents');
    expect(settle(INVOICE, answer({})).flags).not.toContain('several_documents');
    expect(settle(INVOICE, answer({ documents: 2, sawPage: false })).flags).not.toContain('several_documents');
  });
});
