/** Reading what a person types into the payment search. Pure. */

/**
 * A search text read as an amount ("45,10", "45.10", "1.234,56", "1234.56",
 * "12"), in cents; null when it is no amount.
 */
export function amountQuery(text: string): number | null {
  // Copied from a statement an amount may carry a sign and the currency: "-45,10 EUR".
  const t = text.toLowerCase().replace(/\s|€|eur/g, '').replace(/^[-+]/, '');
  let euros: string;
  if (/^\d{1,3}(\.\d{3})+(,\d{1,2})?$/.test(t)) euros = t.replace(/\./g, '').replace(',', '.');
  else if (/^\d{1,3}(,\d{3})+(\.\d{1,2})?$/.test(t)) euros = t.replace(/,/g, '');
  else if (/^\d+([.,]\d{1,2})?$/.test(t)) euros = t.replace(',', '.');
  else return null;
  const cents = Math.round(Number(euros) * 100);
  return Number.isFinite(cents) && cents > 0 ? cents : null;
}
