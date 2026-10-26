/**
 * The merchant a payment's counterparty stands for (plan
 * docs/plans/2026-10-25-filed-year-decides-counterparties.md, decision 3). Pure.
 *
 * Card payments name their merchant in two ways that split one shop into many
 * counterparties: a merchant with an order code behind a star ("AMAZON*
 * KT2PC3H85", "eBay O*13-12787-68146"), and a card terminal provider in front
 * of the shop ("SumUp *Asia Markt", "Zettle_*honoki"). Both are cut down to the
 * merchant, so one answer covers every payment of the shop.
 *
 * PayPal and Klarna are left as they are on purpose: their name in the
 * counterparty is how the funding rule (`funding.ts`) recognizes a bank debit
 * that pays a purchase listed in the PayPal or Klarna file. Cutting it off
 * would count such a purchase twice.
 */

/** Merchants whose star is followed by an order or customer code: the part before the star is the merchant. */
const CODED: ReadonlyArray<{ pattern: RegExp; name: string }> = [
  { pattern: /^(amazon\s*prim[a-z]*|amznprime(\s+[a-z]{2})?)\s*\*/i, name: 'Amazon Prime' },
  { pattern: /^(amazon|amzn(\s+mktp)?(\s+[a-z]{2})?)\s*\*/i, name: 'Amazon' },
  { pattern: /^airbnb\s*\*/i, name: 'Airbnb' },
  { pattern: /^ebay\s+o\s*\*/i, name: 'eBay' },
  { pattern: /^lime\s*\*/i, name: 'Lime' },
  { pattern: /^revolut\s*\*+/i, name: 'Revolut' },
  { pattern: /^a2webhost\s*\*/i, name: 'A2 Hosting' },
  { pattern: /^mne\s*\*\s*\d+\s*moneynet/i, name: 'Moneynet' },
  { pattern: /^ubr\s*\*\s*pending\.uber\.com/i, name: 'Uber' },
];

/** Amazon's shop names without a star: one merchant with the coded ones above. */
const AMAZON_SHOP = /^(amazon|amzn\s+mktp(\s+[a-z]{2})?|www\.amazon\.[a-z.]+|amazon\.[a-z]{2,3})$/i;
const AMAZON_PRIME = /^(amazon\s*prime|amznprime(\s+[a-z]{2})?)$/i;

/** Card terminal and checkout providers in front of the shop's own name: the part after the star is the merchant. */
const PROVIDERS = /^(sumup|zettle_?|sq|spc|uzr|nyx|nya|edk|eb|ccv|fs|mol|psp)\s*\*+\s*(.+)$/i;

export function merchantName(label: string): string {
  const name = label.trim();
  for (const { pattern, name: merchant } of CODED) if (pattern.test(name)) return merchant;
  if (AMAZON_PRIME.test(name)) return 'Amazon Prime';
  if (AMAZON_SHOP.test(name)) return 'Amazon';
  const provider = PROVIDERS.exec(name);
  // Nothing usable after the provider ("SumUp *"): the provider's name stays.
  if (provider && /[a-z0-9]{2}/i.test(provider[2])) return provider[2].trim();
  return name;
}
