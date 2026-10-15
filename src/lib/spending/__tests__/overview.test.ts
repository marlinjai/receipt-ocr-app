import { describe, expect, it } from 'vitest';
import { buildOverview, paymentYears, type OverviewPaymentInput } from '../overview';

let n = 0;
const pay = (bookingDay: string, amountCents: number, counterpartyKey: string, extra: Partial<OverviewPaymentInput> = {}): OverviewPaymentInput => ({
  id: `p${++n}`,
  accountId: 'a1',
  bookingDay,
  amountCents,
  counterparty: counterpartyKey,
  counterpartyKey,
  reference: '',
  kind: 'spend',
  linkCount: 0,
  ...extra,
});

const none = { treatments: new Map(), answers: new Map() };

describe('buildOverview', () => {
  const payments = [
    pay('2026-01-05', -5000, 'rewe'),
    pay('2026-01-20', 1000, 'rewe', { kind: 'refund' }),
    pay('2026-02-03', -2000, 'netflix'),
    pay('2026-02-10', -7000, 'zyx handel'),
    pay('2026-02-11', -3000, 'zyx handel'),
    pay('2026-02-12', -400, '', { counterparty: '', reference: 'Kartenzahlung' }),
    pay('2026-02-15', -50_000, 'tagesgeld', { kind: 'own_transfer' }),
    pay('2026-02-20', 300_000, 'kundin beispiel', { kind: 'income' }),
    pay('2025-12-30', -9999, 'rewe'),
  ];

  it('adds up a year by category and month, refunds deducted, income and own transfers left out', () => {
    const o = buildOverview(payments, none, 2026, null);
    expect(o.totalCents).toBe(5000 - 1000 + 2000 + 7000 + 3000 + 400);
    expect(o.byCategory.find((c) => c.category === 'groceries_drugstore')).toEqual({ category: 'groceries_drugstore', cents: 4000, count: 2 });
    expect(o.byCategory).toHaveLength(12);
    expect(o.byMonth[0].cents).toBe(4000);
    expect(o.byMonth[1].cents).toBe(12_400);
    expect(o.byMonth[1].byCategory.leisure_sport).toBe(2000);
    expect(o.ownTransfers).toEqual({ cents: 50_000, count: 1 });
    expect(o.payments.some((p) => p.kind === 'income')).toBe(false);
  });

  it('lists unclear spending per counterparty, nameless payments one by one', () => {
    const o = buildOverview(payments, none, 2026, null);
    expect(o.unclear).toEqual([
      { counterpartyKey: 'zyx handel', counterparty: 'zyx handel', cents: 10_000, count: 2, lastDay: '2026-02-11' },
      { counterpartyKey: '', counterparty: 'Kartenzahlung', cents: 400, count: 1, lastDay: '2026-02-12' },
    ]);
  });

  it('narrows to one month but keeps the whole year month by month', () => {
    const o = buildOverview(payments, none, 2026, 1);
    expect(o.totalCents).toBe(4000);
    expect(o.unclear).toEqual([]);
    expect(o.byMonth[1].cents).toBe(12_400);
  });

  it('follows answers: a category answer moves the counterparty, an own-account answer takes it out of spending', () => {
    const answered = buildOverview(payments, { treatments: new Map([['netflix', 'own_account' as const]]), answers: new Map([['zyx handel', 'shopping_household' as const]]) }, 2026, 2);
    expect(answered.byCategory.find((c) => c.category === 'shopping_household')?.cents).toBe(10_000);
    expect(answered.byCategory.find((c) => c.category === 'leisure_sport')?.cents).toBe(0);
    expect(answered.ownTransfers.count).toBe(2);
    expect(answered.totalCents).toBe(10_400);
  });

  it('splits private, business and unanswered by what was said', () => {
    const o = buildOverview(payments, { treatments: new Map([['rewe', 'private' as const], ['netflix', 'business' as const]]), answers: new Map() }, 2026, null);
    expect(o.split).toEqual({ private: 4000, business: 2000, unanswered: 10_400 });
  });

  it('marks payments that already have a receipt', () => {
    const o = buildOverview([pay('2026-03-01', -100, 'rewe', { linkCount: 1 })], none, 2026, null);
    expect(o.payments[0].hasReceipt).toBe(true);
  });
});

describe('paymentYears', () => {
  it('lists the years with payments and the current one, newest first', () => {
    expect(paymentYears([{ bookingDay: '2024-05-01' }, { bookingDay: '2025-01-01' }], 2026)).toEqual([2026, 2025, 2024]);
  });
});
