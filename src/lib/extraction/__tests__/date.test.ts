import { describe, expect, it } from 'vitest';
import { extractReceiptFields } from '@/lib/extract-receipt-fields';
import { readAmounts } from '../amounts';
import { readDate } from '../date';
import * as F from './invoice-fixtures';

/**
 * The invoice date on the documents of the 2025 import (roadmap, 2026-10-10):
 * 53 of 235 had none, because the reader knew neither German month names nor
 * "20-NOV-2025" nor a day with a full stop, and where it did read a date it
 * took the first one, whatever the line said about it. See invoice-fixtures.ts.
 */

const day = (text: string) => readDate(text)?.slice(0, 10) ?? null;

describe('date formats the reader did not know', () => {
  it.each([
    ['20-NOV-2025', '2025-11-20'],
    ['8. March 2025', '2025-03-08'],
    ['21st July 2025', '2025-07-21'],
    ['2nd of nothing, 3rd Feb 2025', '2025-02-03'],
    ['February 27th, 2025', '2025-02-27'],
    ['4. Januar 2025', '2025-01-04'],
    ['6. Feb. 2025', '2025-02-06'],
    ['31. März 2025', '2025-03-31'],
    ['31. Maerz 2025', '2025-03-31'],
    ['12. Mrz 2025', '2025-03-12'],
    ['23. Apr 2025', '2025-04-23'],
    ['6. Mai 2025', '2025-05-06'],
    ['6. Juni 2025', '2025-06-06'],
    ['6. Juli 2025', '2025-07-06'],
    ['6. Sept. 2025', '2025-09-06'],
    ['6. Okt. 2025', '2025-10-06'],
    ['26. Dez. 2025', '2025-12-26'],
    ['..............................31. März 2025', '2025-03-31'],
    ['0000000002 / 27.11.2025', '2025-11-27'],
  ])('%s', (text, expected) => {
    expect(day(text)).toBe(expected);
  });

  it('keeps the formats it knew', () => {
    expect(day('2024-03-15')).toBe('2024-03-15');
    expect(day('2025-02-01T05:24:31')).toBe('2025-02-01');
    expect(day('03/15/2024')).toBe('2024-03-15');
    expect(day('15/03/2024')).toBe('2024-03-15');
    expect(day('15.03.2024')).toBe('2024-03-15');
    expect(day('19.02.25, 17:04:11')).toBe('2025-02-19');
    expect(day('15 March 2024')).toBe('2024-03-15');
    expect(day('Mar 15, 2024')).toBe('2024-03-15');
  });

  it('is midnight UTC of the printed day', () => {
    expect(readDate('Rechnungsdatum 9. Mai 2025')).toBe('2025-05-09T00:00:00.000Z');
  });

  it('reads no date out of what is none', () => {
    expect(day('31.02.2025')).toBeNull();
    expect(day('13/13/2025')).toBeNull();
    expect(day('Gebühren für März 2025      4,06')).toBeNull();
    expect(day('St.-Nr. 31/314/02212')).toBeNull();
    expect(day('Tel: 030 28 03 55 08')).toBeNull();
    expect(day('Marketing 12, 2025')).toBeNull();
    expect(day('8 May 12:30')).toBeNull();
    expect(day('Version 10.0.0.1')).toBeNull();
    expect(day('')).toBeNull();
  });
});

