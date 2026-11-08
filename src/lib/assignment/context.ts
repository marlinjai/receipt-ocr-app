import { sameSubject as sameVendorName } from '@/lib/classification-rules';
import type { AssignmentContext, Correction, PastAnswer, Statement, VendorHistory } from './prompt';

/**
 * What the assignment model is told about the person (plan
 * docs/plans/2026-11-07-learned-assignment.md, decision 2), built from three
 * sources, none of them a fixed list in code: the person's statements, how the
 * person answered before (computed live from the receipts, never stored as a
 * second copy) and the corrections of the model's own answers.
 *
 * Pure: the pass gives it every answered receipt of the workspace, the replay
 * only the ones before the receipt it decides.
 */

/** An earlier correction, with the vendor it was about (for the ordering below). */
export type CorrectionEntry = Correction & { rowId: string };

/** Earlier similar receipts shown: of the same vendor first, then of the same category. */
export const SIMILAR_LIMIT = 6;
const SAME_VENDOR_SIMILAR = 4;
/** Corrections shown: of the same vendor first, then the latest. */
export const CORRECTION_LIMIT = 8;

/** A vendor as compared, and two names that are one business: the same as for a statement's subject. */
export { subjectKey as vendorKey, sameSubject as sameVendorName } from '@/lib/classification-rules';

const byDayDesc = (a: { date: string | null }, b: { date: string | null }) => (b.date ?? '').localeCompare(a.date ?? '');

export function vendorHistoryOf(vendor: string | null, answered: readonly PastAnswer[]): VendorHistory | null {
  if (!vendor || !vendor.trim()) return null;
  const same = answered.filter((p) => sameVendorName(vendor, p.vendor));
  if (same.length === 0) return null;
  const by = new Map<string, { count: number; latest: string | null }>();
  for (const p of same) {
    const entry = by.get(p.assignment) ?? { count: 0, latest: null };
    entry.count++;
    if (p.date && (!entry.latest || p.date > entry.latest)) entry.latest = p.date;
    by.set(p.assignment, entry);
  }
  return {
    vendor: vendor!.trim(),
    answers: [...by.entries()].map(([assignment, v]) => ({ assignment, ...v })).sort((a, b) => b.count - a.count || (b.latest ?? '').localeCompare(a.latest ?? '')),
  };
}

export function buildAssignmentContext(
  target: { rowId: string; vendor: string | null; category: string | null },
  answered: readonly PastAnswer[],
  statements: readonly Statement[],
  corrections: readonly CorrectionEntry[],
): AssignmentContext {
  const others = answered.filter((p) => p.rowId !== target.rowId);
  const sameVendor = others.filter((p) => sameVendorName(target.vendor, p.vendor)).sort(byDayDesc).slice(0, SAME_VENDOR_SIMILAR);
  const taken = new Set(sameVendor.map((p) => p.rowId));
  const sameCategory = target.category
    ? others.filter((p) => !taken.has(p.rowId) && p.category === target.category).sort(byDayDesc).slice(0, SIMILAR_LIMIT - sameVendor.length)
    : [];
  const ownCorrections = corrections.filter((c) => c.rowId !== target.rowId);
  const correctionsShown = [
    ...ownCorrections.filter((c) => sameVendorName(target.vendor, c.vendor)).sort(byDayDesc),
    ...ownCorrections.filter((c) => !sameVendorName(target.vendor, c.vendor)).sort(byDayDesc),
  ].slice(0, CORRECTION_LIMIT);
  return {
    // A statement about the person goes to every receipt; one about a vendor ("Was ist das?") only to that vendor's.
    statements: statements.filter((st) => !st.subject || sameVendorName(st.subject, target.vendor)),
    vendorHistory: vendorHistoryOf(target.vendor, others),
    similar: [...sameVendor, ...sameCategory],
    corrections: correctionsShown.map((c) => ({ vendor: c.vendor, date: c.date, category: c.category, item: c.item, modelSaid: c.modelSaid, how: c.how, personSaid: c.personSaid })),
  };
}

/** What a decision rested on, for the record: counts and ids, never a receipt's text. */
export function contextFacts(context: AssignmentContext) {
  return {
    statements: context.statements.map((s) => s.id),
    vendorAnswers: context.vendorHistory?.answers.map((a) => ({ assignment: a.assignment, count: a.count })) ?? [],
    similar: context.similar.map((p) => p.rowId),
    corrections: context.corrections.length,
  };
}
