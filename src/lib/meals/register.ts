import { mealDeduction, mealStatus, smallBusinessOn, toCents, fromCents, type MealDeduction, type MissingField } from './rules';
import type { MealRecord, MealTaxSettings } from './types';

/**
 * The register of one calendar year, built from the workspace's meal records.
 * Pure: the page, the CSV export and the PDF export all render this one
 * structure, so they cannot disagree.
 */

type OkDeduction = Extract<MealDeduction, { kind: 'ok' }>;

export interface RegisterEntry {
  /** Running number within the year, by date. */
  no: number;
  record: MealRecord;
  /** Null while the section 19 question is unanswered. */
  deduction: OkDeduction | null;
}

export interface IncompleteEntry {
  record: MealRecord;
  missing: MissingField[];
}

export interface SeparateCount {
  count: number;
  /** Sum of the receipt totals in euro (receipts without a usable amount count as 0). */
  grossEur: number;
}

export interface RegisterTotals {
  gross: number;
  tip: number;
  net: number | null;
  inputVat: number | null;
  base: number;
  /** Goes to account 4650 (deductible business meals). */
  deductible: number;
  /** Goes to account 4654 (non-deductible business meals). */
  nonDeductible: number;
}

export interface MealRegister {
  year: number;
  /** True while the section 19 question is unanswered: entries are listed, amounts are not. */
  settingMissing: boolean;
  basis: 'gross' | 'net' | null;
  entries: RegisterEntry[];
  /** Would-be entries of this year with facts missing. Outside the totals. */
  incomplete: IncompleteEntry[];
  /** Null while the setting is missing. */
  totals: RegisterTotals | null;
  staffMeals: SeparateCount;
  travelMeals: SeparateCount;
  privateMeals: SeparateCount;
  /** Entries whose value-added tax split is estimated or does not match the receipt total. */
  vatEstimatedCount: number;
  vatMismatchCount: number;
}

function yearOf(record: MealRecord): number | null {
  return record.date ? Number(record.date.slice(0, 4)) : null;
}

function grossEur(record: MealRecord): number {
  if (!record.gross || record.gross <= 0) return 0;
  const fx = record.currency === 'EUR' ? 1 : record.fxRate;
  if (!fx || fx <= 0) return 0;
  return fromCents(Math.round(toCents(record.gross) * fx));
}

function byDate(a: MealRecord, b: MealRecord): number {
  const da = a.date ?? '';
  const dbb = b.date ?? '';
  if (da !== dbb) return da < dbb ? -1 : 1;
  return a.rowId < b.rowId ? -1 : a.rowId > b.rowId ? 1 : 0;
}

/** The years that have any meal record, newest first. */
export function registerYears(records: MealRecord[]): number[] {
  const years = new Set<number>();
  for (const r of records) {
    const y = yearOf(r);
    if (y) years.add(y);
  }
  return [...years].sort((a, b) => b - a);
}

/**
 * Every incomplete meal of the workspace, oldest first, whatever its year
 * (and including receipts without a date). This is the work queue.
 */
export function incompleteQueue(records: MealRecord[]): IncompleteEntry[] {
  const out: IncompleteEntry[] = [];
  for (const record of [...records].sort(byDate)) {
    const status = mealStatus(record);
    if (status.kind === 'incomplete') out.push({ record, missing: status.missing });
  }
  return out;
}

export function buildRegister(records: MealRecord[], settings: MealTaxSettings, year: number): MealRegister {
  const settingMissing = settings.smallBusiness === null;
  const entries: RegisterEntry[] = [];
  const incomplete: IncompleteEntry[] = [];
  const separate = {
    staff_meal_internal: { count: 0, cents: 0 },
    travel_meal: { count: 0, cents: 0 },
    private: { count: 0, cents: 0 },
  };
  const sum = { gross: 0, tip: 0, net: 0, inputVat: 0, base: 0, deductible: 0, nonDeductible: 0 };
  let vatEstimatedCount = 0;
  let vatMismatchCount = 0;

  for (const record of [...records].sort(byDate)) {
    if (yearOf(record) !== year) continue;
    const status = mealStatus(record);
    if (status.kind === 'not_a_meal') continue;
    if (status.kind === 'excluded') {
      separate[status.reason].count += 1;
      separate[status.reason].cents += toCents(grossEur(record));
      continue;
    }
    if (status.kind === 'incomplete') {
      incomplete.push({ record, missing: status.missing });
      continue;
    }
    const deduction = mealDeduction(record, settings);
    if (deduction.kind === 'ok') {
      sum.gross += toCents(deduction.gross);
      sum.tip += toCents(deduction.tip);
      sum.net += toCents(deduction.net ?? 0);
      sum.inputVat += toCents(deduction.inputVat ?? 0);
      sum.base += toCents(deduction.base);
      sum.deductible += toCents(deduction.deductible);
      sum.nonDeductible += toCents(deduction.nonDeductible);
      if (deduction.vatEstimated) vatEstimatedCount += 1;
      if (deduction.vatLinesMismatch) vatMismatchCount += 1;
    }
    entries.push({ no: entries.length + 1, record, deduction: deduction.kind === 'ok' ? deduction : null });
  }

  // The status can change inside a year (see smallBusinessOn): each entry carries its own basis.
  // The year shows the net columns as soon as one entry is on the net basis; a year without
  // entries takes the status of its last day.
  const basis = settingMissing
    ? null
    : entries.some((e) => e.deduction?.basis === 'net') || (entries.length === 0 && smallBusinessOn(settings, `${year}-12-31`) === false)
      ? 'net'
      : 'gross';
  const count = (s: { count: number; cents: number }): SeparateCount => ({
    count: s.count,
    grossEur: fromCents(s.cents),
  });

  return {
    year,
    settingMissing,
    basis,
    entries,
    incomplete,
    totals: settingMissing
      ? null
      : {
          gross: fromCents(sum.gross),
          tip: fromCents(sum.tip),
          net: basis === 'net' ? fromCents(sum.net) : null,
          inputVat: basis === 'net' ? fromCents(sum.inputVat) : null,
          base: fromCents(sum.base),
          deductible: fromCents(sum.deductible),
          nonDeductible: fromCents(sum.nonDeductible),
        },
    staffMeals: count(separate.staff_meal_internal),
    travelMeals: count(separate.travel_meal),
    privateMeals: count(separate.private),
    vatEstimatedCount,
    vatMismatchCount,
  };
}

export type ExportRefusal =
  /** The section 19 question must be answered first. */
  | { code: 'setting_missing' }
  /** There are incomplete entries and the caller has not acknowledged exactly this many. */
  | { code: 'incomplete_unacknowledged'; incompleteCount: number };

/**
 * Whether an export of this register may be produced. An export with open
 * incomplete entries is allowed only after a confirmation that names the
 * count; the acknowledged count must match the CURRENT count, so a
 * confirmation given for 2 open entries does not cover a third one that
 * appeared since.
 */
export function exportRefusal(register: MealRegister, acknowledgedIncomplete: number | null): ExportRefusal | null {
  if (register.settingMissing) return { code: 'setting_missing' };
  if (register.incomplete.length > 0 && acknowledgedIncomplete !== register.incomplete.length) {
    return { code: 'incomplete_unacknowledged', incompleteCount: register.incomplete.length };
  }
  return null;
}
