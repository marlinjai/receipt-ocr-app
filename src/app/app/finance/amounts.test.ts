import { describe, expect, it } from 'vitest';
import { euro, parseEuro } from './amounts';

describe('parseEuro', () => {
  it.each([
    ['1.234,56', 123_456],
    ['1234,56', 123_456],
    ['1234.56', 123_456],
    ['5.000', 500_000],
    ['1.250.000', 125_000_000],
    ['12', 1_200],
    ['12,5', 1_250],
    ['0,05', 5],
    [' 99,90 € ', 9_990],
  ])('reads %s', (text, cents) => {
    expect(parseEuro(text)).toBe(cents);
  });

  it.each(['', '  ', 'viel', '-5', '1,234,56', '12,345', '1.2.3', '5.00.0', '1e3'])('rejects %j', (text) => {
    expect(parseEuro(text)).toBeNull();
  });

  it('round-trips with the display format', () => {
    for (const cents of [0, 5, 9_990, 123_456, 125_000_000]) {
      expect(parseEuro(euro(cents))).toBe(cents);
    }
  });
});
