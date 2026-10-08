import { describe, expect, it } from 'vitest';
import { parsePlaceFromReceiptText, placeFromReceiptText } from '../place';

/** Fictional receipts only. */
const TILL = `Testlokal Beispiel
Musterstraße 69
12345 Musterstadt
Rechnung Nr.9-44481 22:15:52 13.03.2025
1x Tagesgericht 11,00 €
Total 63,80 €
USt. 19% 10,19 €`;

describe('placeFromReceiptText', () => {
  it('reads name, street and postal code with town from a till receipt header', () => {
    expect(parsePlaceFromReceiptText(TILL, 'Testlokal Beispiel')).toEqual({
      name: 'Testlokal Beispiel',
      street: 'Musterstraße 69',
      postalCode: '12345',
      town: 'Musterstadt',
    });
    expect(placeFromReceiptText(TILL, 'Testlokal Beispiel')).toBe('Testlokal Beispiel, Musterstraße 69, 12345 Musterstadt');
  });

  it('the given vendor wins as the name; without one the line above the street is taken', () => {
    expect(placeFromReceiptText(TILL, 'Anderer Name')).toBe('Anderer Name, Musterstraße 69, 12345 Musterstadt');
    expect(placeFromReceiptText(TILL, null)).toBe('Testlokal Beispiel, Musterstraße 69, 12345 Musterstadt');
  });

  it('street and town on one line, with an abbreviation and a house number suffix', () => {
    expect(placeFromReceiptText('Café Muster\nBeispielstr. 12a, 54321 Beispiel am Main\nTel 000', 'Café Muster')).toBe(
      'Café Muster, Beispielstr. 12a, 54321 Beispiel am Main',
    );
  });

  it('a street introduced by a preposition, and a country prefix on the postal code', () => {
    expect(placeFromReceiptText('Gasthaus Test\nAm Musterufer 3\nD-10999 Teststadt', 'Gasthaus Test')).toBe(
      'Gasthaus Test, Am Musterufer 3, 10999 Teststadt',
    );
  });

  it('receipt numbers, times, dates and amounts are not taken for a postal code', () => {
    const text = 'Lokal\nRechnung 44481 Tisch 12\n22:15:52 13.03.2025\nTotal 63,80\n12345 67890';
    expect(placeFromReceiptText(text, 'Lokal')).toBeNull();
  });

  it('half an address is no address: a town without a street, or a street without a town, gives nothing', () => {
    expect(placeFromReceiptText('Lokal Muster\n12345 Musterstadt\nTotal 10,00', 'Lokal Muster')).toBeNull();
    expect(placeFromReceiptText('Lokal Muster\nMusterstraße 5\nTotal 10,00', 'Lokal Muster')).toBeNull();
  });

  it('an address far down the receipt (a footer of another company) is ignored', () => {
    const filler = Array.from({ length: 40 }, (_, i) => `1x Artikel ${i} 1,00`).join('\n');
    expect(placeFromReceiptText(`Lokal\n${filler}\nKassenstraße 1\n11111 Kassenstadt`, 'Lokal')).toBeNull();
  });

  it('no text, no place', () => {
    expect(placeFromReceiptText('', 'Lokal')).toBeNull();
    expect(placeFromReceiptText(null, 'Lokal')).toBeNull();
    expect(placeFromReceiptText('   \n ', null)).toBeNull();
  });

  it('an amount line right above the postal line is not a street', () => {
    expect(placeFromReceiptText('Lokal\nSumme 12,50\n12345 Musterstadt', 'Lokal')).toBeNull();
  });
});
