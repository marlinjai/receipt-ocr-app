import { describe, expect, it } from 'vitest';
import { SPENDING_CATEGORIES } from '@/lib/spending/categories';
import { KIND_CATEGORY, PURCHASE_KINDS, PURCHASE_KIND_HINTS, PURCHASE_KIND_LABELS, isPurchaseKind } from '../kinds';
import { ADD_UP_TOLERANCE_CENTS, MAX_LINES, checkLines, parseModelLines, priceLines, sumGrossCents, textKey, vendorKey, type PricingTotals, type ReceiptTotals } from '../lines';

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

  // Synthetic invoices of the three kinds the reading got wrong (no real document's figures).
  it('keeps an amount the invoice deducts as a negative line of the kind it was charged for, so a usage invoice adds up', () => {
    // Usage of the month 59.76 and 80.49, the part already charged mid-month taken off: total 80.21, no tax.
    const lines = parseModelLines([
      { text: 'Usage, requests totalling 59.76', quantity: 1, unitPrice: 59.76, gross: 59.76, taxRate: null, kind: 'software_services' },
      { text: 'Usage, tokens', quantity: 1, unitPrice: 80.49, gross: 80.49, taxRate: null, kind: 'software_services' },
      { text: 'Mid-month usage paid', quantity: null, unitPrice: null, gross: -60.04, taxRate: null, kind: 'software_services' },
    ])!;
    expect(lines.map((l) => l.grossCents)).toEqual([5976, 8049, -6004]);
    expect(checkLines({ lineCount: 3, linesSumCents: sumGrossCents(lines), linesNetCents: null, totalNetCents: null }, { gross: 80.21, net: 80.21, tip: null })).toMatchObject({ addsUp: true, basis: 'gross' });
  });

  it('takes a position whose discount is printed in its own row at its amount after the discount: one line, adding up', () => {
    // Price 9.99, discount -1.00, total before tax 8.99; 19 % added once below: 10.70.
    const lines = parseModelLines([{ text: 'Web hosting, 12 months', quantity: 1, unitPrice: 9.99, gross: 8.99, taxRate: 19, kind: 'software_services' }])!;
    const priced = priceLines(lines, { gross: 10.7, net: 8.99, taxRate: 19, tip: null }, true);
    expect(priced.lines).toHaveLength(1);
    expect(priced.lines[0]).toMatchObject({ netCents: 899, grossCents: 1070 });
    expect(checkLines({ lineCount: 1, linesSumCents: sumGrossCents(priced.lines), linesNetCents: priced.linesNetCents, totalNetCents: null }, { gross: 10.7, net: 8.99, tip: null })!.addsUp).toBe(true);
  });

  it('adds up an invoice without its payment, applied credit or earlier balance as lines', () => {
    // A phone bill: this month's plan 30.00 gross; an earlier balance and its interest are carried on the account, not charged by this invoice.
    const lines = parseModelLines([{ text: 'Mobile plan', gross: 30.0, taxRate: 19, kind: 'software_services' }])!;
    expect(checkLines({ lineCount: 1, linesSumCents: sumGrossCents(lines), linesNetCents: null, totalNetCents: null }, { gross: 30.0, net: 25.21, tip: null })!.addsUp).toBe(true);
  });
});

