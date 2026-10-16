import { describe, expect, it } from 'vitest';
import type { PaymentRow } from '../payments/service';
import { linkedByRow } from '../service';

/** A bank movement linked to receipts; negative is money out. */
function payment(id: string, bookingDay: string, amountCents: number, links: Array<{ rowId: string; cents: number }>, extra: Partial<PaymentRow> = {}): PaymentRow {
  return {
    id,
    accountId: 'acc',
    bookingDay,
    amountCents,
    counterparty: 'Netzwerk Nord GmbH',
    counterpartyKey: 'netzwerk nord',
    reference: '',
    kind: amountCents < 0 ? 'spend' : 'refund',
    kindOverridden: false,
    sourceKind: amountCents < 0 ? 'spend' : 'refund',
    funding: null,
    byRule: false,
    byPrivateAccount: false,
    taxDay: bookingDay,
    payLater: null,
    links: links.map((l, i) => ({ id: `${id}-${i}`, rowId: l.rowId, invoiceId: null, cents: l.cents, method: 'manual' })),
    ...extra,
  };
}

describe('linkedByRow: money out and money back per receipt', () => {
  it('money back only: no payment, the refund as before, and the money back with its first day', () => {
    const linked = linkedByRow([payment('p2', '2026-01-20', 4_000, [{ rowId: 'cn', cents: 4_000 }]), payment('p1', '2026-01-08', 7_900, [{ rowId: 'cn', cents: 7_900 }])]);
    expect(linked.get('cn')).toEqual({ paid: null, refundedCents: 11_900, back: { day: '2026-01-08', cents: 11_900 }, outCents: 0 });
  });

  it('money out and money back: the payment as before, money out gross, money back beside it', () => {
    const linked = linkedByRow([payment('out', '2026-03-05', -11_900, [{ rowId: 'r', cents: 11_900 }]), payment('back', '2026-03-20', 1_900, [{ rowId: 'r', cents: 1_900 }])]);
    expect(linked.get('r')).toEqual({ paid: { day: '2026-03-05', cents: 10_000 }, refundedCents: 0, back: { day: '2026-03-20', cents: 1_900 }, outCents: 11_900 });
  });

  it('a payment and the debit that funds it count once', () => {
    const purchase = payment('pp', '2026-02-01', -5_000, [{ rowId: 'r', cents: 5_000 }]);
    const debit = payment('bank', '2026-02-03', -5_000, [{ rowId: 'r', cents: 5_000 }], {
      funding: { service: 'paypal', serviceKind: 'wallet', kind: 'own_transfer', twinId: 'pp' } as unknown as PaymentRow['funding'],
    });
    expect(linkedByRow([purchase, debit]).get('r')).toMatchObject({ paid: { day: '2026-02-01', cents: 5_000 }, outCents: 5_000, back: null });
  });

  it('money out counts on its tax day: a pay-later purchase paid later at the checkout on the day it was collected', () => {
    const linked = linkedByRow([payment('later', '2025-12-10', -4_000, [{ rowId: 'r', cents: 4_000 }], { taxDay: '2026-01-08' })]);
    expect(linked.get('r')?.paid).toEqual({ day: '2026-01-08', cents: 4_000 });
  });
});