describe('which of several dates is the invoice date', () => {
  it('Adobe: the date in the column, not the end of the service term', () => {
    expect(day(F.ADOBE_DATE_IN_A_COLUMN)).toBe('2025-11-20');
  });

  it('Apple: the date under the heading, not the renewal', () => {
    expect(day(F.APPLE_DATE_UNDER_THE_HEADING)).toBe('2025-03-08');
  });

  it('Google: "Rechnungsdatum" on the line of the date', () => {
    expect(day(F.GOOGLE_LABEL_AND_DATE_ON_ONE_LINE)).toBe('2025-09-06');
  });

  it('Google: "Rechnungsdatum" alone above the date, and not the first day of the billed month', () => {
    expect(day(F.GOOGLE_LABEL_ABOVE_THE_DATE)).toBe('2025-03-31');
  });

  it('the day of issue, although the due date stands in front of it on the same line', () => {
    expect(day(F.HOSTING_DUE_AND_ISSUED_ON_ONE_LINE)).toBe('2025-04-29');
  });

  it('Cursor: "Date of issue", never "Date due"', () => {
    expect(day(F.CURSOR_PAID_FROM_BALANCE)).toBe('2025-02-02');
    expect(day(F.CURSOR_DUE_LATER)).toBe('2025-02-13');
  });

  it('"Ausstellungsdatum", not "Fällig am"', () => {
    expect(day(F.GERMAN_ISSUED_AND_DUE)).toBe('2025-01-04');
  });

  it('an ordinal day with no label', () => {
    expect(day(F.PADDLE_ORDINAL_DAY)).toBe('2025-07-21');
  });

  it('the invoice date among reference, delivery note and order date', () => {
    expect(day(F.HARDWARE_NUMBER_AND_DATE_PAIRS)).toBe('2025-11-27');
  });

  it('an order date where the page prints no invoice date', () => {
    expect(day(F.ORDER_PAGE_ORDERED_AND_PAID)).toBe('2025-04-23');
  });

  it('the day of the letter, not the day of the debit, the handover or the start of the contract', () => {
    expect(day(F.LEASING_CONTRACT_FIRST_DEBIT)).toBe('2025-05-05');
  });

  it('the nearest label names a date: a due note in the column to the left changes nothing', () => {
    expect(day('Due: on receipt          Invoice date: 5 Jan 2025')).toBe('2025-01-05');
    expect(day('Invoice date: 5 Jan 2025          Due date: 19 Jan 2025')).toBe('2025-01-05');
    expect(day('Due date: 19 Jan 2025          Invoice date: 5 Jan 2025')).toBe('2025-01-05');
  });

  it('ranks the kinds whatever the order of the lines', () => {
    const lines = ['Leistungsdatum: 01.03.2025', '02.03.2025', 'Bestellt am 03.03.2025', 'Datum: 04.03.2025', 'Rechnungsdatum: 05.03.2025'];
    expect(day(lines.join('\n'))).toBe('2025-03-05');
    expect(day(lines.slice(0, 4).join('\n'))).toBe('2025-03-04');
    expect(day(lines.slice(0, 3).join('\n'))).toBe('2025-03-03');
    expect(day(lines.slice(0, 2).join('\n'))).toBe('2025-03-02');
    expect(day(lines.slice(0, 1).join('\n'))).toBe('2025-03-01');
  });

  it('both ends of a period are a service date, also with a label in front', () => {
    expect(day('Rechnungsdatum 01.03.2025 - 31.03.2025\n02.04.2025')).toBe('2025-04-02');
    expect(day('Abrechnung 01.03.2025 bis 31.03.2025\nBelegdatum 02.04.2025')).toBe('2025-04-02');
    expect(day('Service Term: 20-NOV-2025 to 19-DEC-2025')).toBe('2025-11-20');
  });

  it('a document that prints only a due date, a renewal or an expiry has no date', () => {
    expect(day('Fällig am 18. Januar 2025')).toBeNull();
    expect(day('Zahlbar bis 18.01.2025')).toBeNull();
    expect(day('Den Betrag buchen wir am 31.01.2025 ab.')).toBeNull();
    expect(day('Renews 8. April 2025')).toBeNull();
    expect(day('Next billing date: May 8, 2025')).toBeNull();
    expect(day('Card valid thru 12/12/2027')).toBeNull();
  });
});

