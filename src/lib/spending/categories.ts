/**
 * The twelve spending categories the owner decided on (plan
 * docs/plans/2026-10-14-personal-spending-and-bank-feed.md, decision 4). They
 * are the categories of the spending ledger he kept by hand, so a month in the
 * app reads like a month of that ledger.
 */

export const SPENDING_CATEGORIES = [
  'software_ai_hosting',
  'transport',
  'groceries_drugstore',
  'eating_out_coffee',
  'shopping_household',
  'housing_utilities',
  'loans_leasing_credit',
  'leisure_sport',
  'fees_interest',
  'transfers',
  'cash',
  'unclear',
] as const;

export type SpendingCategory = (typeof SPENDING_CATEGORIES)[number];

export const SPENDING_CATEGORY_LABELS: Record<SpendingCategory, string> = {
  software_ai_hosting: 'Software, KI und Hosting',
  transport: 'Mobilität',
  groceries_drugstore: 'Lebensmittel und Drogerie',
  eating_out_coffee: 'Essen gehen und Kaffee',
  shopping_household: 'Einkauf und Haushalt',
  housing_utilities: 'Wohnen und Nebenkosten',
  loans_leasing_credit: 'Kredite, Leasing und Raten',
  leisure_sport: 'Freizeit und Sport',
  fees_interest: 'Gebühren und Zinsen',
  transfers: 'Überweisungen an Personen',
  cash: 'Bargeld',
  unclear: 'Unklar',
};

/** The categories a person may answer with: all but "unclear", which is what no answer means. */
export const ANSWERABLE_CATEGORIES: readonly SpendingCategory[] = SPENDING_CATEGORIES.filter((c) => c !== 'unclear');

export function isSpendingCategory(value: unknown): value is SpendingCategory {
  return typeof value === 'string' && (SPENDING_CATEGORIES as readonly string[]).includes(value);
}
