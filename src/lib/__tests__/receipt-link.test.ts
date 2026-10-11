import { describe, expect, it } from 'vitest';
import { RECEIPT_PARAM, receiptHref } from '../receipt-link';

describe('the address of one receipt in the table', () => {
  it('names the receipt in the dashboard address, escaped', () => {
    expect(receiptHref('0c7d184f-1111')).toBe('/app/dashboard?beleg=0c7d184f-1111');
    expect(receiptHref('a b&c')).toBe('/app/dashboard?beleg=a%20b%26c');
    expect(new URL(receiptHref('x/y?z'), 'https://example.test').searchParams.get(RECEIPT_PARAM)).toBe('x/y?z');
  });
});
