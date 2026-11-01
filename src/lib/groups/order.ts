import type { Column, Row } from '@marlinjai/data-table-core';
import { GROUP_POSITION_COLUMN } from '@/lib/receipts-kind';

/**
 * The order of the receipts inside a group. The list reads rows in its own
 * order (newest first), so the places are applied here, among the rows of one
 * group; every other row stays where it is. No server-only import: the
 * dashboard uses this in the browser.
 */

/** A group's order as just placed, shown until the rows have been loaded again. */
export interface PlacedOrder {
  groupId: string;
  order: readonly string[];
}

/**
 * `current` with the rows of `wanted` in that order, in the places they held:
 * a row `wanted` does not name (a filter hid it) stays where it was.
 */
export function orderWithin(current: readonly string[], wanted: readonly string[]): string[] {
  const present = new Set(current);
  const queue = wanted.filter((id) => present.has(id));
  const named = new Set(queue);
  let next = 0;
  return current.map((id) => (named.has(id) ? queue[next++] : id));
}

/** The rows with each group's receipts by their place. Those without one follow, in the order they came. */
export function inGroupOrder<T extends Pick<Row, 'id' | 'cells' | 'parentRowId'>>(
  rows: readonly T[],
  columns: readonly Pick<Column, 'id' | 'name'>[],
  placed: PlacedOrder | null = null,
): T[] {
  const positionId = columns.find((c) => c.name === GROUP_POSITION_COLUMN)?.id;
  const slots = new Map<string, number[]>();
  rows.forEach((row, index) => {
    if (!row.parentRowId) return;
    const held = slots.get(row.parentRowId);
    if (held) held.push(index);
    else slots.set(row.parentRowId, [index]);
  });
  const placeOf = (row: T) => {
    const at = placed && placed.groupId === row.parentRowId ? placed.order.indexOf(row.id) : -1;
    if (at !== -1) return at;
    const stored = positionId ? row.cells[positionId] : null;
    const place = stored === null || stored === undefined || stored === '' ? NaN : Number(stored);
    return Number.isNaN(place) ? Infinity : place;
  };
  const out = [...rows];
  for (const indexes of slots.values()) {
    const sorted = indexes.map((i) => rows[i]).sort((a, b) => {
      const [x, y] = [placeOf(a), placeOf(b)];
      return x === y ? 0 : x - y;
    });
    indexes.forEach((slot, i) => {
      out[slot] = sorted[i];
    });
  }
  return out;
}
