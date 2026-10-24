import type { InvoiceRecord } from './aggregate';

/**
 * Pure selection/filter engine for the overview charts. Client-safe (no Node
 * builtins, no server imports): the page ships the normalized ledger to the
 * browser and every control re-filters + re-aggregates instantly.
 *
 * A SelectionDef combines:
 *  - a time frame: preset (1w/1m/3m/6m/ytd/1y/all) or a custom from→to range
 *  - living filters: vendors / currencies left out (excludeVendors /
 *    excludeCurrencies; everything else counts, so new imports join
 *    automatically). The older include lists (vendors / currencies, empty =
 *    all) still load from selections saved before.
 *  - frozen sets: includeIds (only these invoices) / excludeIds (all but these)
 * All parts AND together, so "all Anthropic in H1 minus these two refunds" is
 * one definition.
 */

/** An invoice as shipped to the overview client: aggregate fields + identity. */
/** The vendor shown for a receipt that names none. */
export const UNKNOWN_VENDOR = 'Ohne Händler';

/**
 * A stored date as the day it names ("2021-01-14" from "2021-01-14T00:00:00.000Z"), the way the rest of the
 * app reads receipt dates (by their leading YYYY-MM-DD). Null when the value holds no day.
 */
export function ledgerDay(value: string | null): string | null {
  if (!value) return null;
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(value);
  return match ? match[1] : null;
}

export interface LedgerInvoice extends InvoiceRecord {
  id: string;
  name: string | null;
}

export const TIME_PRESETS = ['1w', '1m', '3m', '6m', 'ytd', '1y', 'all'] as const;
export type TimePreset = (typeof TIME_PRESETS)[number] | 'custom';

export interface SelectionDef {
  preset?: TimePreset; // default 'all'
  from?: string; // ISO YYYY-MM-DD, used when preset === 'custom'
  to?: string;
  /** Older saved selections: only these vendors (empty = all). New selections use `excludeVendors`. */
  vendors?: string[];
  /** Older saved selections: only these currencies (empty = all). New selections use `excludeCurrencies`. */
  currencies?: string[];
  /** Vendors left out; every other vendor counts, including ones imported later. */
  excludeVendors?: string[];
  /** Currencies left out. */
  excludeCurrencies?: string[];
  includeIds?: string[];
  excludeIds?: string[];
}

const iso = (d: Date): string => d.toISOString().slice(0, 10);

/** Resolve a preset to an inclusive from-date (UTC), relative to `now`. */
export function presetFrom(preset: TimePreset, now: Date): string | null {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const d = now.getUTCDate();
  switch (preset) {
    case '1w':
      return iso(new Date(Date.UTC(y, m, d - 7)));
    case '1m':
      return iso(new Date(Date.UTC(y, m - 1, d)));
    case '3m':
      return iso(new Date(Date.UTC(y, m - 3, d)));
    case '6m':
      return iso(new Date(Date.UTC(y, m - 6, d)));
    case '1y':
      return iso(new Date(Date.UTC(y - 1, m, d)));
    case 'ytd':
      return iso(new Date(Date.UTC(y, 0, 1)));
    default:
      return null;
  }
}

/**
 * Apply a selection to the ledger. Invoices with no date drop out whenever a
 * date bound is active (they cannot be placed on a timeline).
 */
export function applySelection(
  invoices: LedgerInvoice[],
  def: SelectionDef,
  now: Date = new Date(),
): LedgerInvoice[] {
  const preset = def.preset ?? 'all';
  let from: string | null = null;
  let to: string | null = null;
  if (preset === 'custom') {
    from = def.from ?? null;
    to = def.to ?? null;
  } else {
    from = presetFrom(preset, now);
  }

  const vendors = def.vendors?.length ? new Set(def.vendors) : null;
  const currencies = def.currencies?.length ? new Set(def.currencies) : null;
  const vendorsOut = def.excludeVendors?.length ? new Set(def.excludeVendors) : null;
  const currenciesOut = def.excludeCurrencies?.length ? new Set(def.excludeCurrencies) : null;
  const include = def.includeIds?.length ? new Set(def.includeIds) : null;
  const exclude = def.excludeIds?.length ? new Set(def.excludeIds) : null;

  return invoices.filter((inv) => {
    if (include && !include.has(inv.id)) return false;
    if (exclude && exclude.has(inv.id)) return false;
    if ((from || to) && !inv.date) return false;
    if (from && inv.date! < from) return false;
    if (to && inv.date! > to) return false;
    if (vendors && !vendors.has(inv.vendor)) return false;
    if (currencies && !currencies.has(inv.currency)) return false;
    if (vendorsOut && vendorsOut.has(inv.vendor)) return false;
    if (currenciesOut && currenciesOut.has(inv.currency)) return false;
    return true;
  });
}

const strArray = (v: unknown): string[] | undefined => {
  if (!Array.isArray(v)) return undefined;
  const out = v.filter((x): x is string => typeof x === 'string' && x.length > 0);
  return out.length ? out : undefined;
};

const isoOrUndef = (v: unknown): string | undefined =>
  typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : undefined;

/** Sanitize an untrusted definition (API input / stored JSON) to a valid one. */
export function sanitizeSelectionDef(raw: unknown): SelectionDef {
  if (!raw || typeof raw !== 'object') return {};
  const r = raw as Record<string, unknown>;
  const preset =
    typeof r.preset === 'string' && ([...TIME_PRESETS, 'custom'] as string[]).includes(r.preset)
      ? (r.preset as TimePreset)
      : undefined;
  return {
    ...(preset ? { preset } : {}),
    ...(isoOrUndef(r.from) ? { from: isoOrUndef(r.from) } : {}),
    ...(isoOrUndef(r.to) ? { to: isoOrUndef(r.to) } : {}),
    ...(strArray(r.vendors) ? { vendors: strArray(r.vendors) } : {}),
    ...(strArray(r.currencies) ? { currencies: strArray(r.currencies) } : {}),
    ...(strArray(r.excludeVendors) ? { excludeVendors: strArray(r.excludeVendors) } : {}),
    ...(strArray(r.excludeCurrencies) ? { excludeCurrencies: strArray(r.excludeCurrencies) } : {}),
    ...(strArray(r.includeIds) ? { includeIds: strArray(r.includeIds) } : {}),
    ...(strArray(r.excludeIds) ? { excludeIds: strArray(r.excludeIds) } : {}),
  };
}
