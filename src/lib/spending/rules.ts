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
 *    always "transfers". It is not spending, whatever anyone said about the
 *    counterparty's category.
 * 2. A category a person gave this counterparty.
 * 3. A fee by its kind.
 * 4. Words in the counterparty's name or the payment's text: cash, loans and
 *    fees first (they are what the missing-receipt loop skips), then brand
 *    names. Only generic brand and trade words live here, never a person.
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

/** Word rules in the order they are tried. Phrases are matched as whole words of the normalized text. */
export const KEYWORD_RULES: ReadonlyArray<{ category: SpendingCategory; words: readonly string[] }> = [
  {
    category: 'cash',
    words: ['geldautomat', 'bargeld', 'bargeldauszahlung', 'bargeldabhebung', 'atm', 'cash withdrawal', 'auszahlung gaa'],
  },
  {
    category: 'loans_leasing_credit',
    words: ['darlehen', 'tilgung', 'kredit', 'kreditrate', 'ratenkredit', 'leasing', 'leasingrate', 'finanzierung', 'ratenzahlung'],
  },
  {
    category: 'fees_interest',
    words: ['entgelt', 'kontofuehrung', 'kontofuehrungsgebuehr', 'gebuehr', 'gebuehren', 'zinsen', 'sollzinsen', 'zins', 'kartengebuehr', 'jahresgebuehr', 'fee'],
  },
  {
    category: 'software_ai_hosting',
    words: [
      'github', 'openai', 'anthropic', 'claude ai', 'chatgpt', 'cursor', 'vercel', 'hetzner', 'cloudflare', 'google cloud',
      'google workspace', 'gsuite', 'notion', 'figma', 'adobe', 'microsoft', 'amazon web services', 'aws', 'digitalocean',
      'netlify', 'jetbrains', 'atlassian', 'slack', 'zoom', 'dropbox', 'icloud', 'midjourney', 'elevenlabs', 'webflow',
      'framer', 'namecheap', 'ionos', 'strato', 'porkbun', 'godaddy', '1password', 'canva', 'replicate', 'supabase',
    ],
  },
  {
    category: 'eating_out_coffee',
    words: [
      'restaurant', 'ristorante', 'trattoria', 'cafe', 'caffe', 'coffee', 'kaffee', 'starbucks', 'mcdonalds', 'burger king',
      'kfc', 'subway', 'lieferando', 'wolt', 'uber eats', 'deliveroo', 'pizzeria', 'pizza', 'baeckerei', 'backhaus',
      'sushi', 'doener', 'imbiss', 'kantine', 'bistro',
    ],
  },
  {
    category: 'transport',
    words: [
      'deutsche bahn', 'db vertrieb', 'db fernverkehr', 'db bahn', 'bahn', 'bvg', 'mvg', 'hvv', 'rmv', 'vbb', 'kvb',
      'flixbus', 'flixtrain', 'uber', 'bolt', 'freenow', 'free now', 'tier', 'lime', 'voi', 'miles', 'share now', 'sixt',
      'shell', 'aral', 'esso', 'totalenergies', 'jet tankstelle', 'tankstelle', 'lufthansa', 'ryanair', 'eurowings',
      'easyjet', 'condor', 'parkhaus', 'parken', 'adac',
    ],
  },
  {
    category: 'groceries_drugstore',
    words: [
      'rewe', 'edeka', 'aldi', 'lidl', 'netto', 'penny', 'kaufland', 'dm', 'dm drogerie', 'rossmann', 'mueller', 'budni',
      'denns', 'alnatura', 'bio company', 'tegut', 'globus', 'flink', 'picnic', 'knuspr', 'supermarkt',
    ],
  },
  {
    category: 'leisure_sport',
    words: [
      'netflix', 'spotify', 'disney', 'audible', 'youtube premium', 'apple music', 'playstation', 'steam', 'nintendo',
      'urban sports', 'urbansportsclub', 'mcfit', 'fitness', 'gym', 'kino', 'cinema', 'eventim', 'ticketmaster', 'theater',
      'museum',
    ],
  },
  {
    category: 'housing_utilities',
    words: [
      'miete', 'kaltmiete', 'warmmiete', 'nebenkosten', 'hausverwaltung', 'stadtwerke', 'vattenfall', 'eon', 'e on', 'enbw',
      'strom', 'gas', 'wasser', 'telekom', 'vodafone', 'o2', 'telefonica', '1und1', '1 1', 'congstar', 'rundfunkbeitrag',
      'beitragsservice',
    ],
  },
  {
    category: 'shopping_household',
    words: [
      'amazon', 'amzn', 'otto', 'zalando', 'ikea', 'mediamarkt', 'media markt', 'saturn', 'obi', 'hornbach', 'bauhaus',
      'toom', 'tchibo', 'primark', 'decathlon', 'ebay', 'etsy', 'temu', 'shein', 'about you', 'galaxus', 'apple store',
    ],
  },
];

/** Lower case words separated by single spaces, the way `vendorKey` writes them; empty when nothing is left. */
export function normalizeText(text: string): string {
  return vendorKey(text) ?? '';
}

const hasPhrase = (text: string, phrase: string) => text.length > 0 && ` ${text} `.includes(` ${phrase} `);

/** The first keyword rule whose words appear in the counterparty or the text, or null. */
export function keywordCategory(counterpartyKey: string, reference: string): SpendingCategory | null {
  const name = counterpartyKey;
  const text = normalizeText(reference);
  for (const rule of KEYWORD_RULES) {
    if (rule.words.some((w) => hasPhrase(name, w) || hasPhrase(text, w))) return rule.category;
  }
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
 * How a payment counts as spending, in cents: money out is positive, money
 * back (a refund) negative and lowers its category. Income and moving money
 * between own accounts are not spending: null.
 */
export function spendingCents(payment: { kind: PaymentKind; amountCents: number }): number | null {
  if (payment.kind === 'income' || payment.kind === 'own_transfer') return null;
  return -payment.amountCents;
}
