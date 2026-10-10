import { describe, expect, it } from 'vitest';
import { SMALL_BUSINESS, REGULAR_BUSINESS, meal } from '@/lib/meals/__tests__/fixtures';
import type { MealRecord } from '@/lib/meals/types';
import { computeYear } from '../compute';
import { resolveItems, type ReceiptFacts } from '../facts';
import { LinesInputError, itemIdOf, linesMatchTotal, splitItemId, spreadOverLines, validateLines, type ReceiptLine } from '../lines';
import { rulesForYear } from '../rules';

const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return e instanceof LinesInputError ? e.code : `unexpected: ${String(e)}`;
  }
  return 'no error';
};

/** An invented order over 1,100.00: a tripod, a memory card and a private item. */
function order(overrides: Partial<MealRecord> = {}): MealRecord {
  return meal({
    rowId: 'r-1',
    name: 'Bestellung 4711',
    vendor: 'Versand Beispiel',
    category: 'Hardware & IT',
    mealType: null,
    gross: 1100,
    net: null,
    occasion: '',
    place: '',
    host: '',
    tip: null,
    guests: [],
    ...overrides,
  });
}
const line = (id: string, grossCents: number, overrides: Partial<ReceiptLine> = {}): ReceiptLine => ({ id, position: 0, description: id, grossCents, netCents: null, treatment: null, ...overrides });
const facts = (record: MealRecord, lines: ReceiptLine[], extra: Partial<ReceiptFacts> = {}): ReceiptFacts => ({ record, businessSharePercent: null, decision: null, lines, ...extra });

describe('validateLines', () => {
  const two = [{ description: 'Stativ', grossCents: 90_000 }, { description: 'Karte', grossCents: 20_000 }];

  it('accepts lines that add up to the receipt and keeps the ids of existing lines', () => {
    expect(validateLines([{ id: 'l-1', ...two[0], netCents: 75_630 }, two[1]], 110_000)).toEqual([
      { id: 'l-1', description: 'Stativ', grossCents: 90_000, netCents: 75_630 },
      { description: 'Karte', grossCents: 20_000, netCents: null },
    ]);
  });

  it.each([
    ['one line', [two[0]], 90_000, 'lines_required'],
    ['no list', 'x', 110_000, 'lines_required'],
    ['a line without a name', [{ description: ' ', grossCents: 90_000 }, two[1]], 110_000, 'line_description_required'],
    ['a line without an amount', [{ description: 'Stativ', grossCents: 0 }, two[1]], 20_000, 'invalid_line_amount'],
    ['a fractional cent', [{ description: 'Stativ', grossCents: 90_000.5 }, two[1]], 110_000, 'invalid_line_amount'],
    ['a net amount above the line', [{ ...two[0], netCents: 90_001 }, two[1]], 110_000, 'invalid_line_net'],
    ['lines that do not add up', two, 110_001, 'lines_do_not_sum'],
    ['a receipt without a total', two, null, 'receipt_without_total'],
    ['the same line twice', [{ id: 'l-1', ...two[0] }, { id: 'l-1', ...two[1] }], 110_000, 'duplicate_line'],
    ['more than fifty lines', Array.from({ length: 51 }, () => ({ description: 'x', grossCents: 1 })), 51, 'too_many_lines'],
  ])('rejects %s', (_name, raw, total, expected) => {
    expect(code(() => validateLines(raw, total as number | null))).toBe(expected);
  });
});

describe('spreadOverLines', () => {
  it('adds up to exactly the amount, whatever the proportions', () => {
    for (const amount of [1, 99, 10_850, 98_765, 110_000]) {
      for (const lines of [[{ grossCents: 1 }, { grossCents: 1 }, { grossCents: 1 }], [{ grossCents: 90_000 }, { grossCents: 20_000 }], [{ grossCents: 3_333 }, { grossCents: 3_333 }, { grossCents: 3_334 }]]) {
        const parts = spreadOverLines(amount, lines);
        expect(parts.reduce((s, p) => s + p, 0)).toBe(amount);
        expect(parts.every((p) => p >= 0)).toBe(true);
      }
    }
  });

  it('leaves the amounts alone when nothing was converted', () => {
    expect(spreadOverLines(110_000, [{ grossCents: 90_000 }, { grossCents: 20_000 }])).toEqual([90_000, 20_000]);
  });

  it('checks the total and round-trips item ids', () => {
    expect(linesMatchTotal([{ grossCents: 90_000 }, { grossCents: 20_000 }], 110_000)).toBe(true);
    expect(linesMatchTotal([{ grossCents: 90_000 }], 110_000)).toBe(false);
    expect(linesMatchTotal([], null)).toBe(false);
    expect(splitItemId(itemIdOf('row', 'line'))).toEqual({ rowId: 'row', lineId: 'line' });
    expect(splitItemId(itemIdOf('row', null))).toEqual({ rowId: 'row', lineId: null });
  });
});

