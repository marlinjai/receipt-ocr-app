import { describe, expect, it } from 'vitest';
import { formatDay, formatTotal, receiptName } from '../receipt-name';

describe('the name of a receipt', () => {
  it('is the vendor, the total and the date', () => {
    expect(receiptName({ vendor: 'Musterwerk', gross: 119, currency: 'EUR', date: '2025-03-14T00:00:00.000Z' })).toBe('Musterwerk, 119,00 €, 14.03.2025');
    expect(receiptName({ vendor: 'Example Courses', gross: 1234.5, currency: 'USD', date: '2025-12-31' })).toBe('Example Courses, 1.234,50 $, 31.12.2025');
  });

  it('leaves out what is not known, and is empty when nothing is', () => {
    expect(receiptName({ vendor: 'Musterwerk', gross: null, date: null })).toBe('Musterwerk');
    expect(receiptName({ vendor: null, gross: 12, date: '2025-01-02' })).toBe('12,00 €, 02.01.2025');
    expect(receiptName({ vendor: '  ', gross: null, date: 'no date' })).toBe('');
  });

  it('counts a total of nothing as a total, and euros where no currency is given', () => {
    expect(receiptName({ vendor: 'Musterwerk', gross: 0, date: null })).toBe('Musterwerk, 0,00 €');
  });

  it('takes the day as written, whatever the time zone of the machine', () => {
    expect(formatDay('2025-01-01T00:00:00.000Z')).toBe('01.01.2025');
    expect(formatDay('2025-12-31T23:30:00.000Z')).toBe('31.12.2025');
    expect(formatDay('garbage')).toBeNull();
  });

  it('writes a currency it has no sign for behind the number', () => {
    expect(formatTotal(10, 'XXQ')).toMatch(/^10,00/);
    expect(formatTotal(10, 'gbp')).toBe('10,00 £');
  });
});
