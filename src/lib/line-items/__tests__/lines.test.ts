import { describe, expect, it } from 'vitest';
import { SPENDING_CATEGORIES } from '@/lib/spending/categories';
import { KIND_CATEGORY, PURCHASE_KINDS, PURCHASE_KIND_HINTS, PURCHASE_KIND_LABELS, isPurchaseKind } from '../kinds';
import { ADD_UP_TOLERANCE_CENTS, MAX_LINES, checkLines, parseModelLines, sumGrossCents, textKey, vendorKey } from '../lines';

describe('kinds of purchase', () => {
  it('have a German label, a hint for the model and a spending category (or follow the receipt)', () => {
    for (const kind of PURCHASE_KINDS) {
      expect(PURCHASE_KIND_LABELS[kind]).toBeTruthy();
      expect(PURCHASE_KIND_HINTS[kind]).toBeTruthy();
      const category = KIND_CATEGORY[kind];
      if (category !== null) expect(SPENDING_CATEGORIES).toContain(category);
    }
    expect(KIND_CATEGORY.deposit_discount).toBeNull();
    expect(KIND_CATEGORY.coffee_tea).toBe('groceries_drugstore');
    expect(KIND_CATEGORY.drink_out).toBe('eating_out_coffee');
    expect(isPurchaseKind('groceries')).toBe(true);
    expect(isPurchaseKind('Lebensmittel')).toBe(false);
  });
});

// A supermarket receipt: two items, a deposit, a returned deposit and a discount.
const supermarket = [
  { text: 'Hafermilch Barista', quantity: 2, unitPrice: 1.79, gross: 3.58, taxRate: 7, kind: 'groceries' },
  { text: 'Mineralwasser 6x1,5l', quantity: 1, unitPrice: 3.49, gross: 3.49, taxRate: 19, kind: 'soft_drinks' },
  { text: 'Pfand', quantity: 6, unitPrice: 0.25, gross: 1.5, taxRate: 19, kind: 'deposit_discount' },
  { text: 'Leergut', quantity: null, unitPrice: null, gross: -2.0, taxRate: null, kind: 'deposit_discount' },
  { text: 'Rabatt 10 %', gross: -0.36, kind: 'deposit_discount' },
];

describe('parseModelLines', () => {
  it('reads a supermarket receipt with a deposit, a returned deposit and a discount as their own lines (forward)', () => {
    const lines = parseModelLines(supermarket);
    expect(lines).not.toBeNull();
    expect(lines!.map((l) => l.grossCents)).toEqual([358, 349, 150, -200, -36]);
    expect(lines![0]).toEqual({ text: 'Hafermilch Barista', quantity: 2, unitPriceCents: 179, grossCents: 358, netCents: null, taxRate: 7, kind: 'groceries' });
    expect(lines![4]).toMatchObject({ quantity: null, unitPriceCents: null, taxRate: null });
    expect(sumGrossCents(lines!)).toBe(621);
  });

  it('reads a café bill as drinks and a meal', () => {
    const lines = parseModelLines([
      { text: 'Cappuccino', quantity: 2, unitPrice: 3.9, gross: 7.8, taxRate: 19, kind: 'drink_out' },
      { text: 'Croque Madame', quantity: 1, unitPrice: 9.5, gross: 9.5, taxRate: 7, kind: 'meal_out' },
      { text: 'Aperol Spritz', quantity: 1, unitPrice: 7.5, gross: 7.5, taxRate: 19, kind: 'alcohol_out' },
    ]);
    expect(lines!.map((l) => l.kind)).toEqual(['drink_out', 'meal_out', 'alcohol_out']);
  });

  it('takes an empty list as "the document shows no lines", and a missing one as not read', () => {
    expect(parseModelLines([])).toEqual([]);
    expect(parseModelLines(undefined)).toBeNull();
    expect(parseModelLines(null)).toBeNull();
    expect(parseModelLines({ text: 'x' })).toBeNull();
  });

  it('voids the whole list for one malformed entry, never keeping half the lines', () => {
    const broken = (entry: Record<string, unknown>) => parseModelLines([supermarket[0], entry]);
    expect(broken({ text: '', gross: 1, kind: 'groceries' })).toBeNull();
    expect(broken({ text: 'x'.repeat(201), gross: 1, kind: 'groceries' })).toBeNull();
    expect(broken({ text: 'Brot', gross: '2,49', kind: 'groceries' })).toBeNull();
    expect(broken({ text: 'Brot', gross: Number.NaN, kind: 'groceries' })).toBeNull();
    expect(broken({ text: 'Brot', gross: 2_000_000, kind: 'groceries' })).toBeNull();
    expect(broken({ text: 'Brot', gross: 2.49, kind: 'bread' })).toBeNull();
    expect(broken({ text: 'Brot', gross: 2.49, kind: null })).toBeNull();
    expect(broken({ text: 'Brot', gross: 2.49, quantity: 0, kind: 'groceries' })).toBeNull();
    expect(broken({ text: 'Brot', gross: 2.49, taxRate: 190, kind: 'groceries' })).toBeNull();
    expect(broken({ text: 'Brot', gross: 2.49, unitPrice: 'viel', kind: 'groceries' })).toBeNull();
    expect(parseModelLines([supermarket[0], 'Brot 2,49'])).toBeNull();
  });

  it('takes a returned deposit printed with a negative quantity, but no negative quantity of a purchase', () => {
    expect(parseModelLines([{ text: 'Leergut', quantity: -6, unitPrice: 0.25, gross: -1.5, kind: 'deposit_discount' }])![0]).toMatchObject({ quantity: -6, grossCents: -150 });
    expect(parseModelLines([{ text: 'Brot', quantity: -1, gross: -2.49, kind: 'groceries' }])).toBeNull();
  });

  it('refuses a list longer than any receipt', () => {
    const many = Array.from({ length: MAX_LINES + 1 }, () => ({ text: 'Brötchen', gross: 0.4, kind: 'groceries' }));
    expect(parseModelLines(many)).toBeNull();
    expect(parseModelLines(many.slice(1))).toHaveLength(MAX_LINES);
  });

  it('collapses the spaces of a text and rounds amounts to cents', () => {
    expect(parseModelLines([{ text: '  Bio  Bananen\n1 kg ', gross: 1.999, kind: 'groceries' }])![0]).toMatchObject({ text: 'Bio Bananen 1 kg', grossCents: 200 });
  });
});

