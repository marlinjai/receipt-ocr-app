import { type YearSelection } from '@/lib/receipt-years';

/**
 * The years the list asks the server for. The table package fetches its rows
 * through the adapter with a query it builds itself, so the scope is held
 * here, outside the component tree, and the adapter adds it to every list
 * query. Null: every receipt.
 */
let scope: number[] | null = null;

export function setYearScope(years: number[] | null): void {
  // Only the browser asks for lists through this store; a render on the server must not set a process-wide value.
  if (typeof window === 'undefined') return;
  scope = years;
}

export function getYearScope(): number[] | null {
  return scope;
}

/**
 * The scope a choice of years means. Receipts without a date can only be had
 * with everything, so choosing them (or nothing) loads every receipt.
 */
export function scopeOf(selection: YearSelection): number[] | null {
  if (selection.undated || selection.years.size === 0) return null;
  return [...selection.years].sort((a, b) => a - b);
}
