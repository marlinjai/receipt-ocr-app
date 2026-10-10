import { describe, expect, it } from 'vitest';
import { formatTaxRates, withTaxRates } from '../tax-rates';

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
    // New lines, the rate comes from the row.
    expect(withTaxRates(COLUMNS, { 'c-lines': '' }, { 'c-rate': 19 })['c-rates']).toBe('19 %');
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

  it('reads a rate stored as text and ignores lines that are not lines', () => {
    expect(withTaxRates(COLUMNS, { 'c-rate': '7' })['c-rates']).toBe('7 %');
    expect(withTaxRates(COLUMNS, { 'c-rate': 19, 'c-lines': 'not json' })['c-rates']).toBe('19 %');
  });
});
