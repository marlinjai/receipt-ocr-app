import type { PayLaterDetail } from './types';

/**
 * The day a pay-later purchase counts on for tax. Pure.
 *
 * Under cash-basis profit determination an expense counts in the year it is
 * paid (section 11 (2) of the income tax act). For a purchase through the
 * pay-later service that day depends on how it was paid (see
 * `docs/plans/2026-10-11-pay-later-payments.md`, "Which day a pay-later
 * purchase counts on"):
 *
 * - **Card** (the service's card, or a merchant text in the card network's
 *   form "PAYPAL *shop"): the purchase day. Authorizing the charge is the payment.
 * - **Financed** (instalments, "Term Loan"): the purchase day. The loan pays
 *   the merchant at the purchase; the instalments repay the loan.
 * - **Direct debit**: the day the debit leaves the bank. The list's capture
 *   day (stored as the payment's value day) is the closest value it has.
 * - **Checkout, paid later** (invoice or "In 30 Tagen zahlen" chosen at a
 *   shop's checkout, and every wording the reader does not know): the day the
 *   money leaves for the service, that is the collection that settles the
 *   statement holding the purchase. Without such a collection the purchase
 *   stays on its purchase day and is listed as "Einzugstag unbekannt".
 *
 * Nothing here is stored: it is worked out whenever payments are loaded, from
 * what the list says (`source_detail`), a person's correction of one purchase
 * (`pay_method_override`) and the collections the funding rule recognizes.
 */

export type PayLaterMethod = 'card' | 'financed' | 'direct_debit' | 'checkout';
export const PAY_LATER_METHODS: readonly PayLaterMethod[] = ['card', 'financed', 'direct_debit', 'checkout'];
/** What a person can say about one purchase: it was paid by card, or at the checkout and paid later. */
export type PayMethodOverride = 'card' | 'checkout';
export const PAY_METHOD_OVERRIDES: readonly PayMethodOverride[] = ['card', 'checkout'];

/** A merchant text in the card network's form: a `*` between two names ("PAYPAL *shop", "SQ * Cafe"). */
export function looksLikeCardText(merchant: string): boolean {
  return /[\p{L}\p{N}]\s*\*\s*[\p{L}\p{N}]/u.test(merchant);
}

/** The payment method wordings the list is known to carry, each with what it means. */
const KNOWN_METHODS: Array<[RegExp, PayLaterMethod]> = [
  [/^cards?$/, 'card'],
  [/^term loan$/, 'financed'],
  [/^direct debit$/, 'direct_debit'],
  [/^invoice$/, 'checkout'],
  [/^in \d+ tagen zahlen$/, 'checkout'],
];

/** What a payment method wording means, or null when the reader does not know it. */
export function knownPayLaterMethod(wording: string): PayLaterMethod | null {
  const text = wording.replace(/\s+/g, ' ').trim().toLowerCase();
  return KNOWN_METHODS.find(([pattern]) => pattern.test(text))?.[1] ?? null;
}

/**
 * How a purchase was paid, from what the list says. A card the list marks
 * wins over the wording, because "Invoice" only names how the service is
 * reimbursed and card purchases carry it too. A loan or a direct debit the
 * list names is that, whatever the merchant text. The card network's text
 * ("PAYPAL *shop") marks a card where the wording says invoice or nothing
 * known. An unknown wording is read as checkout: the cautious reading, which
 * never claims an expense before anything was paid.
 */
export function classifyPayLater(detail: PayLaterDetail, merchant: string): PayLaterMethod {
  const known = knownPayLaterMethod(detail.method);
  if (known === 'card' || detail.card === true) return 'card';
  if (known === 'financed' || known === 'direct_debit') return known;
  if (looksLikeCardText(merchant)) return 'card';
  return known ?? 'checkout';
}

export interface TaxDayPurchase {
  id: string;
  bookingDay: string;
  valueDay: string | null;
  /** Signed cents: a purchase is money out, money back for one (a refund on the same statement) money in. */
  amountCents: number;
  counterparty: string;
  detail: PayLaterDetail | null;
  override: PayMethodOverride | null;
}

