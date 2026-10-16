import { WHOLE_BP } from './money';
import { parseAllocations } from './decisions';
import type { Allocation, Purpose } from './types';

/**
 * The two older receipt columns, "Zuordnung" (who bears a receipt: business,
 * university, private) and "Business Share %", as a VIEW of the finance
 * decision.
 *
 * Who bears a receipt has one source: the treatment the finance area resolves
 * (a decision on the receipt, else the vendor rule in force). Where such a
 * treatment exists, the two cells are written from it, and an edit of the
 * cells is turned into a decision. Where none exists yet, the cells are the
 * starting point the finance area reads (`legacyAllocations`), so the two
 * cannot disagree either. Rows the meal register judges keep their cells as
 * the register's own input.
 *
 * Pure: the projection, the normalization and the edit rules, shared by the
 * write paths, the migration and the tests.
 */

export const BUSINESS = 'Geschäftlich';
export const UNIVERSITY = 'Universität';
export const PRIVATE = 'Privat';

export interface AssignmentCells {
  zuordnung: string;
  /** Percent, as the cell holds it: basis points / 100, so a share reads back to the same basis points. */
  sharePercent: number;
}

const shareOf = (allocations: readonly Allocation[], purposes: Purpose[]) =>
  allocations.filter((a) => purposes.includes(a.purpose)).reduce((sum, a) => sum + a.shareBp, 0);

/**
 * The cells for a treatment. One cell pair cannot say everything an allocation
 * can, so: any business share shows as business with that share; otherwise a
 * study or employment share shows as university with that share; otherwise the
 * receipt is private, with share 0. A mix keeps its truth in the decision.
 */
export function treatmentToCells(allocations: readonly Allocation[]): AssignmentCells {
  const business = shareOf(allocations, ['business']);
  if (business > 0) return { zuordnung: BUSINESS, sharePercent: business / 100 };
  const university = shareOf(allocations, ['study', 'employment']);
  if (university > 0) return { zuordnung: UNIVERSITY, sharePercent: university / 100 };
  return { zuordnung: PRIVATE, sharePercent: 0 };
}

/**
 * Cells that are themselves the source (no decision, no vendor rule): only a
 * private receipt is touched, whose share is 0 everywhere. That share plays no
 * role in any figure (`legacyAllocations` makes "Privat" private whatever the
 * share), it was 100 in some rows and 0 in others.
 */
export function normalizedLegacyCells(zuordnung: string | null, sharePercent: number | null): AssignmentCells | null {
  if (zuordnung !== PRIVATE) return null;
  return { zuordnung: PRIVATE, sharePercent: 0 };
}

export interface AssignmentEdit {
  /** Undefined: not edited. Null or '': cleared. */
  zuordnung?: string | null;
  /** Undefined: not edited. */
  sharePercent?: number | null;
}

const toBp = (percent: number) => Math.round(Math.min(100, Math.max(0, percent)) * 100);

/**
 * The allocations an edit of the cells means for a receipt whose treatment is
 * `current`. Null when the edit clears the assignment.
 *
 * - A new assignment replaces the purposes: business or university with the
 *   share given (else the share shown before, else the whole), private as the
 *   whole.
 * - A new share for the same assignment changes only the purpose the cells
 *   show; other purposes of a mixed treatment stay, and the shown one is cut
 *   back so the total never exceeds the whole.
 * - A share of 0 for business or university means private.
 */
export function editedAllocations(current: readonly Allocation[], edit: AssignmentEdit): Allocation[] | null {
  const shown = treatmentToCells(current);
  if (edit.zuordnung === null || edit.zuordnung === '') return null;
  const zuordnung = edit.zuordnung ?? shown.zuordnung;
  if (zuordnung === PRIVATE) return [{ purpose: 'private', shareBp: WHOLE_BP }];
  if (zuordnung !== BUSINESS && zuordnung !== UNIVERSITY) return null;

  const changed = zuordnung !== shown.zuordnung;
  const editedShare = edit.sharePercent === undefined || edit.sharePercent === null || !Number.isFinite(edit.sharePercent) ? null : edit.sharePercent;
  const shareBp = toBp(editedShare ?? (changed ? (shown.zuordnung === PRIVATE ? 100 : shown.sharePercent) : shown.sharePercent));
  if (shareBp === 0) return [{ purpose: 'private', shareBp: WHOLE_BP }];

  if (changed) return parseAllocations([{ purpose: zuordnung === BUSINESS ? 'business' : 'study', shareBp }]) ?? null;

  // Same assignment, new share: the purpose the cells show takes it.
  const purpose: Purpose =
    zuordnung === BUSINESS ? 'business' : current.some((a) => a.purpose === 'study' && a.shareBp > 0) ? 'study' : current.some((a) => a.purpose === 'employment' && a.shareBp > 0) ? 'employment' : 'study';
  // The cells show study and employment together as university: an edit of
  // that share sets it as one purpose. Business beside it stays as it was.
  const shownPurposes: Purpose[] = zuordnung === BUSINESS ? ['business'] : ['study', 'employment'];
  const others = current.filter((a) => !shownPurposes.includes(a.purpose) && a.purpose !== 'private' && a.shareBp > 0);
  const othersBp = others.reduce((sum, a) => sum + a.shareBp, 0);
  return parseAllocations([...others, { purpose, shareBp: Math.min(shareBp, WHOLE_BP - othersBp) }]) ?? null;
}
