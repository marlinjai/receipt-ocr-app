/**
 * The kinds of purchase a receipt's line can have (plan
 * docs/plans/2026-10-26-receipt-line-items.md, decision 3). Finer than the
 * twelve spending categories (src/lib/spending/categories.ts) and mapped into
 * them, so "Lebensmittel und Drogerie" can say how much of it was coffee and
 * how much was beer. The list is data: the model is given these keys, a person
 * chooses from these labels.
 */

import type { SpendingCategory } from '@/lib/spending/categories';

export const PURCHASE_KINDS = [
  'groceries',
  'soft_drinks',
  'alcohol',
  'coffee_tea',
  'sweets_snacks',
  'drugstore',
  'household',
  'meal_out',
  'drink_out',
  'alcohol_out',
  'deposit_discount',
  'shipping',
  'software_services',
  'electronics',
  'clothing',
  'other',
] as const;

export type PurchaseKind = (typeof PURCHASE_KINDS)[number];

export const PURCHASE_KIND_LABELS: Record<PurchaseKind, string> = {
  groceries: 'Lebensmittel',
  soft_drinks: 'Getränke ohne Alkohol',
  alcohol: 'Alkohol',
  coffee_tea: 'Kaffee und Tee',
  sweets_snacks: 'Süßes und Snacks',
  drugstore: 'Drogerie und Hygiene',
  household: 'Haushalt',
  meal_out: 'Essen auswärts',
  drink_out: 'Getränk im Café oder in der Bar',
  alcohol_out: 'Alkohol auswärts',
  deposit_discount: 'Pfand und Rabatt',
  shipping: 'Versand',
  software_services: 'Software und Dienste',
  electronics: 'Geräte und Elektronik',
  clothing: 'Kleidung',
  other: 'Sonstiges',
};

/**
 * What each kind is, for the model: one line per key, so it can tell coffee
 * beans (bought) from a cappuccino (drunk in the café).
 */
export const PURCHASE_KIND_HINTS: Record<PurchaseKind, string> = {
  groceries: 'food bought to eat at home: bread, milk, oat milk, vegetables, meat, cheese, frozen food',
  soft_drinks: 'drinks without alcohol bought to take home: water, juice, soda, oat drink sold as a drink',
  alcohol: 'drinks with alcohol bought to take home: beer, wine, spirits',
  coffee_tea: 'coffee beans, ground coffee, capsules, tea bought to make at home',
  sweets_snacks: 'chocolate, sweets, crisps, biscuits, ice cream bought in a shop',
  drugstore: 'hygiene, cosmetics, medicine, toilet paper, cleaning of the body',
  household: 'cleaning products, kitchen goods, bags, batteries, plants, small household items',
  meal_out: 'food eaten in a restaurant, café, canteen, snack bar or bought there to take away',
  drink_out: 'coffee, tea, a soft drink or water served in a café, bar, restaurant or bakery',
  alcohol_out: 'beer, wine or a cocktail served in a bar or restaurant',
  deposit_discount: 'a deposit ("Pfand"), a returned deposit ("Leergut", "Pfandrückgabe"), a discount, coupon or rounding',
  shipping: 'shipping, delivery or postage',
  software_services: 'software, subscriptions, hosting, cloud, a service or a fee',
  electronics: 'devices, cables, storage, computer parts, phones',
  clothing: 'clothes and shoes',
  other: 'anything else',
};

/**
 * The spending category each kind belongs to. A deposit or a discount has no
 * category of its own: it follows the receipt it is printed on (null), so the
 * returned bottles of a supermarket receipt lower "Lebensmittel und Drogerie".
 */
export const KIND_CATEGORY: Record<PurchaseKind, SpendingCategory | null> = {
  groceries: 'groceries_drugstore',
  soft_drinks: 'groceries_drugstore',
  alcohol: 'groceries_drugstore',
  coffee_tea: 'groceries_drugstore',
  sweets_snacks: 'groceries_drugstore',
  drugstore: 'groceries_drugstore',
  household: 'shopping_household',
  meal_out: 'eating_out_coffee',
  drink_out: 'eating_out_coffee',
  alcohol_out: 'eating_out_coffee',
  deposit_discount: null,
  shipping: 'shopping_household',
  software_services: 'software_ai_hosting',
  electronics: 'shopping_household',
  clothing: 'shopping_household',
  other: 'unclear',
};

export function isPurchaseKind(value: unknown): value is PurchaseKind {
  return typeof value === 'string' && (PURCHASE_KINDS as readonly string[]).includes(value);
}