export interface TaxDayCollection {
  id: string;
  bookingDay: string;
  /** Signed cents; a collection is money out of the other account. */
  amountCents: number;
  /** The collection's text (counterparty and remittance information). */
  text: string;
  /**
   * The purchase the funding rule pairs this debit with (its twin), when it
   * found one. A debit twinned with a direct-debit purchase is that purchase's
   * own money and settles no statement. Any other twin is only the nearest
   * purchase of the same amount (a checkout invoice is collected weeks later,
   * outside the twin window), so such a debit still counts as a collection.
   */
  twinId?: string | null;
}

/**
 * How long after a statement's last purchase its collection is looked for by
 * amount alone: the service's invoice is due after 14 or 30 days, a reminder
 * adds a few weeks. A debit of the same sum months later is another statement's.
 */
export const COLLECTION_DAYS_AFTER = 60;

export interface PayLaterDay {
  /**
   * How the purchase was paid. Null for a purchase imported before the list's
   * detail was kept and without a card text: it stays on its purchase day
   * until the list is read again.
   */
  method: PayLaterMethod | null;
  /** True when a person said how it was paid. */
  byPerson: boolean;
  /** The day the purchase counts on for tax. */
  taxDay: string;
  /** The collection that settles it (checkout purchases only). */
  collectionId: string | null;
  /** How the collection was found: the statement number or the purchase's number in its text, or the statement's sum. */
  matchedBy: 'statement' | 'reference' | 'amount' | null;
  /** A checkout purchase no collection was found for: it stays on its purchase day and is listed for a look. */
  dayUnknown: boolean;
}

/** Text as its words, lower case, separated and enclosed by single spaces: "AB-1234/x" is " ab 1234 x ". */
const spaced = (text: string) => ` ${text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean).join(' ')} `;
/** Whether a text names a number: its words appear one after the other, whatever punctuation stands between them. */
const names = (text: string, number: string) => spaced(number).trim() !== '' && text.includes(spaced(number));
const dayNumber = (day: string) => Math.round(Date.parse(`${day}T00:00:00Z`) / 86_400_000);
const byDay = <T extends { id: string; bookingDay: string }>(a: T, b: T) => (a.bookingDay === b.bookingDay ? (a.id < b.id ? -1 : 1) : a.bookingDay < b.bookingDay ? -1 : 1);

/** How a purchase was paid: a person's word, then what the list says, then a card text; null when nothing is known. */
function methodOf(purchase: TaxDayPurchase): PayLaterMethod | null {
  if (purchase.override) return purchase.override;
  if (purchase.detail) return classifyPayLater(purchase.detail, purchase.counterparty);
  return looksLikeCardText(purchase.counterparty) ? 'card' : null;
}

/**
 * For every purchase of one pay-later service, the day it counts on.
 * `purchases` are the rows of the service's own list that count (cancelled
 * ones left out): purchases, and money back booked on a statement, which
 * lowers what the service collects for it. `collections` are the debits the
 * funding rule recognizes as the service collecting from another account, and
 * the ones a person marked as such.
 *
 * How a checkout purchase finds its collection, in this order:
 * 1. a collection of exactly its amount whose text holds the purchase's own
 *    number (an invoice paid by transfer); a part payment naming it settles nothing;
 * 2. a collection whose text holds the purchase's statement number;
 * 3. the first collection from the statement's last open purchase up to
 *    `COLLECTION_DAYS_AFTER` days later whose amount is exactly what the
 *    statement's open purchases add up to, less money back on it (card and
 *    financed purchases of the statement included: the service collects the
 *    whole statement).
 * Each collection settles one statement (or one purchase by its number), and
 * a debit twinned with a direct-debit purchase settles none.
 * Statements are worked through in the order of their last purchase, so the
 * same data always pairs the same way.
 */
