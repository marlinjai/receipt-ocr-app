import { describe, expect, it } from 'vitest';
import { heldService, resolveFunding, type FundingPayment } from '../funding';

/** Every account and name below is invented. */

const accounts = [
  { id: 'bank', kind: 'bank', formats: ['n26_csv'] },
  { id: 'card', kind: 'card', formats: [] },
  { id: 'wallet', kind: 'payment_service', formats: ['paypal_csv', 'paypal_csv'] },
  { id: 'later', kind: 'payment_service', formats: ['klarna_csv'] },
];
let n = 0;
const payment = (o: Partial<FundingPayment> & { accountId: string }): FundingPayment => ({ id: `p${++n}`, bookingDay: '2025-03-12', amountCents: -1999, counterpartyKey: '', sourceKind: 'spend', ...o });
/** The wallet's list covers 1 to 31 March 2025 and holds one purchase of 19.99 on the 11th. */
const walletList = () => [
  payment({ id: 'w-first', accountId: 'wallet', bookingDay: '2025-03-01', amountCents: -100, counterpartyKey: 'kiosk beispiel' }),
  payment({ id: 'w-shop', accountId: 'wallet', bookingDay: '2025-03-11', counterpartyKey: 'laden beispiel' }),
  payment({ id: 'w-last', accountId: 'wallet', bookingDay: '2025-03-31', amountCents: -200, counterpartyKey: 'kiosk beispiel' }),
];
const laterList = () => [
  payment({ id: 'l-first', accountId: 'later', bookingDay: '2025-03-01', amountCents: -500, counterpartyKey: 'kiosk beispiel' }),
  payment({ id: 'l-last', accountId: 'later', bookingDay: '2025-03-31', amountCents: -700, counterpartyKey: 'kiosk beispiel' }),
];
const fundingOf = (subject: FundingPayment, others: FundingPayment[]) => resolveFunding(accounts, [...others, subject]).get(subject.id) ?? null;