describe('a label that stands alone above its date', () => {
  it('names the first date of the next line, across a dotted rule', () => {
    expect(day('Fällig am\n18.01.2025\nRechnungsdatum\n..........\n04.01.2025   Gesamt 10,00')).toBe('2025-01-04');
  });

  it('a block of labels names a block of dates in order', () => {
    expect(day('Date due\nDate of issue\nFebruary 27, 2025\nFebruary 13, 2025')).toBe('2025-02-13');
    expect(day('Date of issue\nDate due\nFebruary 13, 2025\nFebruary 27, 2025')).toBe('2025-02-13');
  });

  it('a block that does not match its dates one to one names none of them', () => {
    // Three labels, two dates: which label has no date cannot be told, so the first date stands.
    expect(day('Date due\nDate paid\nDate of issue\nFebruary 27, 2025\nFebruary 13, 2025\nUS$20.00')).toBe('2025-02-27');
  });

  it('a line about something else is no label', () => {
    // "Gebuchtes Produkt" is not "gebucht am": the date below it is the start of a contract.
    expect(day('22.01.2025\nGebuchtes Produkt: Tarif L\nVertragsbeginn: 13.11.20 - Ende der Mindestlaufzeit: keine')).toBe('2025-01-22');
    expect(day('We thank you for the payment you made and hope to see you again\n13.11.2020\nDatum: 22.01.2025')).toBe('2025-01-22');
  });
});

describe('the totals of the same documents', () => {
  const read = (text: string) => extractReceiptFields({ fullText: text, blocks: [], confidence: 0.95 });

  it('reads total, net and rate where the invoice prints them', () => {
    expect(read(F.ADOBE_DATE_IN_A_COLUMN)).toMatchObject({ gross: 34.99, net: 29.4, taxRate: 19, amountChecks: [] });
    expect(read(F.APPLE_DATE_UNDER_THE_HEADING)).toMatchObject({ gross: 9.99, net: 8.4, taxRate: 19, amountChecks: [] });
    expect(read(F.GOOGLE_LABEL_AND_DATE_ON_ONE_LINE)).toMatchObject({ gross: 7.49, net: 6.29, taxRate: 19, amountChecks: [] });
    expect(read(F.GOOGLE_LABEL_ABOVE_THE_DATE)).toMatchObject({ gross: 4.83, net: 4.06, taxRate: 19, amountChecks: [] });
    expect(read(F.HARDWARE_NUMBER_AND_DATE_PAIRS)).toMatchObject({ gross: 2849, net: 2394.12, taxRate: 19, amountChecks: [] });
  });

  it('Cursor, paid from a credit balance: the total is the invoice total, not the zero left to pay', () => {
    const r = read(F.CURSOR_PAID_FROM_BALANCE);
    expect(r).toMatchObject({ gross: 0.4, net: 0.4, taxRate: 0, currency: 'USD' });
    expect(r.amountChecks).toEqual(['total_unconfirmed']);
  });

  it('Cursor with the columns torn apart: without a labelled total the second reading decides, and none is invented', () => {
    const torn = 'Cursor\nUS$0.00 due 2 February 2025\n1 o1 request\n1\nUS$0.40\nUS$0.40\nUS$0.40\nUS$0.40\n-US$0.40\nUS$0.00\nSubtotal\nTotal\nApplied balance\nAmount due\nAnysphere, Inc.';
    expect(readAmounts(torn, { currency: 'USD', modelGross: 0.4 })).toMatchObject({ gross: 0.4, checks: ['total_unconfirmed'] });
    // A second reading that gives the zero amount due is no total: the row asks for its amount.
    expect(readAmounts(torn, { currency: 'USD', modelGross: null })).toMatchObject({ gross: null, checks: ['total_missing'] });
  });

  it('the leasing application states a monthly rate and a fee, no total: none is read', () => {
    const r = read(F.LEASING_APPLICATION);
    expect(r.gross).toBeNull();
    expect(r.net).toBeNull();
    expect(r.amountChecks).toEqual(['total_missing']);
    expect(r.date?.slice(0, 10)).toBe('2025-04-15');
    // A second reading that takes the monthly rate for the total is kept only as unconfirmed, for a person to look at.
    expect(readAmounts(F.LEASING_APPLICATION, { date: '2025-04-15', modelGross: 54.79 })).toMatchObject({ gross: 54.79, checks: ['total_unconfirmed', 'tax_estimated'] });
  });

  it('the leasing contract bills the first debit: that is its total, not the amount of the later months', () => {
    const r = read(F.LEASING_CONTRACT_FIRST_DEBIT);
    expect(r).toMatchObject({ gross: 185.56, net: 155.93, taxRate: 19, amountChecks: [] });
  });
});
