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
 * from its label, which is free text. The rule is deliberately narrow, because
 * a transfer is hidden from every question:
 *
 * - It only applies on days the service's own list covers (first to last
 *   booked day of the holding account). Outside them the line on the other
 *   account is the only record of the purchase and stays an ordinary payment.
 * - A debit on a BANK account that names the service is a transfer: banks
 *   show the service's consolidated collection, never the single purchase.
 * - A row on a card or on another service's account that names the service
 *   ("PAYPAL *shop" on the pay-later card) is a transfer only when the
 *   service's list holds a purchase of exactly that amount close to that day
 *   (its twin). Without one it may be a guest checkout the list does not
 *   contain, and stays an ordinary payment.
 * - Money coming IN from a wallet is balance paid out: a transfer. Money
 *   coming in from a pay-later service is money back for a purchase (its list
 *   holds no refunds): a refund, which asks for its receipt.
 */

export type ServiceKind =
  /** Holds a balance and pays merchants from it or from the bank (PayPal). */
  | 'wallet'
  /** Pays the merchant and collects from the bank later (Klarna). */
  | 'pay_later';

const SERVICE_OF_FORMAT: Partial<Record<PaymentFormat, { name: string; kind: ServiceKind }>> = {
  paypal_csv: { name: 'paypal', kind: 'wallet' },
  klarna_csv: { name: 'klarna', kind: 'pay_later' },
};

/** The funding row is booked from 3 days before to 10 days after the purchase it pays, like a proposal. */
export const TWIN_DAYS_BEFORE = 3;
export const TWIN_DAYS_AFTER = 10;

export interface FundingAccount {
  id: string;
  /** 'bank', 'card' or 'payment_service'. */
  kind: string;
  /** The formats of the files imported into the account. */
  formats: readonly string[];
}

export interface FundingPayment {
  id: string;
  accountId: string;
  bookingDay: string;
  /** Signed cents. */
  amountCents: number;
  /** The normalized counterparty: lower case words separated by single spaces. */
  counterpartyKey: string;
  /** What the file says the movement is. */
  sourceKind: string;
}

export interface Funding {
  /** The service's name as it stands in the counterparty ('paypal', 'klarna'). */
  service: string;
  serviceKind: ServiceKind;
  /** What the rule makes of the payment. */
  kind: 'own_transfer' | 'refund';
  /** The purchase in the service's own list that this payment pays, when exactly one fits. */
  twinId: string | null;
}

interface Service {
  name: string;
  kind: ServiceKind;
  /** Per holding account, the days its list covers. */
  holders: Map<string, { first: string; last: string }>;
}

const dayNumber = (day: string) => Math.round(Date.parse(`${day}T00:00:00Z`) / 86_400_000);

/** The service an account holds, or null. An account has one source, so one service. */
export function heldService(account: FundingAccount): { name: string; kind: ServiceKind } | null {
  for (const format of account.formats) {
    const service = SERVICE_OF_FORMAT[format as PaymentFormat];
    if (service) return service;
  }
  return null;
}

/**
 * For every payment the rule applies to, what it funds. `payments` are all
 * payments of the workspace that count (cancelled ones left out).
 */
export function resolveFunding(accounts: readonly FundingAccount[], payments: readonly FundingPayment[]): Map<string, Funding> {
  const out = new Map<string, Funding>();
  const held = new Map<string, { name: string; kind: ServiceKind }>();
  const accountKind = new Map(accounts.map((a) => [a.id, a.kind]));
  const services = new Map<string, Service>();
  for (const account of accounts) {
    const service = heldService(account);
    if (!service) continue;
    held.set(account.id, service);
    if (!services.has(service.name)) services.set(service.name, { ...service, holders: new Map() });
  }
  if (services.size === 0) return out;

  // What each list covers, and its purchases as candidates for a twin.
  const purchases = new Map<string, FundingPayment[]>();
  for (const payment of payments) {
    const service = held.get(payment.accountId);
    if (!service) continue;
    const holders = (services.get(service.name) as Service).holders;
    const span = holders.get(payment.accountId);
    if (!span) holders.set(payment.accountId, { first: payment.bookingDay, last: payment.bookingDay });
    else {
      if (payment.bookingDay < span.first) span.first = payment.bookingDay;
      if (payment.bookingDay > span.last) span.last = payment.bookingDay;
    }
    if (payment.amountCents < 0 && payment.sourceKind === 'spend') {
      purchases.set(service.name, [...(purchases.get(service.name) ?? []), payment]);
    }
  }

  const taken = new Set<string>();
  // In booking order, so the same data always pairs the same way.
  const ordered = [...payments].sort((a, b) => (a.bookingDay === b.bookingDay ? (a.id < b.id ? -1 : 1) : a.bookingDay < b.bookingDay ? -1 : 1));
  for (const payment of ordered) {
    if (!payment.counterpartyKey) continue;
    const own = held.get(payment.accountId)?.name ?? null;
    // The service's name must be a whole word of the counterparty: "paypal europe" matches, "paypalace" does not.
    const service = payment.counterpartyKey
      .split(' ')
      .map((word) => services.get(word))
      .find((s): s is Service => s !== undefined && s.name !== own);
    if (!service) continue;
    const covered = [...service.holders.values()].some((span) => payment.bookingDay >= span.first && payment.bookingDay <= span.last);
    if (!covered) continue;

    if (payment.amountCents > 0) {
      out.set(payment.id, { service: service.name, serviceKind: service.kind, kind: service.kind === 'wallet' ? 'own_transfer' : 'refund', twinId: null });
      continue;
    }
    const day = dayNumber(payment.bookingDay);
    let twin: FundingPayment | null = null;
    let twinGap = Infinity;
    for (const purchase of purchases.get(service.name) ?? []) {
      if (taken.has(purchase.id) || purchase.amountCents !== payment.amountCents) continue;
      const gap = day - dayNumber(purchase.bookingDay);
      if (gap < -TWIN_DAYS_BEFORE || gap > TWIN_DAYS_AFTER) continue;
      if (Math.abs(gap) < twinGap) {
        twin = purchase;
        twinGap = Math.abs(gap);
      }
    }
    const onBank = accountKind.get(payment.accountId) === 'bank' && own === null;
    if (!onBank && twin === null) continue;
    if (twin) taken.add(twin.id);
    out.set(payment.id, { service: service.name, serviceKind: service.kind, kind: 'own_transfer', twinId: twin?.id ?? null });
  }
  return out;
}
