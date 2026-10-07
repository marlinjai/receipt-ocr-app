import { describe, expect, it } from 'vitest';
import { eurosToCents, formatCents, percentToBp, shareOf } from '../money';

describe('shareOf', () => {
  it('rounds half up to the cent with integer arithmetic', () => {
    // 123.45 at 50 percent is 61.725: a floating point product can give 61.72.
    expect(shareOf(12345, 5000)).toBe(6173);
    // 123.45 at 30 percent is 37.035.
    expect(shareOf(12345, 3000)).toBe(3704);
    expect(shareOf(41990, 5000)).toBe(20995);
  });

  it('returns the whole and nothing at the ends', () => {
    expect(shareOf(12345, 10000)).toBe(12345);
    expect(shareOf(12345, 0)).toBe(0);
    expect(Object.is(shareOf(0, 5000), 0)).toBe(true);
  });

  it('is symmetric for refunds (negative amounts)', () => {
    expect(shareOf(-12345, 5000)).toBe(-6173);
  });

  it('rejects a share outside the whole and a fractional cent', () => {
    expect(() => shareOf(100, 10001)).toThrow(RangeError);
    expect(() => shareOf(100, -1)).toThrow(RangeError);
    expect(() => shareOf(100.5, 5000)).toThrow(RangeError);
  });

  it('never deducts more than the amount when shares add up to the whole', () => {
    for (const cents of [1, 3, 99, 12345, 239900]) {
      for (const first of [1, 3333, 5000, 6667, 9999]) {
        const total = shareOf(cents, first) + shareOf(cents, 10000 - first);
        // Two half-up roundings can exceed the amount by at most one cent.
        expect(Math.abs(total - cents)).toBeLessThanOrEqual(1);
      }
    }
  });
});

describe('conversions', () => {
  it('converts table euros to cents without floating point drift', () => {
    expect(eurosToCents(123.45)).toBe(12345);
    expect(eurosToCents(0.1 + 0.2)).toBe(30);
    expect(eurosToCents(-12.345)).toBe(-1235);
  });

  it('turns a typed percentage into basis points', () => {
    expect(percentToBp(50)).toBe(5000);
    expect(percentToBp(33.33)).toBe(3333);
  });

  it('formats cents the German way', () => {
    expect(formatCents(123456)).toBe('1.234,56');
    expect(formatCents(-905)).toBe('-9,05');
    expect(formatCents(0)).toBe('0,00');
  });
});
