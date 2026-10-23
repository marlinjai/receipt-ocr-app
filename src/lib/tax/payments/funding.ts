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
 * Which service an account holds is known from its imports, not from its
 * label, which is free text: the format of a service's own list, or, for an
 * import of the bank interface, the service the connection's institution is
 * (stored on the import, so it holds after the connection ends). The rule is
 * deliberately narrow, because a transfer is hidden from every question:
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
 * - Money coming IN from a wallet is a transfer only when the wallet's own
 *   list shows that money leaving it: a row of the same amount without a
 *   merchant (a payout, or bank funding sent back). That row is then a
 *   transfer too. Without one the credit may be anything and is asked about.
 * - Money coming in from a pay-later service is money back for a purchase (its
 *   list holds no refunds): a refund, which asks for its receipt.
 * - A bank debit WITHOUT a counterparty whose text names the merchant of
 *   exactly one purchase in a wallet's list, booked close to it and no larger
 *   than it, is the part of that purchase the wallet drew from the bank.
 * - Money coming INTO a wallet without a counterparty (a top-up; the live feed
 *   gives no type) is a transfer when another account shows a debit naming the
 *   service of exactly that amount close to it; that debit is then a transfer
 *   too. Without one it is asked about.
 * - A purchase whose euro amount is an estimate (another currency at the
 *   reference rate) is the twin of a funding row within `ESTIMATE_TOLERANCE_PERCENT`;
 *   every other twin has exactly the same amount.
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

/**
 * Services an import of the bank interface can hold, by the name stored on the
 * import. Only PayPal: Klarna's pay-later purchases are not offered by the interface.
 */
const SERVICE_OF_NAME: Record<string, { name: string; kind: ServiceKind }> = {
  paypal: { name: 'paypal', kind: 'wallet' },
};

/** The service a connection's institution is, from its name ("PayPal", "PayPal Europe"); null for a bank. */
export function serviceOfInstitution(name: string | null | undefined): string | null {
  return typeof name === 'string' && /paypal/i.test(name) ? 'paypal' : null;
}

/**
 * How far the euro amount charged may lie from a purchase's estimate (another
 * currency at the reference rate): PayPal converts with a margin of about 3 to
 * 4.5 percent over that rate, and the rate of the next day may apply.
 */
export const ESTIMATE_TOLERANCE_PERCENT = 6;

/** The funding row is booked from 3 days before to 10 days after the purchase it pays, like a proposal. */
export const TWIN_DAYS_BEFORE = 3;
export const TWIN_DAYS_AFTER = 10;

export interface FundingAccount {
  id: string;
  /** 'bank', 'card' or 'payment_service'. */
  kind: string;
  /** The formats of the files imported into the account. */
  formats: readonly string[];
  /** The services its imports of the bank interface hold (see `TaxImportBatch.service`). */
  services?: readonly (string | null)[];
}

export interface FundingPayment {
  id: string;
  accountId: string;
  bookingDay: string;
  /** Signed cents. */
  amountCents: number;
  /** The normalized counterparty: lower case words separated by single spaces. */
  counterpartyKey: string;
  /** The payment's text, normalized like the counterparty. */
  referenceKey: string;
  /** What the file says the movement is. */
  sourceKind: string;
  /** True when the euro amount is an estimate at the reference rate. */
  estimated?: boolean;
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
  for (const name of account.services ?? []) {
    const service = name ? SERVICE_OF_NAME[name] : undefined;
    if (service) return service;
  }
  return null;
}

