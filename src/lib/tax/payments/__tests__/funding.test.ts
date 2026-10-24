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
const payment = (o: Partial<FundingPayment> & { accountId: string }): FundingPayment => ({ id: `p${++n}`, bookingDay: '2025-03-12', amountCents: -1999, counterpartyKey: '', referenceKey: '', sourceKind: 'spend', ...o });
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

  it('only on days the service’s list covers: before its first and after its last day a wallet’s bank line is the only record', () => {
    const on = (bookingDay: string) => fundingOf(payment({ accountId: 'bank', bookingDay, counterpartyKey: 'paypal europe' }), walletList()) !== null;
    // A wallet's bank debit is the purchase itself: one the list does not show yet is asked about, it never waits.
    expect([on('2025-02-28'), on('2025-03-01'), on('2025-03-31'), on('2025-04-01'), on('2024-11-12'), on('2026-03-12')]).toEqual([false, true, true, false, false, false]);
  });

  it('a collective debit after the end of the pay-later list waits for the list, at most 60 days, and pairs as usual once the list covers its day', () => {
    const debit = (bookingDay: string, id = `d-${bookingDay}`, amountCents = -126_169) => payment({ id, accountId: 'bank', bookingDay, amountCents, counterpartyKey: 'klarna bank ab publ' });
    // What the list's own open purchases explain (5.00 + 7.00 of March, nothing collected since) is an ordinary collection.
    expect(fundingOf(debit('2025-04-23', 'd-small', -1200), laterList())).toEqual({ service: 'klarna', serviceKind: 'pay_later', kind: 'own_transfer', twinId: null });
    // A collection inside the list's days already paid them: the next one beyond them waits.
    const paid = [...laterList(), debit('2025-03-31', 'd-march', -1200)];
    expect(resolveFunding(accounts, [...paid, debit('2025-04-23', 'd-april', -1200)]).get('d-april')).toMatchObject({ awaitingList: true });
    expect(fundingOf(debit('2025-04-23'), laterList())).toEqual({ service: 'klarna', serviceKind: 'pay_later', kind: 'own_transfer', twinId: null, awaitingList: true });
    expect(fundingOf(debit('2025-05-30'), laterList())?.awaitingList).toBe(true);
    expect(fundingOf(debit('2025-05-31'), laterList())).toBeNull();
    // Money back after the end of the list is no collection: it stays a question (a refund needs its list too).
    expect(fundingOf(payment({ accountId: 'bank', bookingDay: '2025-04-05', amountCents: 500, counterpartyKey: 'klarna bank ab publ' }), laterList())).toBeNull();
    // On a card it is no collective debit either.
    expect(fundingOf(payment({ accountId: 'card', bookingDay: '2025-04-05', amountCents: -500, counterpartyKey: 'klarna bank ab publ' }), laterList())).toBeNull();
    // The next list arrives and covers the day: the usual rule, no longer waiting.
    const longer = [...laterList(), payment({ id: 'l-april', accountId: 'later', bookingDay: '2025-04-25', amountCents: -300, counterpartyKey: 'kiosk beispiel' })];
    expect(fundingOf(debit('2025-04-23'), longer)).toEqual({ service: 'klarna', serviceKind: 'pay_later', kind: 'own_transfer', twinId: null });
  });


  it('money coming in: a wallet pays balance out (a transfer), a pay-later service pays money back (a refund)', () => {
    // A credit from the wallet alone proves nothing: it may be a payout, a refund or a sale.
    const credit = payment({ accountId: 'bank', bookingDay: '2025-03-14', amountCents: 5000, sourceKind: 'income', counterpartyKey: 'paypal europe' });
    expect(fundingOf(credit, walletList())).toBeNull();
    expect(fundingOf(payment({ accountId: 'bank', amountCents: 1240, sourceKind: 'income', counterpartyKey: 'klarna bank ab' }), laterList())).toMatchObject({ service: 'klarna', kind: 'refund', twinId: null });
  });

  it('a credit from the wallet is a transfer when the wallet’s list shows that money leaving it, and that row is a transfer too', () => {
    const credit = payment({ accountId: 'bank', bookingDay: '2025-03-14', amountCents: 5000, sourceKind: 'income', counterpartyKey: 'paypal europe' });
    // The wallet's row: no merchant, the same amount going out, two days earlier (read from the file as a spend without a name).
    const payout = payment({ id: 'w-out', accountId: 'wallet', bookingDay: '2025-03-12', amountCents: -5000, counterpartyKey: '' });
    const funding = resolveFunding(accounts, [...walletList(), payout, credit]);
    expect(funding.get(credit.id)).toEqual({ service: 'paypal', serviceKind: 'wallet', kind: 'own_transfer', twinId: null });
    expect(funding.get('w-out')).toMatchObject({ kind: 'own_transfer' });
    // Another amount, a purchase with a merchant, or a row too far away is no such movement.
    const not = (row: FundingPayment) => resolveFunding(accounts, [...walletList(), row, credit]).has(credit.id);
    expect(not({ ...payout, amountCents: -4999 })).toBe(false);
    expect(not({ ...payout, counterpartyKey: 'laden beispiel' })).toBe(false);
    expect(not({ ...payout, bookingDay: '2025-03-01' })).toBe(false);
    // One payout explains one credit.
    const second = payment({ accountId: 'bank', bookingDay: '2025-03-15', amountCents: 5000, sourceKind: 'income', counterpartyKey: 'paypal europe' });
    const both = resolveFunding(accounts, [...walletList(), payout, credit, second]);
    expect([both.has(credit.id), both.has(second.id)]).toEqual([true, false]);
  });

  it('a bank debit without a counterparty is the part of a wallet purchase drawn from the bank, when its text names that one purchase’s merchant', () => {
    // 139.49 bought through the wallet, of which 114.08 came from the bank.
    const bought = payment({ id: 'w-big', accountId: 'wallet', bookingDay: '2025-03-20', amountCents: -13_949, counterpartyKey: 'geraete beispiel' });
    const debit = (o: Partial<FundingPayment> = {}) => payment({ accountId: 'bank', bookingDay: '2025-03-21', amountCents: -11_408, counterpartyKey: '', referenceKey: 'pp 1234 pp geraete beispiel ihr einkauf', ...o });
    const of = (d: FundingPayment, extra: FundingPayment[] = []) => resolveFunding(accounts, [...walletList(), bought, ...extra, d]).get(d.id) ?? null;
    expect(of(debit())).toEqual({ service: 'paypal', serviceKind: 'wallet', kind: 'own_transfer', twinId: 'w-big' });
    // More than the purchase, a text naming nobody, outside the window, or two purchases that fit: left alone.
    expect(of(debit({ amountCents: -14_000 }))).toBeNull();
    expect(of(debit({ referenceKey: 'lastschrift' }))).toBeNull();
    expect(of(debit({ bookingDay: '2025-03-31' }))).toBeNull();
    expect(of(debit(), [payment({ accountId: 'wallet', bookingDay: '2025-03-22', amountCents: -20_000, counterpartyKey: 'geraete beispiel' })])).toBeNull();
    // Only on a bank account, and only for a wallet.
    expect(of(debit({ accountId: 'card' }))).toBeNull();
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
