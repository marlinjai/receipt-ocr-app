import { describe, expect, it } from 'vitest';
import { REFUND_WINDOW_DAYS, orderNumbers, proposeRefunds, type RefundMoney, type RefundTarget } from '../refunds';

/** Every name, number and amount is invented. */

const refund = (o: Partial<RefundMoney> = {}): RefundMoney => ({ id: 'r-1', bookingDay: '2025-03-20', amountCents: 4_999, counterpartyKey: 'versand beispiel', reference: 'Erstattung', kind: 'refund', ...o });
const purchase = (o: Partial<RefundTarget['purchases'][number]> = {}) => ({ bookingDay: '2025-03-02', cents: 4_999, counterpartyKey: 'versand beispiel', reference: 'Bestellung 302-1234567-7654321', ...o });
const target = (o: Partial<RefundTarget> = {}): RefundTarget => ({ rowId: 'row-1', day: '2025-03-02', vendorKey: 'versand beispiel', remainingCents: 4_999, purchases: [purchase()], ...o });

describe('orderNumbers', () => {
  it('finds order and transaction numbers', () => {
    expect([...orderNumbers('Erstattung 302-1234567-7654321 vom 2025-03-20 über 49,99')]).toEqual(['30212345677654321']);
    expect([...orderNumbers('Ref. TX9A88123B')]).toEqual(['tx9a88123b']);
  });
  it('leaves out what banks print on every line: days, masked cards, account numbers, creditor ids, short numbers', () => {
    for (const text of ['Karte XXXX1234', 'DE89370400440532013000', 'Gläubiger DE98ZZZ09999999999', 'am 20250320', 'am 20-03-25', 'am 2025-03-20', 'RMA 4711', '49,99']) {
      expect([...orderNumbers(text)], text).toEqual([]);
    }
  });
});

describe('proposeRefunds', () => {
  it('money back of exactly what a purchase on a receipt cost is a full refund of it', () => {
    expect(proposeRefunds([refund()], [target()])).toEqual([{ paymentId: 'r-1', rowId: 'row-1', strength: 'refund_full' }]);
  });

  it('a number only this purchase shares with the refund is the strongest sign, even for a part', () => {
    const other = target({ rowId: 'row-2', remainingCents: 1_000, purchases: [purchase({ bookingDay: '2025-03-19', cents: 1_000, reference: 'Bestellung 302-9999999-1111111' })] });
    expect(proposeRefunds([refund({ amountCents: 1_000, reference: 'Teilerstattung 302-1234567-7654321' })], [target(), other])).toEqual([
      { paymentId: 'r-1', rowId: 'row-1', strength: 'refund_reference' },
      { paymentId: 'r-1', rowId: 'row-2', strength: 'refund_full' },
    ]);
  });

  it('a number every purchase of the counterparty carries (a customer or mandate number) is no sign', () => {
    const a = target({ rowId: 'a', remainingCents: 9_000, purchases: [purchase({ cents: 9_000, reference: 'Kunde 77123456 Bestellung' })] });
    const b = target({ rowId: 'b', remainingCents: 9_000, purchases: [purchase({ bookingDay: '2025-03-10', cents: 9_000, reference: 'Kunde 77123456 Bestellung' })] });
    expect(proposeRefunds([refund({ amountCents: 1_000, reference: 'Gutschrift Kunde 77123456' })], [a, b]).map((p) => p.strength)).toEqual(['refund_part', 'refund_part']);
  });

  it('money in the file calls income is proposed only on a shared number or in full', () => {
    expect(proposeRefunds([refund({ kind: 'income', amountCents: 1_000 })], [target()])).toEqual([]);
    expect(proposeRefunds([refund({ kind: 'income' })], [target()]).map((p) => p.strength)).toEqual(['refund_full']);
    expect(proposeRefunds([refund({ kind: 'income', amountCents: 1_000, reference: '302-1234567-7654321' })], [target()]).map((p) => p.strength)).toEqual(['refund_reference']);
  });

  it('from a payment service only a shared number proposes a receipt', () => {
    expect(proposeRefunds([refund({ intermediary: true })], [target()])).toEqual([]);
    expect(proposeRefunds([refund({ intermediary: true, reference: 'Rückzahlung 302-1234567-7654321' })], [target()]).map((p) => p.strength)).toEqual(['refund_reference']);
  });

  it('never more money back than the receipt still costs, nor before the purchase, long after it, or in another year', () => {
    expect(proposeRefunds([refund({ amountCents: 6_000 })], [target()])).toEqual([]);
    expect(proposeRefunds([refund({ bookingDay: '2025-03-01' })], [target()])).toEqual([]);
    const late = new Date(Date.parse('2025-03-02T00:00:00Z') + (REFUND_WINDOW_DAYS + 1) * 86_400_000).toISOString().slice(0, 10);
    expect(proposeRefunds([refund({ bookingDay: late })], [target()])).toEqual([]);
    expect(proposeRefunds([refund()], [target({ remainingCents: 2_000 })])).toEqual([]);
    // A December purchase refunded in January: the refund counts in January, the year before is left alone.
    expect(proposeRefunds([refund({ bookingDay: '2026-01-05' })], [target({ day: '2025-12-20', purchases: [purchase({ bookingDay: '2025-12-20' })] })])).toEqual([]);
  });

  it('only through the counterparty: a purchase from someone else is no proposal, whatever the amount', () => {
    expect(proposeRefunds([refund()], [target({ purchases: [purchase({ counterpartyKey: 'laden beispiel', reference: '' })] })])).toEqual([]);
    expect(proposeRefunds([refund({ counterpartyKey: '' })], [target()])).toEqual([]);
  });

  it('a receipt without a linked purchase is proposed by its vendor, word by word', () => {
    const cash = target({ purchases: [], vendorKey: 'versand', remainingCents: 4_999 });
    expect(proposeRefunds([refund({ counterpartyKey: 'versand beispiel gmbh' })], [cash])).toEqual([{ paymentId: 'r-1', rowId: 'row-1', strength: 'refund_full' }]);
    expect(proposeRefunds([refund({ counterpartyKey: 'versandhaus' })], [cash])).toEqual([]);
    expect(proposeRefunds([refund()], [target({ purchases: [], day: null })])).toEqual([]);
    // A short name is no evidence.
    expect(proposeRefunds([refund({ counterpartyKey: 'ag' })], [target({ purchases: [], vendorKey: 'muster ag' })])).toEqual([]);
  });

  it('at most three proposals, the closest purchase first among equals', () => {
    const targets = [5, 1, 9, 3].map((d, i) => target({ rowId: `row-${i}`, remainingCents: 9_000, purchases: [purchase({ bookingDay: `2025-03-${String(20 - d).padStart(2, '0')}`, cents: 9_000, reference: '' })] }));
    expect(proposeRefunds([refund({ amountCents: 1_000 })], targets).map((p) => p.rowId)).toEqual(['row-1', 'row-3', 'row-0']);
  });
});
