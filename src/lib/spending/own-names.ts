import type { CounterpartyTreatmentAnswer } from './rules';

/**
 * The owner's own names (plan docs/plans/2026-10-23-budget-overview.md,
 * decision 1). Money to or from a counterparty that carries one of them is
 * money between the owner's own accounts: never spending, never asked for a
 * receipt. Pure; derived on read, nothing is written to the payments.
 *
 * A name matches when its words are the same as the counterparty's, whatever
 * their case, accents, punctuation and order: "Pohl, Marlin Jai" is
 * "MARLIN JAI POHL". Never a part of a name: "Marlin" alone does not make
 * "Marlin Shop" an own account, and a legal form is a word of its own, so
 * "Marlin Jai Pohl UG" (another legal person) is not "Marlin Jai Pohl".
 *
 * This is about spending only: under Finanzen, Zahlungen the same transfer
 * keeps its own answer (from a business account it is a private withdrawal,
 * which is a tax matter, not a move between own accounts).
 */

/** Names kept per company at most, and the longest name accepted. */
export const MAX_OWN_NAMES = 20;
export const MAX_OWN_NAME_LENGTH = 120;

/**
 * The words of a name in lower case, umlauts written out, accents and
 * punctuation gone, each word once and sorted; empty when fewer than two
 * letters or digits are left. Unlike a counterparty key, legal forms stay.
 */
export function ownNameKey(name: string): string {
  const words = name
    .toLowerCase()
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  const key = [...new Set(words)].sort().join(' ');
  return key.replace(/ /g, '').length >= 2 ? key : '';
}

export type OwnNamesError = 'invalid_names' | 'name_too_long' | 'too_many_names';

/**
 * The names a person typed, cleaned: trimmed, without empty ones and without
 * a second spelling of a name already listed (the first one stays). A name
 * with nothing to match on ("-", one letter) is refused rather than kept as a
 * name that never matches.
 */
export function cleanOwnNames(raw: unknown): { ok: true; names: string[] } | { ok: false; error: OwnNamesError } {
  if (!Array.isArray(raw)) return { ok: false, error: 'invalid_names' };
  const names: string[] = [];
  const seen = new Set<string>();
  for (const value of raw) {
    if (typeof value !== 'string') return { ok: false, error: 'invalid_names' };
    const name = value.trim().replace(/\s+/g, ' ');
    if (!name) continue;
    if (name.length > MAX_OWN_NAME_LENGTH) return { ok: false, error: 'name_too_long' };
    const key = ownNameKey(name);
    if (!key) return { ok: false, error: 'invalid_names' };
    if (seen.has(key)) continue;
    seen.add(key);
    names.push(name);
  }
  if (names.length > MAX_OWN_NAMES) return { ok: false, error: 'too_many_names' };
  return { ok: true, names };
}

/**
 * The counterparty answers with the own names applied: a counterparty that
 * carries one of the names and has no answer of its own counts as an own
 * account. An answer of the payments tab that says it is something else wins
 * (business, mixed, or own account itself); "private" does not, because money
 * to oneself answered private there (a private withdrawal from a business
 * account, a tax matter) is still no spending here. Answers are kept per
 * counterparty key, which leaves legal forms out, so a key counts only when
 * every payment under it names the owner exactly: one "... UG" among them and
 * none of them does. `byName` lists the counterparties the names made own
 * accounts.
 */
export function treatmentsWithOwnNames(
  treatments: ReadonlyMap<string, CounterpartyTreatmentAnswer>,
  payments: Iterable<{ counterpartyKey: string; counterparty: string }>,
  ownNames: readonly string[],
): { treatments: ReadonlyMap<string, CounterpartyTreatmentAnswer>; byName: ReadonlySet<string> } {
  const wanted = new Set(ownNames.map(ownNameKey).filter(Boolean));
  const byName = new Set<string>();
  if (wanted.size === 0) return { treatments, byName };
  const refused = new Set<string>();
  for (const { counterpartyKey: key, counterparty } of payments) {
    if (!key || refused.has(key)) continue;
    const answer = treatments.get(key);
    if (answer !== undefined && answer !== 'private') continue;
    if (wanted.has(ownNameKey(counterparty))) byName.add(key);
    else {
      refused.add(key);
      byName.delete(key);
    }
  }
  if (byName.size === 0) return { treatments, byName };
  const out = new Map(treatments);
  for (const key of byName) out.set(key, 'own_account');
  return { treatments: out, byName };
}
