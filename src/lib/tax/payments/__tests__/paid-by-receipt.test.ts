import { describe, expect, it } from 'vitest';
import { paidByReceipt, type PaymentRow } from '../service';

/** What pays each receipt: the one sum the guards and the hand choice read. Every figure is invented. */

const row = (id: string, amountCents: number, links: Array<{ rowId: string; cents: number }>, twinId: string | null = null): PaymentRow => ({
  id,
  accountId: 'a',
  bookingDay: '2026-05-10',
  amountCents,
  counterparty: 'Laden',
  counterpartyKey: 'laden',
  reference: '',
  kind: amountCents < 0 ? 'spend' : 'refund',
  kindOverridden: false,
  sourceKind: amountCents < 0 ? 'spend' : 'refund',
  funding: twinId ? ({ twinId } as PaymentRow['funding']) : null,
  byRule: false,
  byPrivateAccount: false,
  links: links.map((l, i) => ({ id: `${id}-${i}`, rowId: l.rowId, invoiceId: null, cents: l.cents, method: 'manual' })),
});

describe('paidByReceipt', () => {
  it('counts a purchase and the debit funding it once', () => {
    const purchase = row('purchase', -5000, [{ rowId: 'r', cents: 5000 }]);
    const debit = row('debit', -5000, [{ rowId: 'r', cents: 5000 }], 'purchase');
    expect(paidByReceipt([purchase, debit], new Map()).get('r')).toBe(5000);
  });

  it('takes money back off, never below nothing, and adds links on other companies\' payments', () => {
    expect(paidByReceipt([row('back', 2000, [{ rowId: 'r', cents: 2000 }])], new Map()).get('r')).toBe(0);
    expect(paidByReceipt([row('out', -3000, [{ rowId: 'r', cents: 3000 }]), row('back', 1000, [{ rowId: 'r', cents: 1000 }])], new Map([['r', 500]])).get('r')).toBe(2500);
    expect(paidByReceipt([], new Map([['s', 700]])).get('s')).toBe(700);
    // Own money back larger than own purchases, with a link elsewhere: only the final sum stops at nothing.
    expect(paidByReceipt([row('back', 3000, [{ rowId: 't', cents: 3000 }])], new Map([['t', 10000]])).get('t')).toBe(7000);
  });
});
