import { vendorKey } from '@/lib/tax/decisions';
import type { PaymentKind } from '@/lib/tax/payments/types';
import type { SpendingCategory } from './categories';

/**
 * Which spending category a payment belongs to, and whether it is private or
 * business. Pure.
 *
 * The order is fixed, first hit wins:
 *
 * 1. Moving money between the owner's own accounts (the counterparty was
 *    answered as an own account, or the payment's kind is a transfer) is
 *    always "transfers" and never counted as spending, whatever anyone said
 *    about the counterparty's category.
 * 2. A category a person gave this counterparty.
 * 3. A fee by its kind.
 * 4. Words: cash, loans and fees first, in the name or the text (they are what
 *    the missing-receipt loop skips); then brand and trade words, in the
 *    counterparty's name first and only then in the payment's text, so the
 *    name "vodafone" wins over the word "Gebühr" in its text. Only generic
 *    brand and trade words live here, never a person; a word that is also a
 *    common surname or an ordinary invoice word is matched in the name only.
 * 5. Otherwise "unclear", shown as such until a person answers.
 */

export type CounterpartyTreatmentAnswer = 'business' | 'private' | 'own_account';

export interface CategorisablePayment {
  kind: PaymentKind;
  counterpartyKey: string;
  reference: string;
}

export type CategoryBasis =
  /** The counterparty is an own account, or the payment's kind is a transfer between own accounts. */
  | 'own_account'
  /** A person gave the counterparty this category. */
  | 'answer'
  /** The payment's kind says it (a fee). */
  | 'kind'
  /** A word in the name or text matched a rule. */
  | 'keyword'
  /** Nothing said anything. */
  | 'none';

export interface Categorised {
  category: SpendingCategory;
  basis: CategoryBasis;
}

export interface KeywordRule {
  category: SpendingCategory;
  /** Matched as whole words in the counterparty's name and in the payment's text. */
  words: readonly string[];
  /** Matched in the counterparty's name only: short brands that are also surnames or ordinary words. */
  nameOnly?: readonly string[];
}

/** Rules for money that needs no receipt. Tried first, in the name or the text. */
export const PRIORITY_RULES: readonly KeywordRule[] = [
  {
    category: 'cash',
    words: ['geldautomat', 'bargeld', 'bargeldauszahlung', 'bargeldabhebung', 'cash withdrawal', 'auszahlung gaa'],
    nameOnly: ['atm'],
  },
  {
    category: 'loans_leasing_credit',
    words: ['darlehen', 'tilgung', 'kredit', 'kreditrate', 'ratenkredit', 'leasing', 'leasingrate', 'finanzierung', 'ratenzahlung'],
  },
  {
    category: 'fees_interest',
    words: ['entgelt', 'kontofuehrung', 'kontofuehrungsgebuehr', 'gebuehr', 'gebuehren', 'zinsen', 'sollzinsen', 'kartengebuehr', 'jahresgebuehr'],
  },
];

/** Brand and trade words. The counterparty's name is tried against all of them before the text is. */
export const BRAND_RULES: readonly KeywordRule[] = [
  {
    category: 'software_ai_hosting',
    words: [
      'github', 'openai', 'anthropic', 'chatgpt', 'vercel', 'hetzner', 'cloudflare', 'google cloud', 'google workspace',
      'gsuite', 'figma', 'adobe', 'microsoft', 'amazon web services', 'digitalocean', 'netlify', 'jetbrains', 'atlassian',
      'dropbox', 'icloud', 'midjourney', 'elevenlabs', 'webflow', 'namecheap', 'ionos', 'strato', 'porkbun', 'godaddy',
      '1password', 'canva', 'supabase',
    ],
    nameOnly: ['cursor', 'notion', 'slack', 'zoom', 'aws', 'framer', 'replicate'],
  },
  {
    category: 'eating_out_coffee',
    words: [
      'restaurant', 'ristorante', 'trattoria', 'cafe', 'caffe', 'coffee', 'starbucks', 'mcdonalds', 'burger king',
      'lieferando', 'uber eats', 'deliveroo', 'pizzeria', 'baeckerei', 'sushi', 'doener', 'imbiss', 'kantine', 'bistro',
    ],
    nameOnly: ['kfc', 'subway', 'wolt', 'kaffee', 'pizza', 'backhaus'],
  },
  {
    category: 'transport',
    words: [
      'deutsche bahn', 'db vertrieb', 'db fernverkehr', 'flixbus', 'flixtrain', 'freenow', 'free now', 'share now',
      'totalenergies', 'tankstelle', 'lufthansa', 'ryanair', 'eurowings', 'easyjet', 'parkhaus',
    ],
    nameOnly: ['bahn', 'bvg', 'mvg', 'hvv', 'rmv', 'vbb', 'kvb', 'uber', 'bolt', 'tier', 'lime', 'voi', 'miles', 'sixt', 'shell', 'aral', 'esso', 'condor', 'adac'],
  },
  {
    category: 'groceries_drugstore',
    words: ['rewe', 'edeka', 'aldi', 'lidl', 'kaufland', 'rossmann', 'dm drogerie', 'mueller drogerie', 'drogerie mueller', 'alnatura', 'bio company', 'supermarkt'],
    nameOnly: ['netto', 'penny', 'dm', 'budni', 'denns', 'tegut', 'globus', 'flink', 'picnic', 'knuspr'],
  },
  {
    category: 'leisure_sport',
    words: ['netflix', 'spotify', 'audible', 'youtube premium', 'apple music', 'playstation', 'nintendo', 'urban sports', 'urbansportsclub', 'mcfit', 'eventim', 'ticketmaster'],
    nameOnly: ['disney', 'steam', 'fitness', 'gym', 'kino', 'cinema', 'theater', 'museum'],
  },
  {
    category: 'housing_utilities',
    words: ['miete', 'kaltmiete', 'warmmiete', 'nebenkosten', 'hausverwaltung', 'stadtwerke', 'vattenfall', 'telekom', 'vodafone', 'telefonica', 'congstar', 'rundfunkbeitrag', 'beitragsservice'],
    nameOnly: ['eon', 'enbw', 'o2', '1und1'],
  },
  {
    category: 'shopping_household',
    words: ['amazon', 'amzn', 'zalando', 'ikea', 'mediamarkt', 'media markt', 'hornbach', 'tchibo', 'primark', 'decathlon', 'ebay', 'etsy', 'temu', 'shein', 'about you', 'galaxus', 'apple store'],
    nameOnly: ['otto', 'saturn', 'obi', 'bauhaus', 'toom'],
  },
];