describe('checkLines', () => {
  const reading = (linesSumCents: number, extra: Partial<Parameters<typeof checkLines>[0]> = {}) => ({ lineCount: 3, linesSumCents, linesNetCents: null, totalNetCents: null, ...extra });

  it('adds up within the tolerance of a till receipt', () => {
    expect(checkLines(reading(821), 8.21)).toMatchObject({ differenceCents: 0, addsUp: true, basis: 'gross' });
    expect(checkLines(reading(821 + ADD_UP_TOLERANCE_CENTS), 8.21)!.addsUp).toBe(true);
    expect(checkLines(reading(821 - ADD_UP_TOLERANCE_CENTS - 1), 8.21)!.addsUp).toBe(false);
  });

  it('says by how much the lines miss the total ("Positionen ergeben 41,20 €, Beleg 42,10 €")', () => {
    expect(checkLines(reading(4120), 42.1)).toEqual({ sumCents: 4120, totalCents: 4210, differenceCents: -90, addsUp: false, basis: 'gross' });
  });

  it('checks against the total the row holds now: a corrected total shows the difference at once (backtrack)', () => {
    const stored = reading(4210);
    expect(checkLines(stored, 42.1)!.addsUp).toBe(true);
    expect(checkLines(stored, 45.1)).toMatchObject({ differenceCents: -300, addsUp: false });
  });

  it('checks an electronic invoice on its net amounts, not on the per-line rounded gross', () => {
    expect(checkLines(reading(11902, { linesNetCents: 10000, totalNetCents: 10000 }), 119.0)).toMatchObject({ basis: 'net', addsUp: true, differenceCents: 0 });
    expect(checkLines(reading(11902, { linesNetCents: 9000, totalNetCents: 10000 }), 119.0)).toMatchObject({ basis: 'net', addsUp: false, differenceCents: -1000 });
  });

  it('has nothing to check without lines or without a total', () => {
    expect(checkLines(reading(0, { lineCount: 0 }), 10)).toBeNull();
    expect(checkLines(reading(500), null)).toBeNull();
  });

  it('holds for a credit note, whose lines and total are both negative', () => {
    expect(checkLines(reading(-1190), -11.9)!.addsUp).toBe(true);
  });
});

describe('keys of a kind answer', () => {
  it('ignore case, spaces and punctuation, so the same text at the same shop is one answer', () => {
    expect(vendorKey('REWE Markt GmbH')).toBe(vendorKey('rewe markt-gmbh'));
    expect(vendorKey(null)).toBe('');
    expect(textKey('  Hafermilch  BARISTA, 1l ')).toBe('hafermilch barista 1l');
    expect(textKey('Hafermilch Barista 1L')).toBe(textKey('hafermilch-barista 1l'));
    expect(textKey('Hafermilch')).not.toBe(textKey('Hafermilch 1l'));
  });
});