describe('checkLines', () => {
  const reading = (linesSumCents: number, extra: Partial<Parameters<typeof checkLines>[0]> = {}) => ({ lineCount: 3, linesSumCents, linesNetCents: null, totalNetCents: null, ...extra });
  const row = (gross: number | null, extra: Partial<ReceiptTotals> = {}): ReceiptTotals => ({ gross, net: null, tip: null, ...extra });

  it('adds up within the tolerance of a till receipt, on both edges', () => {
    expect(checkLines(reading(821), row(8.21))).toMatchObject({ differenceCents: 0, addsUp: true, basis: 'gross', tipCents: 0 });
    expect(checkLines(reading(821 + ADD_UP_TOLERANCE_CENTS), row(8.21))!.addsUp).toBe(true);
    expect(checkLines(reading(821 - ADD_UP_TOLERANCE_CENTS), row(8.21))!.addsUp).toBe(true);
    expect(checkLines(reading(821 + ADD_UP_TOLERANCE_CENTS + 1), row(8.21))!.addsUp).toBe(false);
    expect(checkLines(reading(821 - ADD_UP_TOLERANCE_CENTS - 1), row(8.21))!.addsUp).toBe(false);
  });

  it('says by how much the lines miss the total ("Positionen ergeben 41,20 €, Beleg 42,10 €")', () => {
    expect(checkLines(reading(4120), row(42.1))).toEqual({ sumCents: 4120, totalCents: 4210, differenceCents: -90, addsUp: false, basis: 'gross', tipCents: 0 });
  });

  it('checks against the total the row holds now: a corrected total shows the difference at once (backtrack)', () => {
    const stored = reading(4210);
    expect(checkLines(stored, row(42.1))!.addsUp).toBe(true);
    expect(checkLines(stored, row(45.1))).toMatchObject({ differenceCents: -300, addsUp: false });
  });

  it('checks an electronic invoice on its net amounts, not on the per-line rounded gross', () => {
    expect(checkLines(reading(11902, { linesNetCents: 10000, totalNetCents: 10000 }), row(119.0))).toMatchObject({ basis: 'net', addsUp: true, differenceCents: 0 });
    expect(checkLines(reading(11902, { linesNetCents: 9000, totalNetCents: 10000 }), row(119.0))).toMatchObject({ basis: 'net', addsUp: false, differenceCents: -1000 });
  });

  it('checks a printed invoice priced before tax on net, against the net the row holds now', () => {
    const repriced = reading(2618, { linesNetCents: 2200 });
    expect(checkLines(repriced, row(26.18, { net: 22.0 }))).toMatchObject({ basis: 'net', addsUp: true, sumCents: 2200, totalCents: 2200 });
    // The net corrected on the row: the difference shows at once.
    expect(checkLines(repriced, row(26.18, { net: 25.0 }))).toMatchObject({ basis: 'net', addsUp: false, differenceCents: -300 });
    // A row without a net: the lines' gross against the gross.
    expect(checkLines(repriced, row(26.18))).toMatchObject({ basis: 'gross', addsUp: true });
  });

  it('lets lines stored with their printed net amounts add up on net, when they match the net and not the gross', () => {
    // A subscription invoice: one line of 22.00 before tax, 19 % added once, total 26.18.
    expect(checkLines(reading(2200), row(26.18, { net: 22.0 }))).toMatchObject({ basis: 'net', addsUp: true, sumCents: 2200, totalCents: 2200 });
    // A receipt at 7 % and one with two rates: the row's own net decides, no rate is assumed.
    expect(checkLines(reading(1000), row(10.7, { net: 10.0 }))).toMatchObject({ basis: 'net', addsUp: true });
    expect(checkLines(reading(3000), row(34.4, { net: 30.0 }))).toMatchObject({ basis: 'net', addsUp: true });
    // Matching neither: the difference is the one against the gross.
    expect(checkLines(reading(2100), row(26.18, { net: 22.0 }))).toMatchObject({ basis: 'gross', addsUp: false, differenceCents: -518 });
    // Lines that add up to the gross stay on gross even where a net is stored.
    expect(checkLines(reading(2618), row(26.18, { net: 22.0 }))).toMatchObject({ basis: 'gross', addsUp: true });
  });

  it('counts the row\'s tip when the lines include a tip line, and checks against the gross alone when they do not', () => {
    // A restaurant bill: food and drinks 44.00, a tip line of 4.40; the row holds the tip apart.
    expect(checkLines(reading(4840), row(44.0, { tip: 4.4 }))).toMatchObject({ basis: 'gross', addsUp: true, totalCents: 4840, tipCents: 440 });
    // The same bill without its tip line.
    expect(checkLines(reading(4400), row(44.0, { tip: 4.4 }))).toMatchObject({ basis: 'gross', addsUp: true, totalCents: 4400, tipCents: 0 });
    // Neither: the difference is the one against the gross, without the tip.
    expect(checkLines(reading(4700), row(44.0, { tip: 4.4 }))).toMatchObject({ addsUp: false, totalCents: 4400, differenceCents: 300, tipCents: 0 });
    // Within the tolerance of the gross plus the tip, on both edges.
    expect(checkLines(reading(4840 + ADD_UP_TOLERANCE_CENTS), row(44.0, { tip: 4.4 }))!.addsUp).toBe(true);
    expect(checkLines(reading(4840 + ADD_UP_TOLERANCE_CENTS + 1), row(44.0, { tip: 4.4 }))!.addsUp).toBe(false);
  });

  it('checks a receipt in another currency in that currency, never converted', () => {
    // A usage invoice in US dollars: the row's gross and net and the lines are all dollars.
    expect(checkLines(reading(8021), row(80.21, { net: 80.21 }))).toMatchObject({ basis: 'gross', addsUp: true, totalCents: 8021 });
    expect(checkLines(reading(2000), row(23.8, { net: 20.0 }))).toMatchObject({ basis: 'net', addsUp: true });
  });

  it('has nothing to check without lines or without a total', () => {
    expect(checkLines(reading(0, { lineCount: 0 }), row(10))).toBeNull();
    expect(checkLines(reading(500), row(null))).toBeNull();
  });

  it('holds for a credit note, whose lines and total are both negative', () => {
    expect(checkLines(reading(-1190), row(-11.9))!.addsUp).toBe(true);
  });
});