export function resolvePayLaterDays(rows: readonly TaxDayPurchase[], collections: readonly TaxDayCollection[]): Map<string, PayLaterDay> {
  const out = new Map<string, PayLaterDay>();
  const purchases = rows.filter((r) => r.amountCents < 0);
  const methods = new Map(purchases.map((p) => [p.id, methodOf(p)]));
  const ordered = collections
    .filter((c) => !c.twinId || methods.get(c.twinId) !== 'direct_debit')
    .sort(byDay);
  const texts = new Map(ordered.map((c) => [c.id, spaced(c.text)]));
  const used = new Set<string>();
  const settledBy = new Map<string, { collection: TaxDayCollection; by: 'statement' | 'reference' | 'amount' }>();

  // 1. A collection of exactly the purchase's amount naming its own number settles that purchase.
  for (const purchase of [...purchases].sort(byDay)) {
    const reference = purchase.detail?.reference;
    if (!reference) continue;
    const collection = ordered.find(
      (c) => !used.has(c.id) && c.bookingDay >= purchase.bookingDay && c.amountCents === purchase.amountCents && names(texts.get(c.id) ?? '', reference),
    );
    if (!collection) continue;
    used.add(collection.id);
    settledBy.set(purchase.id, { collection, by: 'reference' });
  }

  // The statements: the purchases not settled on their own, and money back booked on them.
  const statements = new Map<string, TaxDayPurchase[]>();
  for (const row of rows) {
    const statement = row.detail?.statement;
    if (!statement || settledBy.has(row.id)) continue;
    statements.set(statement, [...(statements.get(statement) ?? []), row]);
  }
  const lastDay = (list: readonly TaxDayPurchase[]) => list.reduce((day, p) => (p.amountCents < 0 && p.bookingDay > day ? p.bookingDay : day), '');
  const statementOrder = [...statements.entries()]
    .filter(([, list]) => list.some((p) => p.amountCents < 0))
    .sort(([a, la], [b, lb]) => (lastDay(la) === lastDay(lb) ? (a < b ? -1 : 1) : lastDay(la) < lastDay(lb) ? -1 : 1));

  // 2. A collection naming the statement settles all of it.
  const open: Array<[string, TaxDayPurchase[]]> = [];
  for (const [statement, list] of statementOrder) {
    const collection = ordered.find((c) => !used.has(c.id) && c.bookingDay >= lastDay(list) && names(texts.get(c.id) ?? '', statement));
    if (!collection) {
      open.push([statement, list]);
      continue;
    }
    used.add(collection.id);
    for (const purchase of list) settledBy.set(purchase.id, { collection, by: 'statement' });
  }

  // 3. Otherwise the first collection of exactly the statement's sum, soon after its last purchase.
  for (const [, list] of open) {
    const total = list.reduce((sum, p) => sum - p.amountCents, 0);
    const day = lastDay(list);
    const latest = dayNumber(day) + COLLECTION_DAYS_AFTER;
    const collection = ordered.find((c) => !used.has(c.id) && c.bookingDay >= day && dayNumber(c.bookingDay) <= latest && -c.amountCents === total);
    if (!collection) continue;
    used.add(collection.id);
    for (const purchase of list) settledBy.set(purchase.id, { collection, by: 'amount' });
  }

  for (const purchase of purchases) {
    const method = methods.get(purchase.id) ?? null;
    const base = { method, byPerson: purchase.override !== null, collectionId: null, matchedBy: null, dayUnknown: false } as const;
    if (method === 'direct_debit') {
      out.set(purchase.id, { ...base, taxDay: purchase.valueDay ?? purchase.bookingDay });
      continue;
    }
    if (method !== 'checkout') {
      out.set(purchase.id, { ...base, taxDay: purchase.bookingDay });
      continue;
    }
    const settled = settledBy.get(purchase.id);
    // A collection is never earlier than the purchase it settles (each match above asks for that).
    out.set(
      purchase.id,
      settled
        ? { ...base, taxDay: settled.collection.bookingDay, collectionId: settled.collection.id, matchedBy: settled.by }
        : { ...base, taxDay: purchase.bookingDay, dayUnknown: true },
    );
  }
  return out;
}
