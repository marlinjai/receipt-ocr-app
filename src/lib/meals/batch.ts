import type { MealRecord } from './types';

/**
 * Batch actions on receipts of the meal register: the shapes shared by the
 * server (service and actions) and the page, and the wording of an outcome.
 *
 * A batch never stops at the first receipt it cannot handle: it finishes the
 * rest and reports every receipt it left alone, with the reason.
 */

/** Upper bound of one batch; far above any real queue, low enough to bound one request. */
export const MEAL_BATCH_MAX = 200;

export type MealBatchSkipReason =
  /** Deleted meanwhile (another tab), or not a receipt of the active workspace. */
  | 'not_found'
  /** The stored file could not be removed, so the receipt was left untouched. */
  | 'file_delete_failed'
  /** Anything else; the receipt was left as it was. */
  | 'failed';

export interface MealBatchSkip {
  rowId: string;
  reason: MealBatchSkipReason;
}

export interface MealBatchResult {
  /** Receipts the action was carried out for. */
  done: string[];
  /** The receipts of `done` as they are stored now (empty after a delete). */
  records: MealRecord[];
  skipped: MealBatchSkip[];
}

export type MealBatchKind = 'not_meal' | 'restore' | 'delete';

/**
 * Untrusted row ids from the browser as a clean list: strings, no blanks, no
 * repeats (a double submit of the same id is one receipt). Null when the
 * input is not a usable batch.
 */
export function normalizeRowIds(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) return null;
  const ids = [...new Set(raw.filter((v) => typeof v === 'string').map((v) => v.trim()).filter(Boolean))];
  if (ids.length === 0 || ids.length > MEAL_BATCH_MAX) return null;
  return ids;
}

export function receiptCount(n: number): string {
  return n === 1 ? '1 Beleg' : `${n} Belege`;
}

export interface MealBatchNotice {
  /** 'danger' when something failed, 'warn' when receipts were only skipped as gone. */
  tone: 'ok' | 'warn' | 'danger';
  text: string;
}

/** What to tell the user after a batch, including everything that was skipped. */
export function batchOutcomeNotice(
  kind: MealBatchKind,
  result: MealBatchResult,
  singleLabel?: string,
  /** Whether the view has a selection the kept receipts stay in; the register has none. */
  hasSelection = false,
): MealBatchNotice {
  const n = result.done.length;
  const count = (reason: MealBatchSkipReason) => result.skipped.filter((s) => s.reason === reason).length;
  const gone = count('not_found');
  const fileFailed = count('file_delete_failed');
  const failed = count('failed');
  const subject = n === 1 && singleLabel ? `„${singleLabel}“` : receiptCount(n);
  const plural = !(n === 1);
  const parts: string[] = [];

  if (n > 0) {
    if (kind === 'delete') {
      parts.push(`${subject} gelöscht.`);
    } else if (kind === 'not_meal') {
      parts.push(
        `${subject} ${plural ? 'werden' : 'wird'} nicht mehr als Bewirtung geführt. ` +
          `${plural ? 'Die Belege bleiben' : 'Der Beleg bleibt'} im Dashboard und ${plural ? 'stehen' : 'steht'} hier unter „Keine Bewirtung“; ` +
          `von dort ${plural ? 'lassen sie' : 'lässt er'} sich mit allen Angaben wieder aufnehmen.`,
      );
    } else {
      parts.push(`${subject} ${plural ? 'werden' : 'wird'} wieder als Bewirtung geführt, mit den zuvor erfassten Angaben.`);
    }
  } else if (kind === 'delete') {
    parts.push('Es wurde kein Beleg gelöscht.');
  } else {
    parts.push('Es wurde kein Beleg geändert.');
  }

  if (gone > 0) {
    parts.push(
      `${receiptCount(gone)} übersprungen: nicht mehr vorhanden (inzwischen gelöscht oder aus einem anderen Arbeitsbereich).`,
    );
  }
  if (fileFailed > 0) {
    parts.push(
      `Bei ${receiptCount(fileFailed)} ließ sich die gespeicherte Datei nicht löschen. ` +
        `${fileFailed === 1 ? 'Dieser Beleg wurde' : 'Diese Belege wurden'} deshalb nicht gelöscht` +
        (hasSelection ? ` und ${fileFailed === 1 ? 'bleibt' : 'bleiben'} ausgewählt` : '') +
        '. Bitte erneut versuchen.',
    );
  }
  if (failed > 0) {
    parts.push(
      `Bei ${receiptCount(failed)} ist ein Fehler aufgetreten; ${failed === 1 ? 'er ist' : 'sie sind'} unverändert. Bitte erneut versuchen.`,
    );
  }

  return { tone: fileFailed + failed > 0 ? 'danger' : gone > 0 ? 'warn' : 'ok', text: parts.join(' ') };
}
