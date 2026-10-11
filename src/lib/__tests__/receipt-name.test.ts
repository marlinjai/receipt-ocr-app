import { describe, expect, it } from 'vitest';
import { cleanItem, formatDay, formatTotal, nameIsBuilt, receiptName } from '../receipt-name';

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

  it('says what was bought between the vendor and the total', () => {
    expect(receiptName({ vendor: 'Amazon', item: 'SSD-Gehäuse', gross: 106.24, currency: 'EUR', date: '2024-07-18' })).toBe('Amazon, SSD-Gehäuse, 106,24 €, 18.07.2024');
    expect(receiptName({ vendor: null, item: 'ChatGPT Plus', gross: 23.8, currency: 'USD', date: '2024-02-01' })).toBe('ChatGPT Plus, 23,80 $, 01.02.2024');
  });

  it('does not repeat a vendor that is its own product, and ignores an empty item', () => {
    expect(receiptName({ vendor: 'Notion', item: 'notion', gross: 10, date: '2024-01-12' })).toBe('Notion, 10,00 €, 12.01.2024');
    expect(receiptName({ vendor: 'Notion', item: '  ', gross: 10, date: '2024-01-12' })).toBe('Notion, 10,00 €, 12.01.2024');
  });

  it('keeps the item to one short part of the name', () => {
    expect(cleanItem(' USB-Stick,  Kabel. ')).toBe('USB-Stick Kabel');
    expect(cleanItem('x')).toBeNull();
    expect(cleanItem(42)).toBeNull();
    const long = cleanItem('Ein sehr langer Artikeltext der niemals in einen Namen gehört und abgeschnitten wird');
    expect(long!.length).toBeLessThanOrEqual(48);
    expect(long!.endsWith(' ')).toBe(false);
    expect(cleanItem('Domainverlängerung + 2')).toBe('Domainverlängerung + 2');
  });

  it('tells a name built from the cells from one a person typed', () => {
    expect(nameIsBuilt('Musterwerk, 119,00 €, 14.03.2025')).toBe(true);
    expect(nameIsBuilt('Example Courses, 1.234,50 $')).toBe(true);
    expect(nameIsBuilt('Musterwerk, 14.03.2025')).toBe(true);
    expect(nameIsBuilt('Nicht lesbar: scan.pdf')).toBe(true);
    expect(nameIsBuilt('')).toBe(true);
    expect(nameIsBuilt(null)).toBe(true);
    expect(nameIsBuilt('Laptop für das Büro')).toBe(false);
    expect(nameIsBuilt('Musterwerk')).toBe(false);
  });
});
