/**
 * Which days of an account each import brought as its own. Pure.
 *
 * An account can be fed from more than one source (a bank export continued
 * from the bank interface's list). The identity of a movement is built from
 * its source's text, so the same movement from two sources would be stored
 * twice; a day therefore belongs to the source that brought it first. An
 * import's own days are its first to its last day, less the days older imports
 * of OTHER formats already held. Imports of the same format share their days:
 * they are told apart by identity. On the first and the last day another
 * source holds, a later source adds the movements beyond what is stored there
 * (see `beyondStored`), so a day the first source exported only in part is
 * filled.
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

/**
 * The imports of one account, oldest first. The import stamps its time after
 * it holds the account's lock and later than every import before it, so the
 * time alone orders them; the id only breaks a tie of rows written before that.
 */
export function orderBatches<T extends Pick<BatchSpan, 'id' | 'createdAt'>>(batches: readonly T[]): T[] {
  return [...batches].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : 1));
}

/** The days each import of one account holds as its own, by import id. */
export function batchCoverage(batches: readonly BatchSpan[]): Map<string, Interval[]> {
  const ordered = orderBatches(batches);
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

/**
 * Of a file's rows on days another source holds, the ones beyond what that
 * source stored: per day and amount, as many rows as are stored are taken to
 * be the same movements (in file order), the rest are new. `stored` is what
 * the other sources hold on those days.
 */
export function beyondStored<T extends { bookingDay: string; amountCents: number }>(rows: readonly T[], stored: ReadonlyArray<{ bookingDay: string; amountCents: number }>): { beyond: T[]; same: T[] } {
  const left = new Map<string, number>();
  for (const s of stored) left.set(`${s.bookingDay}|${s.amountCents}`, (left.get(`${s.bookingDay}|${s.amountCents}`) ?? 0) + 1);
  const beyond: T[] = [];
  const same: T[] = [];
  for (const row of rows) {
    const key = `${row.bookingDay}|${row.amountCents}`;
    const n = left.get(key) ?? 0;
    if (n > 0) {
      left.set(key, n - 1);
      same.push(row);
    } else beyond.push(row);
  }
  return { beyond, same };
}

/** A movement another source of the account stored, as `matchStored` compares it. */
export interface StoredMovement {
  id: string;
  bookingDay: string;
  amountCents: number;
  counterpartyKey: string;
  /** True when its euro amount is an estimate at the reference rate. */
  estimated: boolean;
}

/**
 * Like `beyondStored`, for sources where one side may hold an estimate (a
 * wallet's purchase in another currency at the reference rate, the other
 * source its real euro amount). First, per day and amount, rows and stored
 * movements that are both exact pair up in file order. Then a row and a
 * stored movement of which at least one is an estimate pair up per day and
 * counterparty (a named one only): their amounts differ by the conversion.
 * An exact row paired with an estimated stored movement `settles` it: the real
 * euro amount wins.
 */
export function matchStored<T extends { bookingDay: string; amountCents: number; counterpartyKey: string; estimated?: boolean }>(
  rows: readonly T[],
  stored: readonly StoredMovement[],
): { beyond: T[]; same: T[]; settles: Array<{ row: T; storedId: string }> } {
  const used = new Set<string>();
  const exact = new Map<string, StoredMovement[]>();
  for (const s of stored) if (!s.estimated) exact.set(`${s.bookingDay}|${s.amountCents}`, [...(exact.get(`${s.bookingDay}|${s.amountCents}`) ?? []), s]);
  const same: T[] = [];
  const settles: Array<{ row: T; storedId: string }> = [];
  const rest: T[] = [];
  for (const row of rows) {
    const hit = row.estimated ? undefined : exact.get(`${row.bookingDay}|${row.amountCents}`)?.find((s) => !used.has(s.id));
    if (hit) {
      used.add(hit.id);
      same.push(row);
    } else rest.push(row);
  }
  const byParty = new Map<string, StoredMovement[]>();
  for (const s of stored) {
    if (!s.counterpartyKey) continue;
    const key = `${s.bookingDay}|${s.counterpartyKey}`;
    byParty.set(key, [...(byParty.get(key) ?? []), s]);
  }
  const beyond: T[] = [];
  for (const row of rest) {
    const candidates = row.counterpartyKey ? byParty.get(`${row.bookingDay}|${row.counterpartyKey}`) ?? [] : [];
    const hit = candidates.find((s) => !used.has(s.id) && (row.estimated || s.estimated) && Math.sign(s.amountCents) === Math.sign(row.amountCents));
    if (!hit) {
      beyond.push(row);
      continue;
    }
    used.add(hit.id);
    same.push(row);
    if (!row.estimated && hit.estimated) settles.push({ row, storedId: hit.id });
  }
  return { beyond, same, settles };
}

/** Intervals joined where they overlap or touch: the ranges a source holds as a whole. */
export function mergeIntervals(intervals: readonly Interval[]): Interval[] {
  const sorted = [...intervals].sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0));
  const out: Interval[] = [];
  for (const i of sorted) {
    const last = out[out.length - 1];
    if (last && i.from <= shift(last.to, 1)) {
      if (i.to > last.to) last.to = i.to;
    } else out.push({ ...i });
  }
  return out;
}

/** The bank sources: one bank account may be continued from one of them by another. */
const BANK_FORMATS: readonly string[] = ['enable_banking_json', 'n26_csv', 'tomorrow_csv'];

/** One source of an account: the format of its imports and, for the bank interface, the service it reads. */
export interface PaymentSource {
  format: string;
  service: string | null;
}

/** A source holding a PayPal wallet's movements: its CSV list, or the bank interface reading PayPal. */
export const isPaypalSource = (s: PaymentSource) => s.format === 'paypal_csv' || (s.format === 'enable_banking_json' && s.service === 'paypal');

/**
 * Whether two sources may feed one account. The same source always; two bank
 * sources (a bank file continued from the bank interface, plan 2026-10-15);
 * PayPal's list and the bank interface reading PayPal (plan 2026-10-23). A
 * service's list never shares an account with a bank: they hold different
 * movements (its purchases, not the bank's debits).
 */
export function sourcesMayShare(a: PaymentSource, b: PaymentSource): boolean {
  if (a.format === b.format) return (a.service ?? null) === (b.service ?? null);
  const bank = (s: PaymentSource) => BANK_FORMATS.includes(s.format) && !s.service;
  return (bank(a) && bank(b)) || (isPaypalSource(a) && isPaypalSource(b));
}
