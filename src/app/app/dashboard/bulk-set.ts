/**
 * "Set field" on a selection of receipts: what one call may carry, what came
 * of each row, and how the dashboard says it. No server-only import: the bar
 * in the browser and the server action share these.
 *
 * On 2026-10-11, setting the assignment on selections of 30 rows reported
 * success while 14 of the 81 rows set that way kept their old value (selections
 * of 7 went through); the bar wrote cell by cell through the table and counted
 * every answer as done. Now the server writes a part of the selection one row after
 * another, reads the column back afterwards and calls a row done only when the
 * stored value is the one asked for. Nothing that did not land is counted.
 */

/**
 * The most rows one server call writes; a larger selection goes in parts of this size. The table adapter
 * looks a row up across every table of the database, twice per write, so a part is kept small: it stays well
 * inside a request's time (a part that runs out of it counts as unanswered and can be tried again), and the
 * bar can say how far it got.
 */
export const BULK_SET_PART = 25;

/** Why a row was not set. */
export type BulkSetFailure =
  /** The row is gone, or belongs to another table. */
  | 'not_found'
  /** The row takes no value in this column (a group, or the column is not one the bar sets). */
  | 'not_writable'
  /** The value is no option of the column (any more). */
  | 'invalid_value'
  /** The write answered, but the stored value read afterwards is not the one asked for. */
  | 'not_stored'
  /** The write failed. */
  | 'failed'
  /** The part this row was in got no answer: whether it was stored is not known. */
  | 'unconfirmed';

export interface BulkSetOutcome {
  /** Rows whose stored value is now the value asked for, read back after the writes (or already before). */
  done: string[];
  failed: Array<{ rowId: string; reason: BulkSetFailure }>;
  /** Rows the call did not touch because its time budget ran out: sent again, as they are. None when absent. */
  left?: string[];
}

/**
 * How long one call writes row after row before it hands back the rest. Well inside any request limit on the
 * way (a part that got no answer on production on 2026-10-16 is why there is one).
 */
export const BULK_SET_BUDGET_MS = 8_000;

/** The selection in parts of at most `size`, each row once, in its order. */
export function partsOf(rowIds: readonly string[], size = BULK_SET_PART): string[][] {
  const ids = [...new Set(rowIds)];
  const parts: string[][] = [];
  for (let i = 0; i < ids.length; i += size) parts.push(ids.slice(i, i + size));
  return parts;
}

/** The outcomes of several parts as one. */
export function joinOutcomes(outcomes: readonly BulkSetOutcome[]): BulkSetOutcome {
  return { done: outcomes.flatMap((o) => o.done), failed: outcomes.flatMap((o) => o.failed), left: outcomes.flatMap((o) => o.left ?? []) };
}

/** A part that got no answer: none of its rows is counted as set. */
export function unconfirmed(rowIds: readonly string[]): BulkSetOutcome {
  return { done: [], failed: rowIds.map((rowId) => ({ rowId, reason: 'unconfirmed' as const })), left: [] };
}

/** Whether a stored cell holds the value asked for. A cleared cell is stored empty or not at all. */
export function storedAs(stored: unknown, wanted: string | null): boolean {
  const empty = stored === null || stored === undefined || stored === '';
  return wanted === null ? empty : stored === wanted;
}

const REASON: Record<BulkSetFailure, string> = {
  not_found: 'nicht gefunden',
  not_writable: 'nimmt dieses Feld nicht',
  invalid_value: 'Wert gibt es nicht mehr',
  not_stored: 'nicht gespeichert',
  failed: 'Fehler beim Speichern',
  unconfirmed: 'keine Antwort, Stand unklar',
};

/** What the bar says after a run: how many of how many were set, and why the others were not. */
export function outcomeWording(outcome: BulkSetOutcome, asked: number): string {
  const set = `${outcome.done.length} von ${asked} gesetzt.`;
  if (outcome.failed.length === 0) return set;
  const counts = new Map<BulkSetFailure, number>();
  for (const { reason } of outcome.failed) counts.set(reason, (counts.get(reason) ?? 0) + 1);
  const reasons = [...counts].map(([reason, n]) => `${n} ${REASON[reason]}`).join(', ');
  return `${set} ${outcome.failed.length} nicht gesetzt: ${reasons}.`;
}
