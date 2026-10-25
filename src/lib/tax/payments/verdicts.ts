import { isSpendingCategory, type SpendingCategory } from '@/lib/spending/categories';
import { treatmentsWithOwnNames } from '@/lib/spending/own-names';
import type { CounterpartyTreatmentAnswer } from '@/lib/spending/rules';

/**
 * What the app decided about a counterparty, and who decides what counts
 * (plan docs/plans/2026-10-25-auto-classify-payments.md, decision 2). Pure.
 *
 * First hit wins, per counterparty:
 *
 * 1. a person's answer in the payments tab;
 * 2. the owner's own names (`SpendingSettings.ownNames`): money to or from
 *    oneself is an own account, also under Finanzen, because for the
 *    income-surplus statement a private withdrawal and an own transfer are
 *    the same (neither is an expense);
 * 3. the app's verdict, only when it is certain;
 * 4. otherwise nothing: the counterparty stays a question.
 *
 * The category is decided apart from this (`src/lib/spending/rules.ts`): a
 * person's category, the keyword rules, then the app's certain verdict.
 */

export const VERDICT_CONFIDENCES = ['certain', 'likely', 'unsure'] as const;
export type VerdictConfidence = (typeof VERDICT_CONFIDENCES)[number];

/** `evidence`: decided from the company's own data (its receipts), no model asked. `model`: a language model decided. */
export type VerdictSource = 'evidence' | 'model';

/** Where the treatment that counts for a counterparty comes from. */
export type TreatmentSource = 'person' | 'own_name' | 'app';

const TREATMENTS: readonly CounterpartyTreatmentAnswer[] = ['business', 'private', 'own_account', 'mixed'];

export function isTreatment(value: unknown): value is CounterpartyTreatmentAnswer {
  return typeof value === 'string' && (TREATMENTS as readonly string[]).includes(value);
}

export interface Verdict {
  counterpartyKey: string;
  label: string;
  treatment: CounterpartyTreatmentAnswer | null;
  category: SpendingCategory | null;
  confidence: VerdictConfidence;
  reason: string;
  source: VerdictSource;
}

/** Only a certain verdict counts; a likely or unsure one is a proposal a person confirms. */
export function verdictApplies(verdict: Pick<Verdict, 'confidence'>): boolean {
  return verdict.confidence === 'certain';
}

/**
 * A stored row read back as a verdict. A value that is no longer known (a
 * category removed later, a confidence written by hand) is read as nothing
 * rather than miscounted: an unknown treatment or category is null, an
 * unknown confidence makes the whole row no verdict.
 */
export function storedVerdict(row: {
  counterpartyKey: string;
  label: string;
  treatment: string | null;
  category: string | null;
  confidence: string;
  reason: string;
  source: string;
}): Verdict | null {
  if (!(VERDICT_CONFIDENCES as readonly string[]).includes(row.confidence)) return null;
  return {
    counterpartyKey: row.counterpartyKey,
    label: row.label,
    treatment: isTreatment(row.treatment) ? row.treatment : null,
    category: isSpendingCategory(row.category) && row.category !== 'unclear' ? row.category : null,
    confidence: row.confidence as VerdictConfidence,
    reason: row.reason,
    source: row.source === 'evidence' ? 'evidence' : 'model',
  };
}

/**
 * The treatments that count, with where each comes from. `person` holds the
 * payments tab's answers; the own names apply only where nobody answered (a
 * person's "private" stays private here, unlike on the spending side, which
 * treats money to oneself as no spending whatever was answered); the app's
 * certain verdicts fill what is left.
 */
export function mergeTreatments(
  person: ReadonlyMap<string, CounterpartyTreatmentAnswer>,
  payments: Iterable<{ counterpartyKey: string; counterparty: string; amountCents: number }>,
  ownNames: readonly string[],
  verdicts: Iterable<Verdict>,
): { treatments: Map<string, CounterpartyTreatmentAnswer>; sources: Map<string, TreatmentSource> } {
  const treatments = new Map(person);
  const sources = new Map<string, TreatmentSource>([...person.keys()].map((key) => [key, 'person']));
  const list = [...payments];
  // Who paid money in: the app never makes such a counterparty anything but business on its own, whenever the money came.
  const paidIn = new Set(list.filter((p) => p.amountCents > 0).map((p) => p.counterpartyKey));
  const { byName } = treatmentsWithOwnNames(person, list, ownNames);
  for (const key of byName) {
    if (person.has(key)) continue;
    treatments.set(key, 'own_account');
    sources.set(key, 'own_name');
  }
  for (const verdict of verdicts) {
    if (treatments.has(verdict.counterpartyKey) || verdict.treatment === null || !verdictApplies(verdict)) continue;
    if (verdict.source === 'model' && (verdict.treatment === 'own_account' || (verdict.treatment !== 'business' && paidIn.has(verdict.counterpartyKey)))) continue;
    treatments.set(verdict.counterpartyKey, verdict.treatment);
    sources.set(verdict.counterpartyKey, 'app');
  }
  return { treatments, sources };
}

/** The app's certain categories, by counterparty: what the spending side uses when no person and no keyword rule says one. */
export function appCategories(verdicts: Iterable<Verdict>): Map<string, SpendingCategory> {
  const out = new Map<string, SpendingCategory>();
  for (const verdict of verdicts) if (verdict.category !== null && verdictApplies(verdict)) out.set(verdict.counterpartyKey, verdict.category);
  return out;
}
