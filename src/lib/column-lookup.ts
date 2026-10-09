/**
 * Resolving a table column by its name.
 *
 * A Receipts table is meant to hold each column name once. If it ever holds
 * one twice, every reader and every writer must still agree on which column
 * answers for the name: a save that writes "Occasion" into one column and a
 * read that takes it from the other loses the value while reporting success.
 * The rule is the same everywhere: the column that comes first wins. The
 * adapter lists columns by position, so that is the oldest one.
 */

/** Columns keyed by name; of several with one name, the first in the list. */
export function firstColumnByName<T extends { name: string }>(columns: readonly T[]): Map<string, T> {
  const out = new Map<string, T>();
  for (const column of columns) {
    if (!out.has(column.name)) out.set(column.name, column);
  }
  return out;
}

/** Column ids keyed by name; of several with one name, the first in the list. */
export function firstColumnIdByName(columns: readonly { id: string; name: string }[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const column of columns) {
    if (!out.has(column.name)) out.set(column.name, column.id);
  }
  return out;
}

/** The names that more than one column carries, each once, in list order. */
export function duplicatedColumnNames(columns: readonly { name: string }[]): string[] {
  const seen = new Set<string>();
  const duplicated = new Set<string>();
  for (const column of columns) {
    if (seen.has(column.name)) duplicated.add(column.name);
    seen.add(column.name);
  }
  return [...duplicated];
}
