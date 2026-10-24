/**
 * Which vendor chips the spend overview shows. A company with a few years of receipts has dozens of
 * vendors; drawn all at once their chips filled several phone screens before the first chart. The overview
 * shows the vendors with the largest amounts first and folds the rest away, without ever hiding a choice:
 * a vendor that is switched off is always shown, so what the figures leave out stays visible.
 *
 * Folding changes only what is drawn. Which vendors count is decided by the switched-off set alone, so the
 * selection, a saved selection and its reset behave exactly as with every chip drawn.
 */

export interface VendorChipsInput {
  /** Every vendor of the ledger, largest amount first. */
  ranked: readonly string[];
  /** The vendors switched off (left out of the figures). */
  off: ReadonlySet<string>;
  /** How many chips show while folded. */
  limit: number;
  /** True when the person unfolded the list. */
  expanded: boolean;
  /** What the person typed into the search of the unfolded list. */
  query: string;
}

export interface VendorChips {
  /** The chips to draw, in ranked order. */
  shown: string[];
  /** How many vendors the folded list leaves out (0 when nothing is folded away). */
  folded: number;
  /** True when there are more vendors than the folded list shows, so folding is offered at all. */
  foldable: boolean;
}

/** Vendors ordered by their amount, largest first; equal amounts by name, so the order is stable. */
export function rankVendors(totals: ReadonlyArray<{ vendor: string; amount: number }>, all: readonly string[]): string[] {
  const amount = new Map(totals.map((t) => [t.vendor, t.amount]));
  return [...all].sort((a, b) => (amount.get(b) ?? 0) - (amount.get(a) ?? 0) || a.localeCompare(b, 'de'));
}

export function vendorChips({ ranked, off, limit, expanded, query }: VendorChipsInput): VendorChips {
  const foldable = ranked.length > limit;
  if (!foldable) return { shown: [...ranked], folded: 0, foldable };
  if (expanded) {
    const q = query.trim().toLocaleLowerCase('de');
    // The search narrows the unfolded list; a switched-off vendor stays in it, so it can be switched back on.
    const shown = q ? ranked.filter((v) => off.has(v) || v.toLocaleLowerCase('de').includes(q)) : [...ranked];
    return { shown, folded: 0, foldable };
  }
  const top = new Set(ranked.slice(0, limit));
  const shown = ranked.filter((v) => top.has(v) || off.has(v));
  return { shown, folded: ranked.length - shown.length, foldable };
}
