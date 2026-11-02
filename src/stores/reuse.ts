const isRecord = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== 'object' || value === null) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};

/** What tells a record in a list from the others, whatever its place: a list that lost one entry keeps the rest. */
const idOf = (value: unknown): unknown => (isRecord(value) ? (value.itemId ?? value.id ?? value.key) : undefined);

function reuseList(before: unknown[], next: unknown[]): unknown[] {
  const byId = new Map(before.filter((v) => idOf(v) !== undefined).map((v) => [idOf(v), v]));
  const list = next.map((value, index) => {
    const id = idOf(value);
    return reuse(id !== undefined && byId.has(id) ? byId.get(id) : before[index], value);
  });
  return list.length === before.length && list.every((value, index) => value === before[index]) ? before : list;
}

/**
 * `next`, with every part that did not change being the object from `before`. A
 * write in finance answers with the whole year; this is what lets a row tell by
 * its record that its own record is not what changed. Values are only ever taken
 * from `next` or found equal to it, so the outcome always reads as `next` does.
 */
export function reuse<T>(before: T, next: T): T {
  if (Object.is(before, next)) return before;
  if (Array.isArray(before) && Array.isArray(next)) return reuseList(before, next) as T;
  if (!isRecord(before) || !isRecord(next)) return next;
  const keys = Object.keys(next);
  const merged = Object.fromEntries(keys.map((key) => [key, key in before ? reuse(before[key], next[key]) : next[key]]));
  const same = keys.length === Object.keys(before).length && keys.every((key) => key in before && Object.is(merged[key], before[key]));
  return (same ? before : merged) as T;
}
