import { describe, expect, it } from 'vitest';
import { buildPurchasesOverview, type PurchaseLineInput, type PurchaseReceiptInput } from '../overview';

let n = 0;
const l = (text: string, grossCents: number, kind: PurchaseLineInput['kind'], quantity: number | null = 1): PurchaseLineInput => ({ text, grossCents, kind, quantity });
const r = (date: string, grossCents: number | null, lines: PurchaseLineInput[] | null, extra: Partial<PurchaseReceiptInput> = {}): PurchaseReceiptInput => ({
  rowId: `r${++n}`,
  date,
  vendor: 'REWE',
  grossCents,
  currency: 'EUR',
  fxRate: 1,
  lines,
  ...extra,
});

describe('Was gekauft', () => {
  it('sums per kind, and counts the receipts\' totals with what the lines do not explain shown on its own', () => {
    const o = buildPurchasesOverview(
      [
        r('2026-10-03', 1357, [l('Hafermilch', 358, 'groceries', 2), l('Kaffeebohnen', 899, 'coffee_tea'), l('Pfand', 150, 'deposit_discount', 6), l('Rabatt', -50, 'deposit_discount')]),
        r('2026-10-05', 1730, [l('Cappuccino', 780, 'drink_out', 2), l('Croque', 950, 'meal_out')], { vendor: 'Café Rot' }),
        // A receipt without lines and one whose lines miss its total.
        r('2026-10-07', 2000, null, { vendor: 'Tankstelle' }),
        r('2026-10-09', 500, [l('Hafermilch', 179, 'groceries')]),
      ],
      { year: 2026, month: 10 },
    );
    expect(o).toMatchObject({ totalCents: 5587, linesCents: 3266, unexplainedCents: 2321, receipts: 4, receiptsWithLines: 3, unconverted: 0 });
    expect(o.kinds.map((k) => [k.kind, k.cents])).toEqual([
      ['meal_out', 950],
      ['coffee_tea', 899],
      ['drink_out', 780],
      ['groceries', 537],
      ['deposit_discount', 100],
    ]);
    // The deposit follows the receipt's main category.
    expect(o.categories).toEqual([
      { category: 'groceries_drugstore', label: 'Lebensmittel und Drogerie', cents: 1536 },
      { category: 'eating_out_coffee', label: 'Essen gehen und Kaffee', cents: 1730 },
    ].sort((a, b) => b.cents - a.cents));
    expect(o.months).toEqual([]);
  });

  it('lists the items bought most often with how many and what they cost ("Hafermilch, 3 mal")', () => {
    const o = buildPurchasesOverview(
      [r('2026-10-03', 358, [l('Hafermilch', 358, 'groceries', 2)]), r('2026-10-04', 179, [l('HAFERMILCH', 179, 'groceries')]), r('2026-10-05', 300, [l('Bananen', 300, 'groceries', 1.234), l('Pfand', 25, 'deposit_discount')])],
      { year: 2026, month: 10 },
    );
    expect(o.topItems).toEqual([
      { text: 'Hafermilch', count: 3, cents: 537, kind: 'groceries' },
      { text: 'Bananen', count: 1, cents: 300, kind: 'groceries' },
    ]);
  });

  it('says per shop what was bought there', () => {
    const o = buildPurchasesOverview(
      [r('2026-10-03', 900, [l('Brot', 300, 'groceries'), l('Bier', 600, 'alcohol')]), r('2026-10-05', 800, [l('Cappuccino', 800, 'drink_out')], { vendor: 'Café Rot' })],
      { year: 2026, month: 10 },
    );
    expect(o.shops).toEqual([
      { vendor: 'REWE', cents: 900, receipts: 1, kinds: [{ kind: 'alcohol', label: 'Alkohol', cents: 600 }, { kind: 'groceries', label: 'Lebensmittel', cents: 300 }] },
      { vendor: 'Café Rot', cents: 800, receipts: 1, kinds: [{ kind: 'drink_out', label: 'Getränk im Café oder in der Bar', cents: 800 }] },
    ]);
  });

  it('a whole year shows month by month, and only receipts of the period count', () => {
    const o = buildPurchasesOverview(
      [r('2026-01-10', 500, [l('Brot', 500, 'groceries')]), r('2026-03-02', 700, [l('Wein', 700, 'alcohol')]), r('2025-12-31', 999, [l('Sekt', 999, 'alcohol')]), r('', 100, null, { date: null })],
      { year: 2026, month: null },
    );
    expect(o.totalCents).toBe(1200);
    expect(o.months.map((m) => [m.month, m.totalCents, m.kinds[0].kind])).toEqual([
      [1, 500, 'groceries'],
      [3, 700, 'alcohol'],
    ]);
  });

  it('counts a receipt in another currency at its rate, and leaves one without a rate out', () => {
    const o = buildPurchasesOverview(
      [r('2026-10-03', 1000, [l('Coffee', 1000, 'drink_out')], { currency: 'USD', fxRate: 0.9 }), r('2026-10-04', 1000, [l('Tea', 1000, 'drink_out')], { currency: 'GBP', fxRate: null })],
      { year: 2026, month: 10 },
    );
    expect(o).toMatchObject({ totalCents: 900, linesCents: 900, unconverted: 1, receipts: 1 });
  });

  it('converts a receipt\'s lines once, so lines that add up leave no rounding unexplained', () => {
    const o = buildPurchasesOverview([r('2026-10-03', 1000, [l('A', 333, 'drink_out'), l('B', 333, 'drink_out'), l('C', 334, 'drink_out')], { currency: 'USD', fxRate: 0.915 })], { year: 2026, month: 10 });
    expect(o).toMatchObject({ totalCents: 915, linesCents: 915, unexplainedCents: 0 });
  });

  it('leaves a receipt without a total out, and a credit note\'s discount follows its own category', () => {
    const o = buildPurchasesOverview(
      [r('2026-10-03', null, [l('Brot', 300, 'groceries')]), r('2026-10-04', -1100, [l('Lizenz', -1000, 'software_services'), l('Rabatt zurück', -100, 'deposit_discount')])],
      { year: 2026, month: 10 },
    );
    expect(o).toMatchObject({ withoutTotal: 1, receipts: 1, totalCents: -1100, unexplainedCents: 0 });
    expect(o.categories).toEqual([{ category: 'software_ai_hosting', label: 'Software, KI und Hosting', cents: -1100 }]);
  });

  it('a credit note lowers what was bought', () => {
    const o = buildPurchasesOverview([r('2026-10-03', 1000, [l('Lizenz', 1000, 'software_services')]), r('2026-10-04', -1000, [l('Lizenz', -1000, 'software_services')])], { year: 2026, month: 10 });
    expect(o).toMatchObject({ totalCents: 0, linesCents: 0, kinds: [] });
  });
});
