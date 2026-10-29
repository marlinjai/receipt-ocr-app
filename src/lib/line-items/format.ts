/** How a receipt's lines are worded on the pages. Pure. */

import { formatCents } from '@/lib/tax/money';
import type { LinesCheck } from './lines';

/** An amount in the receipt's currency, the German way. */
export function money(cents: number, currency: string): string {
  return `${formatCents(cents)} ${currency === 'EUR' ? '€' : currency}`;
}

/** The sentence a receipt shows when its lines do not add up (plan decision 4): "Positionen ergeben 41,20 €, Beleg 42,10 €". */
export function differenceText(check: LinesCheck, currency: string): string {
  return check.basis === 'net'
    ? `Positionen ergeben netto ${money(check.sumCents, currency)}, Rechnung netto ${money(check.totalCents, currency)}`
    : `Positionen ergeben ${money(check.sumCents, currency)}, Beleg ${money(check.totalCents, currency)}`;
}
