import type { PaymentFormat } from './types';

/**
 * Money that only funds another payment account. Pure.
 *
 * A purchase through a payment service appears twice once both sides are
 * imported: as the purchase in the service's own list, and as the debit the
 * service later collects from the bank (or charges to another service's card).
 * The second one buys nothing. It is the same money on its way, so it is a
 * transfer between the owner's own accounts: never an expense, never asked about.
 *
 * Which service an account holds is known from the format of its imports, not
 * from its label, which is free text. A payment on any OTHER account whose
 * counterparty names that service funds it, in both directions (the debit that
 * pays the service, and money the service pays back out).
 */

/** The name a service carries in the counterparty of the accounts that fund it. */
const SERVICE_OF_FORMAT: Partial<Record<PaymentFormat, string>> = {
  paypal_csv: 'paypal',
  klarna_csv: 'klarna',
};

export interface FundingAccount {
  id: string;
  /** The formats of the files imported into the account. */
  formats: readonly string[];
}

/** Per service name, the accounts that hold that service's own list. */
export type FundingServices = ReadonlyMap<string, ReadonlySet<string>>;

export function fundingServices(accounts: readonly FundingAccount[]): FundingServices {
  const services = new Map<string, Set<string>>();
  for (const account of accounts) {
    for (const format of account.formats) {
      const service = SERVICE_OF_FORMAT[format as PaymentFormat];
      if (!service) continue;
      services.set(service, (services.get(service) ?? new Set()).add(account.id));
    }
  }
  return services;
}

/**
 * The service this payment funds, or null. `counterpartyKey` is the normalized
 * counterparty (lower case words separated by single spaces); the service's
 * name must be one of its words, so "paypal europe" and "paypal vendorname"
 * match and "paypalace" does not. A payment inside the service's own account
 * is never funding: there the name is just how the service labels a row.
 */
export function fundedService(payment: { accountId: string; counterpartyKey: string }, services: FundingServices): string | null {
  if (services.size === 0 || !payment.counterpartyKey) return null;
  for (const word of payment.counterpartyKey.split(' ')) {
    const holders = services.get(word);
    if (holders && !holders.has(payment.accountId)) return word;
  }
  return null;
}