describe('resolveItems: a split receipt', () => {
  const run = (items: ReturnType<typeof resolveItems>) => computeYear({ year: 2025, items: items.map((r) => r.item) }, rulesForYear(2025));

  it('an unsplit receipt is one item, as before', () => {
    const items = resolveItems(facts(order(), []), [], SMALL_BUSINESS);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ rowId: 'r-1', lineId: null, item: { id: 'r-1', amountCents: 110_000 } });
    // 1,100.00 on the low-value line is above the limit as a whole.
    expect(run(items).checks.map((c) => c.kind)).toEqual(['needs_asset']);
  });

  it('each line is its own item, judged on its own: two small items pass the limit a whole receipt would not', () => {
    const items = resolveItems(facts(order(), [line('a', 60_000), line('b', 50_000, { position: 1 })]), [], SMALL_BUSINESS);
    expect(items.map((r) => [r.item.id, r.lineId, r.item.amountCents, r.item.label])).toEqual([
      ['r-1#a', 'a', 60_000, 'Bestellung 4711: a'],
      ['r-1#b', 'b', 50_000, 'Bestellung 4711: b'],
    ]);
    const result = run(items);
    expect(result.checks).toEqual([]);
    expect(result.lines[0]).toMatchObject({ key: 'euer.low_value_assets', cents: 110_000 });
  });

  it('a line with its own decision is treated on its own; the others follow the receipt', () => {
    const own = { allocations: [{ purpose: 'private' as const, shareBp: 10000 }], formLineKey: null, employmentLineKey: null };
    const items = resolveItems(facts(order(), [line('a', 60_000), line('b', 50_000, { position: 1, treatment: own })]), [], SMALL_BUSINESS);
    expect(items.map((r) => r.allocationOrigin)).toEqual(['legacy_columns', 'line']);
    const result = run(items);
    expect(result.businessExpenseCents).toBe(60_000);
    expect(result.privateCents).toBe(50_000);
  });

  it('lines that no longer add up to the receipt block the whole receipt', () => {
    const items = resolveItems(facts(order({ gross: 1200 }), [line('a', 60_000), line('b', 50_000)]), [], SMALL_BUSINESS);
    expect(items).toHaveLength(1);
    const result = run(items);
    expect(result.checks.map((c) => c.kind)).toContain('lines_do_not_sum');
    expect(result.businessExpenseCents).toBe(0);
  });

  it('a foreign-currency or paid receipt carries its euro amount down to the lines to the cent', () => {
    const converted = resolveItems(facts(order({ currency: 'USD', fxRate: 0.9173 }), [line('a', 60_000), line('b', 50_000)]), [], SMALL_BUSINESS);
    expect(converted.map((r) => r.item.amountCents)).toEqual([55_038, 45_865]);
    expect(converted.reduce((s, r) => s + (r.item.amountCents as number), 0)).toBe(100_903);
    const paid = resolveItems(facts(order(), [line('a', 60_000), line('b', 50_000)], { paid: { day: '2025-07-01', cents: 109_999 } }), [], SMALL_BUSINESS);
    expect(paid.map((r) => [r.item.amountCents, r.item.date, r.item.amountBasis])).toEqual([[59_999, '2025-07-01', 'payment'], [50_000, '2025-07-01', 'payment']]);
  });

  it('a line carries its own net amount, which regular taxation needs', () => {
    const items = resolveItems(facts(order({ category: 'Bürobedarf' }), [line('a', 59_500, { netCents: 50_000 }), line('b', 50_500, { position: 1 })]), [], REGULAR_BUSINESS);
    expect(items.map((r) => r.item.netCents)).toEqual([50_000, null]);
    const result = run(items);
    expect(result.checks.map((c) => [c.itemId, c.kind])).toEqual([['r-1#b', 'net_amount_missing']]);
    expect(result.lines.map((l) => [l.key, l.cents])).toEqual([['euer.work_equipment', 50_000], ['euer.input_vat', 9_500]]);
  });

  it('a refund without a linked purchase is taken off the receipt and so off its lines, on the receipt\'s own day', () => {
    const whole = resolveItems(facts(order(), [], { refundedCents: 10_000 }), [], SMALL_BUSINESS);
    expect(whole.map((r) => [r.item.amountCents, r.item.date, r.item.amountBasis])).toEqual([[100_000, '2025-03-14', 'document']]);
    const split = resolveItems(facts(order(), [line('a', 60_000), line('b', 50_000)], { refundedCents: 10_000 }), [], SMALL_BUSINESS);
    expect(split.map((r) => r.item.amountCents)).toEqual([54_545, 45_455]);
    // With a payment out linked, the payment decides and the refund is already in it.
    const paid = resolveItems(facts(order(), [], { paid: { day: '2025-07-01', cents: 90_000 }, refundedCents: 10_000 }), [], SMALL_BUSINESS);
    expect(paid[0].item.amountCents).toBe(90_000);
  });

  it('a meal is never split, whatever lines exist', () => {
    const items = resolveItems(facts(meal(), [line('a', 6_000), line('b', 5_900)]), [], SMALL_BUSINESS);
    expect(items).toHaveLength(1);
    expect(items[0].isMeal).toBe(true);
  });
});