describe('priceLines', () => {
  const printed = (...amounts: Array<[string, number, number | null]>) => parseModelLines(amounts.map(([text, gross, taxRate]) => ({ text, gross, taxRate, kind: 'software_services' })))!;
  const totals = (gross: number | null, net: number | null, extra: Partial<PricingTotals> = {}): PricingTotals => ({ gross, net, taxRate: 19, tip: null, ...extra });

  it('keeps a till receipt\'s amounts as printed, even where the model said they are net (nothing is taxed twice)', () => {
    const lines = printed(['Brot', 2.49, 7], ['Wasser', 1.19, 19]);
    for (const flag of [false, true, null]) {
      const priced = priceLines(lines, totals(3.68, 3.33), flag);
      expect(priced.linesNetCents).toBeNull();
      expect(priced.lines.map((l) => [l.grossCents, l.netCents])).toEqual([
        [249, null],
        [119, null],
      ]);
    }
  });

  it('gives an invoice printed before tax its gross: the printed amount stays as the net (forward)', () => {
    // One line of 22.00, 19 % added once, total 26.18.
    const priced = priceLines(printed(['Plus plan', 22.0, null]), totals(26.18, 22.0), null);
    expect(priced).toEqual({ lines: [expect.objectContaining({ netCents: 2200, grossCents: 2618 })], linesNetCents: 2200 });
    expect(sumGrossCents(priced.lines)).toBe(2618);
  });

  it('puts the cents of rounding on the largest line, so the lines add up to the gross exactly', () => {
    // Three lines whose tax rounded per line (0.06 + 0.06 + 0.06) misses the tax on their sum (0.19) by a cent.
    const priced = priceLines(printed(['A', 0.33, null], ['B', 0.33, null], ['C', 0.34, null]), totals(1.19, 1.0), null);
    expect(priced.lines.map((l) => l.grossCents)).toEqual([39, 39, 41]);
    expect(sumGrossCents(priced.lines)).toBe(119);
    // Of equal lines the first takes it.
    const tie = priceLines(printed(['A', 0.33, null], ['B', 0.33, null], ['C', 0.33, null]), totals(1.18, 0.99), null);
    expect(tie.lines.map((l) => l.grossCents)).toEqual([40, 39, 39]);
  });

  it('prices a receipt at 7 % and one with two rates by the row\'s own figures, not by an assumed rate', () => {
    const seven = priceLines(printed(['Buch', 10.0, null]), totals(10.7, 10.0, { taxRate: 7 }), null);
    expect(seven.lines[0]).toMatchObject({ netCents: 1000, grossCents: 1070 });
    // Two lines at their own rates.
    const mixed = priceLines(printed(['Speisen', 20.0, 7], ['Getränke', 10.0, 19]), totals(33.3, 30.0), null);
    expect(mixed.lines.map((l) => l.grossCents)).toEqual([2140, 1190]);
    // Two rates the lines do not name (the row's rate is the larger part's): the row's ratio of gross to net prices them.
    const unnamed = priceLines(printed(['Speisen', 20.0, null], ['Getränke', 10.0, null]), totals(33.3, 30.0), null);
    expect(unnamed.lines.map((l) => l.grossCents)).toEqual([2220, 1110]);
    expect(sumGrossCents(unnamed.lines)).toBe(3330);
  });

  it('takes the model\'s word that the amounts are net only where the row\'s figures say nothing', () => {
    // Lines that match neither total (a line missing): net only on the model's word, priced at their rate, the gap left visible.
    const lines = printed(['Hosting', 10.0, null]);
    expect(priceLines(lines, totals(23.8, 20.0), null).linesNetCents).toBeNull();
    const flagged = priceLines(lines, totals(23.8, 20.0), true);
    expect(flagged).toMatchObject({ linesNetCents: 1000, lines: [{ netCents: 1000, grossCents: 1190 }] });
    // No total on the row at all: the model's word and the rate decide.
    expect(priceLines(lines, totals(null, null), true).lines[0]).toMatchObject({ netCents: 1000, grossCents: 1190 });
    // No rate anywhere: the amounts stay as printed.
    expect(priceLines(lines, totals(null, null, { taxRate: null }), true)).toMatchObject({ linesNetCents: null, lines: [{ grossCents: 1000, netCents: null }] });
  });

  it('keeps a deduction negative, and prices it with the rest', () => {
    // Usage 120.00, a deduction of 20.00 already charged, 19 % on the rest: total 119.00.
    const priced = priceLines(printed(['Usage', 120.0, null], ['Usage paid earlier', -20.0, null]), totals(119.0, 100.0), null);
    expect(priced.lines.map((l) => [l.netCents, l.grossCents])).toEqual([
      [12000, 14280],
      [-2000, -2380],
    ]);
  });

  it('prices a receipt in another currency in that currency', () => {
    const priced = priceLines(printed(['API usage', 20.0, null]), totals(23.8, 20.0), null);
    expect(priced.lines[0]).toMatchObject({ netCents: 2000, grossCents: 2380 });
  });

  it('leaves a tip line to the tip rule: lines with the tip add up to the gross plus the tip, as printed', () => {
    const meal = parseModelLines([
      { text: 'Pasta', gross: 44.0, taxRate: 7, kind: 'meal_out' },
      { text: 'Trinkgeld', gross: 4.4, kind: 'meal_out' },
    ])!;
    expect(priceLines(meal, totals(44.0, 41.12, { tip: 4.4 }), null).linesNetCents).toBeNull();
  });

  it('keeps an empty list empty', () => {
    expect(priceLines([], totals(10, 8.4), true)).toEqual({ lines: [], linesNetCents: null });
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
