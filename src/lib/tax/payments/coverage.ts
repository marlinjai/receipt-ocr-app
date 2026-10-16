/**
 * Which days of an account each import brought as its own. Pure.
 *
 * An account can be fed from more than one source (a bank export continued
 * from the bank interface's list). The identity of a movement is built from
 * its source's text, so the same movement from two sources would be stored
 * twice; a day therefore belongs to the source that brought it first. An
 * import's own days are its first to its last day, less the days older imports
 * of OTHER formats already held (it skipped those when it was read). Imports
 * of the same format share their days: they are told apart by identity.
 */

export interface Interval {
  /** ISO days, both included. */
  from: string;
  to: string;
}

export interface BatchSpan {
  id: string;
  format: string;
  firstDay: string | null;
  lastDay: string | null;
  createdAt: Date;
}

const shift = (day: string, by: number) => new Date(Date.parse(`${day}T00:00:00Z`) + by * 86_400_000).toISOString().slice(0, 10);

/** `from` less every interval of `cut`. */
export function subtract(from: readonly Interval[], cut: readonly Interval[]): Interval[] {
  let rest = [...from];
  for (const c of cut) {
    rest = rest.flatMap((r) => {
      if (c.to < r.from || c.from > r.to) return [r];
      const parts: Interval[] = [];
      if (c.from > r.from) parts.push({ from: r.from, to: shift(c.from, -1) });
      if (c.to < r.to) parts.push({ from: shift(c.to, 1), to: r.to });
      return parts;
    });
  }
  return rest;
}

export function covers(intervals: readonly Interval[], day: string): boolean {
  return intervals.some((i) => i.from <= day && day <= i.to);
}

export function overlaps(a: readonly Interval[], b: readonly Interval[]): boolean {
  return a.some((x) => b.some((y) => x.from <= y.to && y.from <= x.to));
}

/** The days each import of one account holds as its own, by import id, oldest import first. */
export function batchCoverage(batches: readonly BatchSpan[]): Map<string, Interval[]> {
  const ordered = [...batches].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : 1));
  const out = new Map<string, Interval[]>();
  for (const [index, batch] of ordered.entries()) {
    if (batch.firstDay === null || batch.lastDay === null) {
      out.set(batch.id, []);
      continue;
    }
    const older = ordered.slice(0, index).filter((b) => b.format !== batch.format).flatMap((b) => out.get(b.id) ?? []);
    out.set(batch.id, subtract([{ from: batch.firstDay, to: batch.lastDay }], older));
  }
  return out;
}

/** The days other sources than `format` hold on the account: a file of `format` leaves its rows on them out. */
export function coveredByOtherSources(batches: readonly BatchSpan[], format: string): Interval[] {
  const coverage = batchCoverage(batches);
  return batches.filter((b) => b.format !== format).flatMap((b) => coverage.get(b.id) ?? []);
}
