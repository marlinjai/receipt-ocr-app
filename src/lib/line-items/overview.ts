/**
 * "Was gekauft": what the money bought, from the receipts' lines (plan
 * docs/plans/2026-10-26-receipt-line-items.md, decision 6). Pure: the caller
 * loads the receipts and their lines, this sums them.
 *
 * The total of a period is the receipts' totals, never the lines' sum
 * (decision 4). What the lines do not explain (a receipt without lines, a
 * receipt whose lines miss its total) is shown as its own amount, "nicht
 * aufgeschlüsselt", so the kinds and that amount add up to the total and
 * nothing is hidden.
 *
 * Amounts are euro cents: a receipt in another currency counts at its stored
 * exchange rate (euros per unit), and one without a rate is left out and
 * counted, never taken as euros.
 */

import { KIND_CATEGORY, PURCHASE_KIND_LABELS, type PurchaseKind } from './kinds';
import { textKey } from './lines';
import { SPENDING_CATEGORY_LABELS, type SpendingCategory } from '@/lib/spending/categories';

export interface PurchaseLineInput {
  text: string;
  grossCents: number;
  quantity: number | null;
  /** The kind it counts under (a person's answer applied). */
  kind: PurchaseKind;
}

export interface PurchaseReceiptInput {
  rowId: string;
  /** ISO day of the receipt, or null. */
  date: string | null;
  vendor: string;
  /** The receipt's total in its currency, in cents; null when it has none. */
  grossCents: number | null;
  currency: string;
  /** Euros per unit of the currency; 1 for euros. */
  fxRate: number | null;
  /** Null when the receipt's lines were never read (or none were found). */
  lines: PurchaseLineInput[] | null;
}

export interface KindSum {
  kind: PurchaseKind;
  label: string;
  cents: number;
  lines: number;
}

export interface PurchasesOverview {
  year: number;
  month: number | null;
  /** The receipts' totals in the period, in euro cents. */
  totalCents: number;
  /** What their lines explain. */
  linesCents: number;
  /** Total minus lines: receipts without lines and the differences of the others. */
  unexplainedCents: number;
  receipts: number;
  receiptsWithLines: number;
  /** Receipts in another currency without an exchange rate: left out of every sum. */
  unconverted: number;
  kinds: KindSum[];
  categories: Array<{ category: SpendingCategory; label: string; cents: number }>;
  /** The items bought most often ("Hafermilch, 23 mal, 41,17 €"). */
  topItems: Array<{ text: string; count: number; cents: number; kind: PurchaseKind }>;
  /** Per shop, what was bought there. */
  shops: Array<{ vendor: string; cents: number; receipts: number; kinds: Array<{ kind: PurchaseKind; label: string; cents: number }> }>;
  /** Per month of a whole year: total and the largest kinds. Empty for a single month. */
  months: Array<{ month: number; totalCents: number; linesCents: number; kinds: Array<{ kind: PurchaseKind; label: string; cents: number }> }>;
}

const TOP_ITEMS = 15;
const TOP_SHOPS = 10;
const KINDS_PER_ROW = 3;

/** How many a line counts for: its quantity where that is a whole number, else one (a weight is one purchase). */
const countOf = (quantity: number | null) => (quantity !== null && Number.isInteger(quantity) && quantity >= 1 ? quantity : 1);

function topKinds(byKind: Map<PurchaseKind, number>, n = KINDS_PER_ROW) {
  return [...byKind.entries()]
    .filter(([, cents]) => cents !== 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([kind, cents]) => ({ kind, label: PURCHASE_KIND_LABELS[kind], cents }));
}

const add = <K>(map: Map<K, number>, key: K, cents: number) => map.set(key, (map.get(key) ?? 0) + cents);

