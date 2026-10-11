import { describe, expect, it } from 'vitest';
import { fundedService, fundingServices } from '../funding';

/** Every account and name below is invented. */

const accounts = [
  { id: 'bank', formats: ['n26_csv'] },
  { id: 'wallet', formats: ['paypal_csv', 'paypal_csv'] },
  { id: 'later', formats: ['klarna_csv'] },
];
const services = fundingServices(accounts);

describe('money that only funds another payment account', () => {
  it('knows which account holds which service from the format of its imports', () => {
    expect([...services.keys()].sort()).toEqual(['klarna', 'paypal']);
    expect([...(services.get('paypal') ?? [])]).toEqual(['wallet']);
    // A bank export, and an account nothing was imported into yet, hold no service.
    expect(fundingServices([{ id: 'bank', formats: ['n26_csv', 'tomorrow_csv', 'enable_banking_json'] }, { id: 'new', formats: [] }]).size).toBe(0);
  });

  it('a debit on the bank that names the service funds it, and so does money the service pays back', () => {
    expect(fundedService({ accountId: 'bank', counterpartyKey: 'paypal europe s a r l et cie s c a' }, services)).toBe('paypal');
    expect(fundedService({ accountId: 'bank', counterpartyKey: 'klarna bank ab publ' }, services)).toBe('klarna');
  });

  it('a purchase through one service charged to the other is funding too', () => {
    expect(fundedService({ accountId: 'later', counterpartyKey: 'paypal laden beispiel' }, services)).toBe('paypal');
    expect(fundedService({ accountId: 'wallet', counterpartyKey: 'klarna' }, services)).toBe('klarna');
  });

  it('inside the service’s own account its name is only how a row is labelled', () => {
    expect(fundedService({ accountId: 'wallet', counterpartyKey: 'paypal' }, services)).toBeNull();
    expect(fundedService({ accountId: 'later', counterpartyKey: 'klarna gebuehr' }, services)).toBeNull();
  });

  it('the name must be a whole word of the counterparty, and a payment without a name funds nothing', () => {
    expect(fundedService({ accountId: 'bank', counterpartyKey: 'paypalace hotel' }, services)).toBeNull();
    expect(fundedService({ accountId: 'bank', counterpartyKey: 'laden beispiel' }, services)).toBeNull();
    expect(fundedService({ accountId: 'bank', counterpartyKey: '' }, services)).toBeNull();
  });

  it('without the service’s own list nothing is a transfer: the bank debit is then the only record', () => {
    const bankOnly = fundingServices([{ id: 'bank', formats: ['n26_csv'] }]);
    expect(fundedService({ accountId: 'bank', counterpartyKey: 'paypal europe' }, bankOnly)).toBeNull();
  });

  it('with two accounts of one service a row in either is not funding the other', () => {
    const two = fundingServices([{ id: 'wallet-a', formats: ['paypal_csv'] }, { id: 'wallet-b', formats: ['paypal_csv'] }]);
    expect(fundedService({ accountId: 'wallet-a', counterpartyKey: 'paypal' }, two)).toBeNull();
    expect(fundedService({ accountId: 'bank', counterpartyKey: 'paypal' }, two)).toBe('paypal');
  });
});
