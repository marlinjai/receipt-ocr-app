/**
 * The check marks of a list with batch actions, as pure functions.
 *
 * The selection is a set of row ids. The list it belongs to changes under it
 * (an entry is saved, deleted, or taken out of the register), so every reader
 * goes through `pruneSelection` first: an entry that left the list can never
 * stay selected and be hit by the next batch action.
 */

export type SelectAllState = 'none' | 'some' | 'all';

/** Check or uncheck one entry. */
export function toggleSelected(selected: ReadonlySet<string>, id: string): Set<string> {
  const next = new Set(selected);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

/** The selection limited to the ids that are still in the list, in list order. */
export function pruneSelection(selected: ReadonlySet<string>, ids: readonly string[]): Set<string> {
  return new Set(ids.filter((id) => selected.has(id)));
}

/** Where the "select all" box stands for this list. */
export function selectAllState(selected: ReadonlySet<string>, ids: readonly string[]): SelectAllState {
  const count = pruneSelection(selected, ids).size;
  if (count === 0) return 'none';
  return count === ids.length ? 'all' : 'some';
}

/** "Select all": everything when not everything is selected yet, nothing otherwise. */
export function toggleAll(selected: ReadonlySet<string>, ids: readonly string[]): Set<string> {
  return selectAllState(selected, ids) === 'all' ? new Set() : new Set(ids);
}
