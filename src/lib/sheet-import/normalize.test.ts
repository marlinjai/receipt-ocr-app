import { describe, it, expect } from 'vitest';
import {
  parseNumber,
  parseDate,
  mapRow,
  computeDedupKey,
  type ColumnMapping,
} from './normalize';

describe('parseNumber', () => {
  it('parses German grouping + currency', () => {
    expect(parseNumber('1.234,56 €')).toBe(1234.56);
    expect(parseNumber('€ 1.234,56')).toBe(1234.56);
    expect(parseNumber('0,99')).toBe(0.99);
  });
  it('parses English grouping', () => {
    expect(parseNumber('1,234.56')).toBe(1234.56);
    expect(parseNumber('$1,234.56')).toBe(1234.56);
  });
  it('handles plain and negative values', () => {
    expect(parseNumber('50')).toBe(50);
    expect(parseNumber(42)).toBe(42);
    expect(parseNumber('-50,00')).toBe(-50);
    expect(parseNumber('1.234,56-')).toBe(-1234.56);
  });
  it('returns null for blanks and junk', () => {
    expect(parseNumber('')).toBeNull();
    expect(parseNumber('   ')).toBeNull();
    expect(parseNumber(null)).toBeNull();
    expect(parseNumber('n/a')).toBeNull();
  });
});

describe('parseDate', () => {
  it('parses ISO and German day-first', () => {
    expect(parseDate('2026-07-20')).toBe('2026-07-20');
    expect(parseDate('20.07.2026')).toBe('2026-07-20');
    expect(parseDate('5.3.2026')).toBe('2026-03-05');
    expect(parseDate('20/07/2026')).toBe('2026-07-20');
  });
  it('expands 2-digit years', () => {
    expect(parseDate('01.02.26')).toBe('2026-02-01');
    expect(parseDate('01.02.99')).toBe('1999-02-01');
  });
  it('parses long month-name dates (the Lola sheet format)', () => {
    expect(parseDate('January 11, 2026')).toBe('2026-01-11');
    expect(parseDate('February 20, 2026')).toBe('2026-02-20');
    expect(parseDate('Jan 11 2026')).toBe('2026-01-11');
    expect(parseDate('11 January 2026')).toBe('2026-01-11');
    expect(parseDate('11 Jan 2026')).toBe('2026-01-11');
  });
  it('returns null for unparseable', () => {
    expect(parseDate('')).toBeNull();
    expect(parseDate('last tuesday')).toBeNull();
    expect(parseDate(null)).toBeNull();
  });
});

describe('mapRow', () => {
  const mapping: ColumnMapping = {
    Vendor: 'Lieferant',
    Gross: 'Betrag',
    Date: 'Rechnungsdatum',
    Currency: 'Währung',
  };
  it('maps headers to typed Receipts fields', () => {
    const row = { Lieferant: '  Anthropic ', Betrag: '1.234,56 €', Rechnungsdatum: '20.07.2026', 'Währung': 'EUR' };
    expect(mapRow(row, mapping)).toEqual({
      Vendor: 'Anthropic',
      Gross: 1234.56,
      Date: '2026-07-20',
      Currency: 'EUR',
    });
  });
  it('yields null for missing/blank source cells', () => {
    const row = { Lieferant: '', Betrag: undefined };
    const out = mapRow(row, mapping);
    expect(out.Vendor).toBeNull();
    expect(out.Gross).toBeNull();
  });
});

describe('computeDedupKey', () => {
  const fields = ['Vendor', 'Date', 'Gross'] as const;
  it('is stable across cosmetic changes (case/space) and field order', () => {
    const a = computeDedupKey({ Vendor: 'Anthropic', Date: '2026-07-20', Gross: 1234.56 }, [...fields]);
    const b = computeDedupKey({ Gross: 1234.56, Vendor: ' anthropic  ', Date: '2026-07-20' }, ['Gross', 'Vendor', 'Date']);
    expect(a).toBe(b);
  });
  it('differs when an identity field differs', () => {
    const a = computeDedupKey({ Vendor: 'Anthropic', Date: '2026-07-20', Gross: 1234.56 }, [...fields]);
    const c = computeDedupKey({ Vendor: 'Anthropic', Date: '2026-07-21', Gross: 1234.56 }, [...fields]);
    expect(a).not.toBe(c);
  });
  it('treats a missing identity field as empty, not a crash', () => {
    expect(() => computeDedupKey({ Vendor: 'X' }, [...fields])).not.toThrow();
  });
});
