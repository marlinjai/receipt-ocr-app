import { describe, expect, it } from 'vitest';
import { REASON_TEXT, derivedReasons, lookAlikes, reviewReasons, type ReviewSnapshot } from '../reasons';

const receipt = (overrides: Partial<ReviewSnapshot> = {}): ReviewSnapshot => ({
  rowId: 'r1',
  name: 'Abendessen',
  vendor: 'Lokal Beispiel',
  date: '2025-03-14',
  gross: 119,
  net: 100,
  taxRate: 19,
  currency: 'EUR',
  hasText: true,
  hasFile: true,
  fileHashes: [],
  ...overrides,
});

describe('derivedReasons', () => {
  it('a complete receipt needs no look', () => {
    expect(derivedReasons(receipt())).toEqual([]);
  });

  it('a file with no text and no fields is "could not be read", and nothing else', () => {
    expect(derivedReasons(receipt({ hasText: false, gross: null, date: null, vendor: '', net: null, taxRate: null }))).toEqual(['read_failed']);
  });

  it('a row typed in by hand without a file is judged by its fields, not as a failed reading', () => {
    expect(derivedReasons(receipt({ hasFile: false, hasText: false, gross: null }))).toEqual(['amount_missing']);
  });

  it('names what is missing', () => {
    expect(derivedReasons(receipt({ gross: 0, date: null, vendor: '  ' }))).toEqual(['amount_missing', 'date_missing', 'vendor_missing']);
  });

  it('finds the tax figures of the first live upload: 526 percent, and a net above the total', () => {
    expect(derivedReasons(receipt({ gross: 34.2, net: 5.46, taxRate: 526.37 }))).toEqual(['tax_implausible']);
    expect(derivedReasons(receipt({ gross: 61.4, net: 916694.18, taxRate: 0.01 }))).toEqual(['tax_implausible']);
    expect(derivedReasons(receipt({ taxRate: -1 }))).toEqual(['tax_implausible']);
  });

  it('accepts every rate a real receipt carries, including zero and a foreign 27 percent', () => {
    for (const taxRate of [0, 5, 7, 16, 19, 20, 25, 27, null]) expect(derivedReasons(receipt({ taxRate, net: null }))).toEqual([]);
  });
});

describe('reviewReasons', () => {
  it('adds the recorded doubts, in a fixed order, until the receipt is confirmed', () => {
    const stored = { flags: ['total_unconfirmed', 'not_classified'], checkedAt: null };
    expect(reviewReasons(receipt(), stored, [])).toEqual(['not_classified', 'total_unconfirmed']);
    expect(reviewReasons(receipt(), { ...stored, checkedAt: new Date() }, [])).toEqual([]);
  });

  it('a doubt about the total is dropped once there is no total at all', () => {
    expect(reviewReasons(receipt({ gross: null, net: null }), { flags: ['total_conflict', 'not_classified'], checkedAt: null }, [])).toEqual(['amount_missing', 'not_classified']);
  });

  it('ignores a stored value that is not a known flag', () => {
    expect(reviewReasons(receipt(), { flags: ['made_up'], checkedAt: null }, [])).toEqual([]);
  });

  it('a look-alike is a reason even on a confirmed receipt: that is a different question', () => {
    expect(reviewReasons(receipt(), { flags: [], checkedAt: new Date() }, ['r2'])).toEqual(['possible_duplicate']);
  });

  it('every reason has wording for the person who has to act on it', () => {
    for (const text of Object.values(REASON_TEXT)) expect(text.length).toBeGreaterThan(10);
  });
});

describe('lookAlikes', () => {
  const none = new Map<string, Set<string>>();

  it('pairs receipts of the same day and total whose vendors can be the same', () => {
    const a = receipt({ rowId: 'a', vendor: 'Grillhaus Beispiel - Ocakbasi' });
    const b = receipt({ rowId: 'b', vendor: 'GRILLHAUS BEISPIEL' });
    const c = receipt({ rowId: 'c', vendor: 'Buchhandlung Muster' });
    const found = lookAlikes([a, b, c], none);
    expect(found.get('a')).toEqual(['b']);
    expect(found.get('b')).toEqual(['a']);
    expect(found.has('c')).toBe(false);
  });

  it('does not pair across days, totals or currencies', () => {
    const a = receipt({ rowId: 'a' });
    expect(lookAlikes([a, receipt({ rowId: 'b', date: '2025-03-15' })], none).size).toBe(0);
    expect(lookAlikes([a, receipt({ rowId: 'b', gross: 119.01 })], none).size).toBe(0);
    expect(lookAlikes([a, receipt({ rowId: 'b', currency: 'USD' })], none).size).toBe(0);
  });

  it('receipts without a total or a date are never paired by their fields', () => {
    const a = receipt({ rowId: 'a', gross: null });
    const b = receipt({ rowId: 'b', gross: null });
    expect(lookAlikes([a, b], none).size).toBe(0);
  });

  it('the same file is a duplicate whatever the fields say', () => {
    const a = receipt({ rowId: 'a', fileHashes: ['h1'], date: '2025-01-01', gross: 1 });
    const b = receipt({ rowId: 'b', fileHashes: ['h1'], date: '2025-02-02', gross: 2 });
    expect(lookAlikes([a, b], none).get('a')).toEqual(['b']);
  });

  it('a pair a person settled stays settled, from either side', () => {
    const a = receipt({ rowId: 'a' });
    const b = receipt({ rowId: 'b' });
    expect(lookAlikes([a, b], new Map([['a', new Set(['b'])]])).size).toBe(0);
    expect(lookAlikes([a, b], new Map([['b', new Set(['a'])]])).size).toBe(0);
  });
});