describe('money that only funds another payment account', () => {
  it('knows which account holds which service from the format of its imports', () => {
    expect(heldService(accounts[2])).toEqual({ name: 'paypal', kind: 'wallet' });
    expect(heldService(accounts[3])).toEqual({ name: 'klarna', kind: 'pay_later' });
    expect(heldService({ id: 'bank', kind: 'bank', formats: ['n26_csv', 'tomorrow_csv', 'enable_banking_json'] })).toBeNull();
    expect(heldService({ id: 'new', kind: 'payment_service', formats: [] })).toBeNull();
  });

  it('a debit on the bank that names the service is a transfer, with or without a purchase of the same amount in the list', () => {
    const single = fundingOf(payment({ accountId: 'bank', counterpartyKey: 'paypal europe s a r l et cie s c a' }), walletList());
    expect(single).toEqual({ service: 'paypal', serviceKind: 'wallet', kind: 'own_transfer', twinId: 'w-shop' });
    // A consolidated collection equals no single purchase.
    const collected = fundingOf(payment({ accountId: 'bank', amountCents: -1200, counterpartyKey: 'klarna bank ab publ' }), laterList());
    expect(collected).toEqual({ service: 'klarna', serviceKind: 'pay_later', kind: 'own_transfer', twinId: null });
  });

  it('only on days the service’s list covers: before its first and after its last day the bank line is the only record', () => {
    const on = (bookingDay: string) => fundingOf(payment({ accountId: 'bank', bookingDay, counterpartyKey: 'paypal europe' }), walletList()) !== null;
    expect([on('2025-02-28'), on('2025-03-01'), on('2025-03-31'), on('2025-04-01'), on('2024-11-12'), on('2026-03-12')]).toEqual([false, true, true, false, false, false]);
  });

  it('money coming in: a wallet pays balance out (a transfer), a pay-later service pays money back (a refund)', () => {
    expect(fundingOf(payment({ accountId: 'bank', amountCents: 5000, sourceKind: 'income', counterpartyKey: 'paypal europe' }), walletList())).toMatchObject({ kind: 'own_transfer', twinId: null });
    expect(fundingOf(payment({ accountId: 'bank', amountCents: 1240, sourceKind: 'income', counterpartyKey: 'klarna bank ab' }), laterList())).toMatchObject({ service: 'klarna', kind: 'refund', twinId: null });
  });

  it('on a card or another service’s account the row is a transfer only with its twin in the list', () => {
    const lists = [...walletList(), ...laterList()];
    expect(fundingOf(payment({ accountId: 'later', bookingDay: '2025-03-11', counterpartyKey: 'paypal ladenbeispiel' }), lists)).toMatchObject({ kind: 'own_transfer', twinId: 'w-shop' });
    expect(fundingOf(payment({ accountId: 'card', bookingDay: '2025-03-13', counterpartyKey: 'paypal ladenbeispiel' }), lists)).toMatchObject({ twinId: 'w-shop' });
    // A guest checkout the wallet's list does not hold: another amount.
    expect(fundingOf(payment({ accountId: 'later', amountCents: -4500, counterpartyKey: 'paypal gastshop' }), lists)).toBeNull();
    // The same amount, but booked outside 3 days before to 10 days after the purchase.
    expect(fundingOf(payment({ accountId: 'card', bookingDay: '2025-03-07', counterpartyKey: 'paypal ladenbeispiel' }), lists)).toBeNull();
    expect(fundingOf(payment({ accountId: 'card', bookingDay: '2025-03-22', counterpartyKey: 'paypal ladenbeispiel' }), lists)).toBeNull();
  });

  it('a purchase is the twin of one funding row only', () => {
    const first = payment({ accountId: 'card', bookingDay: '2025-03-11', counterpartyKey: 'paypal ladenbeispiel' });
    const second = payment({ accountId: 'card', bookingDay: '2025-03-12', counterpartyKey: 'paypal ladenbeispiel' });
    const funding = resolveFunding(accounts, [...walletList(), first, second]);
    expect(funding.get(first.id)).toMatchObject({ twinId: 'w-shop' });
    expect(funding.has(second.id)).toBe(false);
  });

  it('inside the service’s own account its name is only how a row is labelled', () => {
    expect(fundingOf(payment({ accountId: 'wallet', counterpartyKey: 'paypal' }), walletList())).toBeNull();
    expect(fundingOf(payment({ accountId: 'later', bookingDay: '2025-03-10', counterpartyKey: 'klarna gebuehr' }), laterList())).toBeNull();
  });

  it('the name must be a whole word of the counterparty, and a payment without a name funds nothing', () => {
    expect(fundingOf(payment({ accountId: 'bank', counterpartyKey: 'paypalace hotel' }), walletList())).toBeNull();
    expect(fundingOf(payment({ accountId: 'bank', counterpartyKey: 'laden beispiel' }), walletList())).toBeNull();
    expect(fundingOf(payment({ accountId: 'bank', counterpartyKey: '' }), walletList())).toBeNull();
  });

  it('without the service’s own list, or with an empty one, nothing is a transfer', () => {
    expect(fundingOf(payment({ accountId: 'bank', counterpartyKey: 'paypal europe' }), [])).toBeNull();
    expect(resolveFunding([accounts[0]], [payment({ accountId: 'bank', counterpartyKey: 'paypal europe' })]).size).toBe(0);
  });

  it('with two accounts of one service a row in either is not funding the other', () => {
    const two = [{ id: 'bank', kind: 'bank', formats: ['n26_csv'] }, { id: 'wallet-a', kind: 'payment_service', formats: ['paypal_csv'] }, { id: 'wallet-b', kind: 'payment_service', formats: ['paypal_csv'] }];
    const listed = [payment({ accountId: 'wallet-a', bookingDay: '2025-03-01' }), payment({ accountId: 'wallet-b', bookingDay: '2025-03-31' })];
    const inside = payment({ accountId: 'wallet-a', bookingDay: '2025-03-10', counterpartyKey: 'paypal' });
    const outside = payment({ accountId: 'bank', bookingDay: '2025-03-31', amountCents: -1, counterpartyKey: 'paypal' });
    const funding = resolveFunding(two, [...listed, inside, outside]);
    expect(funding.has(inside.id)).toBe(false);
    // Covered by the second account's list, although the first one ended weeks before.
    expect(funding.get(outside.id)).toMatchObject({ kind: 'own_transfer' });
  });
});
