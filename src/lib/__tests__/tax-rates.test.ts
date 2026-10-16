import { describe, expect, it } from 'vitest';
import { formatTaxRates, orderedRates, touchesTaxRates, withTaxRates } from '../tax-rates';

const COLUMNS = [
  { id: 'c-rate', name: 'Tax Rate' },
  { id: 'c-rates', name: 'Tax Rates' },
  { id: 'c-lines', name: 'Tax Lines' },
  { id: 'c-name', name: 'Name' },
];
const lines = (...l: Array<[number, number]>) => JSON.stringify(l.map(([rate, net]) => ({ rate, net, tax: Math.round(net * rate) / 100 })));

describe('formatTaxRates', () => {
  it('names every rate once, the one that carries most of the bill first', () => {
    expect(formatTaxRates([{ rate: 19, net: 12 }, { rate: 7, net: 30 }], 19)).toBe('7 % + 19 %');
    expect(formatTaxRates([{ rate: 19, net: 20 }, { rate: 7, net: 5 }, { rate: 19, net: 20 }], null)).toBe('19 % + 7 %');
  });

  it('one printed rate, or none printed and a single rate known, is that rate', () => {
    expect(formatTaxRates([{ rate: 19, net: 40.76 }], 7)).toBe('19 %');
    expect(formatTaxRates(null, 19)).toBe('19 %');
    expect(formatTaxRates([], 0)).toBe('0 %');
    expect(formatTaxRates(undefined, 5.5)).toBe('5,5 %');
  });

  it('says nothing when nothing is known', () => {
    expect(formatTaxRates(null, null)).toBe('');
    expect(formatTaxRates([], undefined)).toBe('');
    expect(formatTaxRates(null, Number.NaN)).toBe('');
  });
});

describe('withTaxRates: the text follows every write of the rate or the tax lines', () => {
  it('a new row with a rate gets its text', () => {
    expect(withTaxRates(COLUMNS, { 'c-rate': 19, 'c-name': 'Beleg' })).toEqual({ 'c-rate': 19, 'c-name': 'Beleg', 'c-rates': '19 %' });
  });

  it('tax lines win over the single rate, written or stored', () => {
    expect(withTaxRates(COLUMNS, { 'c-rate': 7, 'c-lines': lines([7, 30], [19, 12]) })['c-rates']).toBe('7 % + 19 %');
    // A rate typed into the grid on a receipt with two printed rates does not make it a one-rate receipt.
    expect(withTaxRates(COLUMNS, { 'c-rate': 19 }, { 'c-lines': lines([7, 30], [19, 12]), 'c-rate': 7 })['c-rates']).toBe('7 % + 19 %');
    // The lines are cleared: the rate comes from the row.
    expect(withTaxRates(COLUMNS, { 'c-lines': '' }, { 'c-rate': 19, 'c-lines': lines([7, 30], [19, 12]) })['c-rates']).toBe('19 %');
  });

  it('clearing the rate clears the text', () => {
    expect(withTaxRates(COLUMNS, { 'c-rate': null }, { 'c-rate': 19 })['c-rates']).toBe('');
  });

  it('leaves a write alone that touches neither, sets the text itself, or meets a table without the column', () => {
    const other = { 'c-name': 'Beleg' };
    expect(withTaxRates(COLUMNS, other, { 'c-rate': 19 })).toBe(other);
    const typed = { 'c-rate': 19, 'c-rates': 'gemischt' };
    expect(withTaxRates(COLUMNS, typed)).toBe(typed);
    const old = { 'c-rate': 19 };
    expect(withTaxRates(COLUMNS.filter((c) => c.id !== 'c-rates'), old)).toBe(old);
  });

  it('a write that repeats what the row holds leaves the text alone, also one a person typed', () => {
    const typed = { 'c-rate': 19, 'c-rates': 'von Hand', 'c-lines': '' };
    const again = { 'c-rate': 19, 'c-lines': '' };
    expect(withTaxRates(COLUMNS, again, typed)).toBe(again);
    // The same rate as text (an import) is the same rate.
    const asText = { 'c-rate': '19' };
    expect(withTaxRates(COLUMNS, asText, typed)).toBe(asText);
    // A different rate is a change, and the text follows.
    expect(withTaxRates(COLUMNS, { 'c-rate': 7 }, typed)['c-rates']).toBe('7 %');
  });

  it('knows which writes need the stored row', () => {
    expect(touchesTaxRates(COLUMNS, { 'c-name': 'Beleg' })).toBe(false);
    expect(touchesTaxRates(COLUMNS, { 'c-rate': 19 })).toBe(true);
    expect(touchesTaxRates(COLUMNS, { 'c-lines': '' })).toBe(true);
    expect(touchesTaxRates(COLUMNS, { 'c-rate': 19, 'c-rates': 'x' })).toBe(false);
    expect(touchesTaxRates(COLUMNS.filter((c) => c.id !== 'c-rates'), { 'c-rate': 19 })).toBe(false);
  });

  it('reads a rate stored as text and ignores lines that are not lines', () => {
    expect(withTaxRates(COLUMNS, { 'c-rate': '7' })['c-rates']).toBe('7 %');
    expect(withTaxRates(COLUMNS, { 'c-rate': 19, 'c-lines': 'not json' })['c-rates']).toBe('19 %');
  });
});

describe('orderedRates: one order for both rate columns', () => {
  it('orders by the part of the bill a rate carries, net plus tax, not by net alone', () => {
    // 7 percent on 100.00 is 107.00 of the bill, 19 percent on 99.00 is 117.81: the 19 percent line carries more.
    const lines = [
      { rate: 7, net: 100, tax: 7 },
      { rate: 19, net: 99, tax: 18.81 },
    ];
    expect(orderedRates(lines)).toEqual([19, 7]);
    expect(formatTaxRates(lines, 7)).toBe('19 % + 7 %');
  });

  it('works the tax out from the rate where a line gives none, and a tie goes to the higher rate', () => {
    expect(orderedRates([{ rate: 7, net: 100 }, { rate: 19, net: 99 }])).toEqual([19, 7]);
    expect(orderedRates([{ rate: 7, net: 107, tax: 0 }, { rate: 19, net: 107, tax: 0 }])).toEqual([19, 7]);
  });

  it('adds the lines of one rate together and skips a line without a usable rate', () => {
    expect(orderedRates([{ rate: 19, net: 20, tax: 3.8 }, { rate: 7, net: 30, tax: 2.1 }, { rate: 19, net: 20, tax: 3.8 }, { rate: Number.NaN, net: 500 }])).toEqual([19, 7]);
    expect(orderedRates(null)).toEqual([]);
  });
});

describe('orderedRates: shares in cents, nothing negative', () => {
  it('a tie in cents is a tie, whatever the floating point sum makes of it', () => {
    expect(orderedRates([{ rate: 7, net: 0.1, tax: 0.2 }, { rate: 19, net: 0.3, tax: 0 }])).toEqual([19, 7]);
  });

  it('a line that carries nothing or less does not take part', () => {
    expect(orderedRates([{ rate: 19, net: 10, tax: 1.9 }, { rate: 7, net: -50, tax: -3.5 }, { rate: 0, net: 0, tax: 0 }])).toEqual([19]);
  });
});
