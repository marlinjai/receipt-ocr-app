import { vendorKey } from '@/lib/tax/decisions';
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
 * "Marlin Shop" an own account.
 */

/** Names kept per company at most, and the longest name accepted. */
export const MAX_OWN_NAMES = 20;
export const MAX_OWN_NAME_LENGTH = 120;

/** The words of a name, normalized like a counterparty and sorted; empty when nothing is left. */
export function ownNameKey(name: string): string {
  const key = vendorKey(name);
  if (!key) return '';
  return [...new Set(key.split(' '))].sort().join(' ');
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
 * account. An answer given in the payments tab always wins, so a person can
 * say "this one is private after all" for one spelling. `byName` lists the
 * counterparties the names made own accounts.
 */
export function treatmentsWithOwnNames(
  treatments: ReadonlyMap<string, CounterpartyTreatmentAnswer>,
  counterpartyKeys: Iterable<string>,
  ownNames: readonly string[],
): { treatments: ReadonlyMap<string, CounterpartyTreatmentAnswer>; byName: ReadonlySet<string> } {
  const wanted = new Set(ownNames.map(ownNameKey).filter(Boolean));
  const byName = new Set<string>();
  if (wanted.size === 0) return { treatments, byName };
  for (const key of counterpartyKeys) {
    if (!key || byName.has(key) || treatments.has(key)) continue;
    if (wanted.has(ownNameKey(key))) byName.add(key);
  }
  if (byName.size === 0) return { treatments, byName };
  const out = new Map(treatments);
  for (const key of byName) out.set(key, 'own_account');
  return { treatments: out, byName };
}
