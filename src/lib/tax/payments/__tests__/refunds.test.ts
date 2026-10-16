import { describe, expect, it } from 'vitest';
import { REFUND_WINDOW_DAYS, orderNumbers, proposeRefunds, type RefundMoney, type RefundTarget } from '../refunds';

/** Every name, number and amount is invented. */

const refund = (o: Partial<RefundMoney> = {}): RefundMoney => ({ id: 'r-1', bookingDay: '2025-03-20', amountCents: 4_999, counterpartyKey: 'versand beispiel', reference: 'Erstattung', ...o });
const target = (o: Partial<RefundTarget> = {}): RefundTarget => ({
  rowId: 'row-1',
  day: '2025-03-02',
  vendorKey: 'versand beispiel',
  remainingCents: 4_999,
  purchases: [{ bookingDay: '2025-03-02', cents: 4_999, counterpartyKey: 'versand beispiel', reference: 'Bestellung 302-1234567-7654321' }],
  ...o,
});

describe('orderNumbers', () => {
  it('finds order and transaction numbers, not days, amounts or words', () => {
    expect([...orderNumbers('Erstattung 302-1234567-7654321 vom 2025-03-20 über 49,99')]).toEqual(['30212345677654321']);
    expect([...orderNumbers('Rückgabe RMA 4711 Juni')]).toEqual([]);
    expect([...orderNumbers('Ref. TX9A88123B')]).toEqual(['tx9a88123b']);
  });
});

describe('proposeRefunds', () => {
  it('money back of exactly what a purchase on a receipt cost is a full refund of it', () => {
    expect(proposeRefunds([refund()], [target()])).toEqual([{ paymentId: 'r-1', rowId: 'row-1', strength: 'refund_full' }]);
  });

  it('a shared order number is the strongest sign, even when the amount is a part', () => {
    const proposals = proposeRefunds(
      [refund({ amountCents: 1_000, reference: 'Teilerstattung 302-1234567-7654321' })],
      [target(), target({ rowId: 'row-2', purchases: [{ bookingDay: '2025-03-19', cents: 1_000, counterpartyKey: 'versand beispiel', reference: 'Bestellung 302-9999999-1111111' }], remainingCents: 1_000 })],
    );
    expect(proposals).toEqual([
      { paymentId: 'r-1', rowId: 'row-1', strength: 'refund_reference' },
      { paymentId: 'r-1', rowId: 'row-2', strength: 'refund_full' },
    ]);
  });

  it('never proposes more money back than the receipt still costs, nor a refund before the purchase or long after it', () => {
    expect(proposeRefunds([refund({ amountCents: 6_000 })], [target()])).toEqual([]);
    expect(proposeRefunds([refund({ bookingDay: '2025-03-01' })], [target()])).toEqual([]);
    const late = new Date(Date.parse('2025-03-02T00:00:00Z') + (REFUND_WINDOW_DAYS + 1) * 86_400_000).toISOString().slice(0, 10);
    expect(proposeRefunds([refund({ bookingDay: late })], [target()])).toEqual([]);
    // A receipt already refunded in part has only the rest left.
    expect(proposeRefunds([refund()], [target({ remainingCents: 2_000 })])).toEqual([]);
  });

  it('only through the counterparty: a purchase from someone else is no proposal, whatever the amount', () => {
    expect(proposeRefunds([refund()], [target({ purchases: [{ bookingDay: '2025-03-02', cents: 4_999, counterpartyKey: 'laden beispiel', reference: '' }] })])).toEqual([]);
    expect(proposeRefunds([refund({ counterpartyKey: '' })], [target()])).toEqual([]);
  });

  it('a receipt without a linked purchase is proposed by its vendor, word by word', () => {
    const cash = target({ purchases: [], vendorKey: 'versand', remainingCents: 4_999 });
    expect(proposeRefunds([refund({ counterpartyKey: 'versand beispiel gmbh' })], [cash])).toEqual([{ paymentId: 'r-1', rowId: 'row-1', strength: 'refund_full' }]);
    // Part of a word is not the same name.
    expect(proposeRefunds([refund({ counterpartyKey: 'versandhaus' })], [cash])).toEqual([]);
    // Without a day the window cannot be judged.
    expect(proposeRefunds([refund()], [target({ purchases: [], day: null })])).toEqual([]);
  });

  it('at most three proposals, the closest purchase first among equals', () => {
    const targets = [5, 1, 9, 3].map((d, i) => target({ rowId: `row-${i}`, purchases: [{ bookingDay: `2025-03-${String(20 - d).padStart(2, '0')}`, cents: 9_000, counterpartyKey: 'versand beispiel', reference: '' }], remainingCents: 9_000 }));
    expect(proposeRefunds([refund({ amountCents: 1_000 })], targets).map((p) => p.rowId)).toEqual(['row-1', 'row-3', 'row-0']);
  });
});