/** Whether `amountCents` (signed) is what `purchase` cost: exactly, or within the tolerance of an estimate. */
function sameAmount(purchase: FundingPayment, amountCents: number): boolean {
  if (!purchase.estimated) return purchase.amountCents === amountCents;
  if (Math.sign(purchase.amountCents) !== Math.sign(amountCents)) return false;
  return Math.abs(amountCents - purchase.amountCents) * 100 <= Math.abs(purchase.amountCents) * ESTIMATE_TOLERANCE_PERCENT;
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

  // Rows of a wallet's own list that move its balance and name no merchant: where money paid out to the bank shows.
  const movements = new Map<string, FundingPayment[]>();
  for (const payment of payments) {
    const service = held.get(payment.accountId);
    if (service?.kind === 'wallet' && payment.amountCents < 0 && (payment.counterpartyKey === '' || payment.sourceKind === 'own_transfer')) {
      movements.set(service.name, [...(movements.get(service.name) ?? []), payment]);
    }
  }
  const hasWords = (text: string, words: string) => ` ${text} `.includes(` ${words} `);
  const taken = new Set<string>();
  const namesService = (payment: FundingPayment, service: string) => payment.counterpartyKey.split(' ').includes(service);
  // Money into a wallet without a counterparty (a top-up): a transfer when exactly the same amount leaves
  // another account towards the service close to it, which is then a transfer too.
  for (const credit of [...payments].sort((a, b) => (a.bookingDay === b.bookingDay ? (a.id < b.id ? -1 : 1) : a.bookingDay < b.bookingDay ? -1 : 1))) {
    const service = held.get(credit.accountId);
    if (service?.kind !== 'wallet' || credit.amountCents <= 0 || credit.counterpartyKey !== '' || credit.sourceKind === 'own_transfer') continue;
    const day = dayNumber(credit.bookingDay);
    let best: FundingPayment | null = null;
    let bestGap = Infinity;
    for (const debit of payments) {
      if (out.has(debit.id) || debit.amountCents !== -credit.amountCents || held.get(debit.accountId)?.name === service.name || !namesService(debit, service.name)) continue;
      const gap = dayNumber(debit.bookingDay) - day;
      if (gap < -TWIN_DAYS_BEFORE || gap > TWIN_DAYS_AFTER) continue;
      if (Math.abs(gap) < bestGap) {
        best = debit;
        bestGap = Math.abs(gap);
      }
    }
    if (!best) continue;
    out.set(credit.id, { service: service.name, serviceKind: service.kind, kind: 'own_transfer', twinId: null });
    out.set(best.id, { service: service.name, serviceKind: service.kind, kind: 'own_transfer', twinId: null });
  }
  // In booking order, so the same data always pairs the same way.
  const ordered = [...payments].sort((a, b) => (a.bookingDay === b.bookingDay ? (a.id < b.id ? -1 : 1) : a.bookingDay < b.bookingDay ? -1 : 1));
  for (const payment of ordered) {
    // Already the other end of a top-up.
    if (out.has(payment.id)) continue;
    const own = held.get(payment.accountId)?.name ?? null;
    if (!payment.counterpartyKey) {
      // A bank debit without a counterparty: the part of a wallet purchase drawn from the bank, when its
      // text names that purchase's merchant and exactly one purchase fits.
      if (own !== null || accountKind.get(payment.accountId) !== 'bank' || payment.amountCents >= 0 || !payment.referenceKey) continue;
      const day = dayNumber(payment.bookingDay);
      for (const service of services.values()) {
        if (service.kind !== 'wallet') continue;
        const fits = (purchases.get(service.name) ?? []).filter((purchase) => {
          if (taken.has(purchase.id) || purchase.counterpartyKey.length < 3 || purchase.amountCents > payment.amountCents) return false;
          const gap = day - dayNumber(purchase.bookingDay);
          return gap >= -TWIN_DAYS_BEFORE && gap <= TWIN_DAYS_AFTER && hasWords(payment.referenceKey, purchase.counterpartyKey);
        });
        if (fits.length !== 1) continue;
        taken.add(fits[0].id);
        out.set(payment.id, { service: service.name, serviceKind: service.kind, kind: 'own_transfer', twinId: fits[0].id });
        break;
      }
      continue;
    }
    // The service's name must be a whole word of the counterparty: "paypal europe" matches, "paypalace" does not.
    const service = payment.counterpartyKey
      .split(' ')
      .map((word) => services.get(word))
      .find((s): s is Service => s !== undefined && s.name !== own);
    if (!service) continue;
    const covered = [...service.holders.values()].some((span) => payment.bookingDay >= span.first && payment.bookingDay <= span.last);
    if (!covered) continue;

    const day = dayNumber(payment.bookingDay);
    if (payment.amountCents > 0) {
      if (service.kind === 'pay_later') {
        out.set(payment.id, { service: service.name, serviceKind: service.kind, kind: 'refund', twinId: null });
        continue;
      }
      // The wallet's list has to show the same money leaving it, from 3 days after to 10 days before this credit.
      const movement = (movements.get(service.name) ?? []).find((row) => {
        const gap = day - dayNumber(row.bookingDay);
        return !taken.has(row.id) && row.amountCents === -payment.amountCents && gap >= -TWIN_DAYS_BEFORE && gap <= TWIN_DAYS_AFTER;
      });
      if (!movement) continue;
      taken.add(movement.id);
      out.set(payment.id, { service: service.name, serviceKind: service.kind, kind: 'own_transfer', twinId: null });
      // The other end of the same money: the wallet's row is no purchase without a name, it is the payout.
      out.set(movement.id, { service: service.name, serviceKind: service.kind, kind: 'own_transfer', twinId: null });
      continue;
    }
    let twin: FundingPayment | null = null;
    let twinGap = Infinity;
    for (const purchase of purchases.get(service.name) ?? []) {
      if (taken.has(purchase.id) || !sameAmount(purchase, payment.amountCents)) continue;
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
