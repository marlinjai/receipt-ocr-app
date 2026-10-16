import { describe, expect, it } from 'vitest';
import { amountQuery } from '../search';

describe('amountQuery', () => {
  it('reads an amount however it is written', () => {
    for (const text of ['1.234,56', '1234,56', '1234.56', '1,234.56', '1 234,56 €', '-1.234,56 EUR', '+1234,56']) expect(amountQuery(text), text).toBe(123_456);
    expect(amountQuery('45,1')).toBe(4_510);
    expect(amountQuery('45')).toBe(4_500);
  });
  it('is no amount for words, zero, or a figure with too many decimals', () => {
    for (const text of ['', '0', '0,00', 'Miete', '45,1234', '12-34', '1.2.3']) expect(amountQuery(text), text).toBeNull();
  });
});