export function buildPurchasesOverview(receipts: readonly PurchaseReceiptInput[], period: { year: number; month: number | null }): PurchasesOverview {
  const out: PurchasesOverview = {
    year: period.year,
    month: period.month,
    totalCents: 0,
    linesCents: 0,
    unexplainedCents: 0,
    receipts: 0,
    receiptsWithLines: 0,
    unconverted: 0,
    kinds: [],
    categories: [],
    topItems: [],
    shops: [],
    months: [],
  };
  const kinds = new Map<PurchaseKind, { cents: number; lines: number }>();
  const categories = new Map<SpendingCategory, number>();
  const items = new Map<string, { texts: Map<string, number>; count: number; cents: number; kinds: Map<PurchaseKind, number> }>();
  const shops = new Map<string, { vendor: string; cents: number; receipts: number; kinds: Map<PurchaseKind, number> }>();
  const months = new Map<number, { totalCents: number; linesCents: number; kinds: Map<PurchaseKind, number> }>();

  for (const r of receipts) {
    const day = r.date?.slice(0, 10) ?? '';
    const year = Number(day.slice(0, 4));
    const month = Number(day.slice(5, 7));
    if (year !== period.year || (period.month !== null && month !== period.month)) continue;
    const rate = r.currency === 'EUR' ? 1 : r.fxRate;
    if (rate === null || !(rate > 0)) {
      out.unconverted++;
      continue;
    }
    const euro = (cents: number) => Math.round(cents * rate);
    out.receipts++;
    const total = r.grossCents === null ? 0 : euro(r.grossCents);
    out.totalCents += total;
    const monthEntry = months.get(month) ?? { totalCents: 0, linesCents: 0, kinds: new Map() };
    monthEntry.totalCents += total;
    months.set(month, monthEntry);
    if (!r.lines || r.lines.length === 0) continue;
    out.receiptsWithLines++;
    // A deposit or a discount follows the receipt's main category: the one of its largest line that has one.
    const main = [...r.lines].filter((l) => KIND_CATEGORY[l.kind] !== null && l.grossCents > 0).sort((a, b) => b.grossCents - a.grossCents)[0];
    const mainCategory: SpendingCategory = main ? (KIND_CATEGORY[main.kind] as SpendingCategory) : 'unclear';
    const shopKey = r.vendor.trim().toLocaleLowerCase('de-DE') || '?';
    const shop = shops.get(shopKey) ?? { vendor: r.vendor.trim() || 'Ohne Händler', cents: 0, receipts: 0, kinds: new Map() };
    shop.receipts++;
    for (const l of r.lines) {
      const cents = euro(l.grossCents);
      out.linesCents += cents;
      monthEntry.linesCents += cents;
      add(monthEntry.kinds, l.kind, cents);
      const k = kinds.get(l.kind) ?? { cents: 0, lines: 0 };
      k.cents += cents;
      k.lines++;
      kinds.set(l.kind, k);
      add(categories, KIND_CATEGORY[l.kind] ?? mainCategory, cents);
      shop.cents += cents;
      add(shop.kinds, l.kind, cents);
      if (l.kind === 'deposit_discount') continue;
      const key = textKey(l.text);
      if (!key) continue;
      const item = items.get(key) ?? { texts: new Map(), count: 0, cents: 0, kinds: new Map() };
      add(item.texts, l.text, 1);
      item.count += countOf(l.quantity);
      item.cents += cents;
      add(item.kinds, l.kind, 1);
      items.set(key, item);
    }
    shops.set(shopKey, shop);
  }

  out.unexplainedCents = out.totalCents - out.linesCents;
  out.kinds = [...kinds.entries()]
    .filter(([, v]) => v.cents !== 0)
    .sort((a, b) => b[1].cents - a[1].cents)
    .map(([kind, v]) => ({ kind, label: PURCHASE_KIND_LABELS[kind], cents: v.cents, lines: v.lines }));
  out.categories = [...categories.entries()]
    .filter(([, cents]) => cents !== 0)
    .sort((a, b) => b[1] - a[1])
    .map(([category, cents]) => ({ category, label: SPENDING_CATEGORY_LABELS[category], cents }));
  const mostUsed = <K>(m: Map<K, number>): K => [...m.entries()].sort((a, b) => b[1] - a[1])[0][0];
  out.topItems = [...items.values()]
    .sort((a, b) => b.count - a.count || b.cents - a.cents)
    .slice(0, TOP_ITEMS)
    .map((i) => ({ text: mostUsed(i.texts), count: i.count, cents: i.cents, kind: mostUsed(i.kinds) }));
  out.shops = [...shops.values()]
    .sort((a, b) => b.cents - a.cents)
    .slice(0, TOP_SHOPS)
    .map((s) => ({ vendor: s.vendor, cents: s.cents, receipts: s.receipts, kinds: topKinds(s.kinds) }));
  if (period.month === null) {
    out.months = [...months.entries()].sort((a, b) => a[0] - b[0]).map(([month, m]) => ({ month, totalCents: m.totalCents, linesCents: m.linesCents, kinds: topKinds(m.kinds) }));
  }
  return out;
}