/** Every rule, for checks over the whole table. */
export const KEYWORD_RULES: readonly KeywordRule[] = [...PRIORITY_RULES, ...BRAND_RULES];

/** Lower case words separated by single spaces, the way `vendorKey` writes them; empty when nothing is left. */
export function normalizeText(text: string): string {
  return vendorKey(text) ?? '';
}

const hasPhrase = (text: string, phrase: string) => text.length > 0 && ` ${text} `.includes(` ${phrase} `);
const inName = (rule: KeywordRule, name: string) => [...rule.words, ...(rule.nameOnly ?? [])].some((w) => hasPhrase(name, w));
const inText = (rule: KeywordRule, text: string) => rule.words.some((w) => hasPhrase(text, w));

/** The category the words say, or null (see the order at the top of this file). */
export function keywordCategory(counterpartyKey: string, reference: string): SpendingCategory | null {
  const name = counterpartyKey;
  const text = normalizeText(reference);
  for (const rule of PRIORITY_RULES) if (inName(rule, name) || inText(rule, text)) return rule.category;
  for (const rule of BRAND_RULES) if (inName(rule, name)) return rule.category;
  for (const rule of BRAND_RULES) if (inText(rule, text)) return rule.category;
  return null;
}

export function categorise(
  payment: CategorisablePayment,
  context: { treatment?: CounterpartyTreatmentAnswer; answer?: SpendingCategory } = {},
): Categorised {
  if (context.treatment === 'own_account' || payment.kind === 'own_transfer') return { category: 'transfers', basis: 'own_account' };
  if (context.answer) return { category: context.answer, basis: 'answer' };
  if (payment.kind === 'fee') return { category: 'fees_interest', basis: 'kind' };
  const byWord = keywordCategory(payment.counterpartyKey, payment.reference);
  if (byWord) return { category: byWord, basis: 'keyword' };
  return { category: 'unclear', basis: 'none' };
}

export type SpendingPurpose = 'private' | 'business' | 'unanswered';

/**
 * Private or business, from what was said: a payment a person marked private,
 * or a counterparty answered as private, is private; a counterparty answered
 * as business is business. Nothing else decides it, in particular not the
 * company the payments were imported under: one bank account carries both.
 */
export function purposeOf(payment: { kind: PaymentKind }, treatment: CounterpartyTreatmentAnswer | undefined): SpendingPurpose {
  if (payment.kind === 'private' || treatment === 'private') return 'private';
  if (treatment === 'business') return 'business';
  return 'unanswered';
}

/**
 * How a payment counts as spending, in cents: money out is positive; money
 * back for a purchase (a refund) is negative and lowers its category. Any
 * other money coming in (income, or a payment in that a person marked
 * private, such as money paid back by a friend) and moving money between own
 * accounts are not spending: null.
 */
export function spendingCents(payment: { kind: PaymentKind; amountCents: number }): number | null {
  if (payment.kind === 'income' || payment.kind === 'own_transfer') return null;
  if (payment.kind === 'refund') return -payment.amountCents;
  return payment.amountCents < 0 ? -payment.amountCents : null;
}
