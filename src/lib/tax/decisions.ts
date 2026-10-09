import { WHOLE_BP } from './money';
import { isFormLineKey, type FormLineKey, type YearRules } from './rules/types';
import { PURPOSES, type Allocation, type Purpose } from './types';

/**
 * What a person can decide about an item or a vendor, and the checks every
 * write passes. Pure, so the form, the server action and the tests share it.
 */

export interface TreatmentInput {
  allocations: Allocation[];
  formLineKey: FormLineKey | null;
  employmentLineKey: FormLineKey | null;
  /**
   * Only on the low-value asset line: the receipt holds several assets, each
   * within the limit on its own, so its total may exceed the limit. A statement
   * about one receipt; a vendor rule never carries it.
   */
  severalLowValueItems?: boolean;
}

export type TreatmentErrorCode =
  | 'invalid_allocation'
  | 'allocation_exceeds_whole'
  | 'nothing_allocated'
  | 'form_line_required'
  | 'form_line_invalid'
  | 'employment_line_required'
  | 'employment_line_invalid';

export class TreatmentError extends Error {
  readonly code: TreatmentErrorCode;
  constructor(code: TreatmentErrorCode) {
    super(code);
    this.name = 'TreatmentError';
    this.code = code;
  }
}

/** Read allocations from untrusted data (a request body, a stored JSON column). Null when it is not a valid list. */
export function parseAllocations(raw: unknown): Allocation[] | null {
  if (!Array.isArray(raw)) return null;
  const merged = new Map<Purpose, number>();
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') return null;
    const { purpose, shareBp } = entry as { purpose?: unknown; shareBp?: unknown };
    if (typeof purpose !== 'string' || !(PURPOSES as readonly string[]).includes(purpose)) return null;
    if (typeof shareBp !== 'number' || !Number.isInteger(shareBp) || shareBp < 0 || shareBp > WHOLE_BP) return null;
    merged.set(purpose as Purpose, (merged.get(purpose as Purpose) ?? 0) + shareBp);
  }
  // One entry per purpose, zero shares dropped, in a fixed order: two inputs
  // that mean the same thing are stored and compared as the same thing.
  return PURPOSES.filter((p) => (merged.get(p) ?? 0) > 0).map((p) => ({ purpose: p, shareBp: merged.get(p) as number }));
}

/**
 * Check and normalize a treatment before it is stored.
 *
 * - shares are whole basis points and never exceed the whole together; what
 *   is left over is private;
 * - a business share needs an expense line of the income-surplus statement.
 *   The business-meal line cannot be chosen by hand: what counts as a meal and
 *   what it is worth is decided by the meal register alone;
 * - a study or employment share needs a line of the employment annex;
 * - a line without a matching share is dropped, so a stored treatment never
 *   carries a line that plays no role.
 */
export function validateTreatment(raw: unknown, rules: YearRules): TreatmentInput {
  const input = (raw ?? {}) as { allocations?: unknown; formLineKey?: unknown; employmentLineKey?: unknown; severalLowValueItems?: unknown };
  const allocations = parseAllocations(input.allocations);
  if (allocations === null) throw new TreatmentError('invalid_allocation');
  const total = allocations.reduce((sum, a) => sum + a.shareBp, 0);
  if (total > WHOLE_BP) throw new TreatmentError('allocation_exceeds_whole');
  if (total === 0) throw new TreatmentError('nothing_allocated');

  const share = (purposes: Purpose[]) => allocations.filter((a) => purposes.includes(a.purpose)).reduce((s, a) => s + a.shareBp, 0);
  const needsFormLine = share(['business']) > 0;
  const needsEmploymentLine = share(['study', 'employment']) > 0;

  let formLineKey: FormLineKey | null = null;
  if (needsFormLine) {
    if (input.formLineKey === null || input.formLineKey === undefined || input.formLineKey === '') {
      throw new TreatmentError('form_line_required');
    }
    if (!isFormLineKey(input.formLineKey)) throw new TreatmentError('form_line_invalid');
    const def = rules.formLines.find((l) => l.key === input.formLineKey);
    // Lines the asset register fills (depreciation, pool, remaining book
    // value) cannot be chosen by hand either.
    if (!def || def.form !== 'euer' || def.kind !== 'expense' || def.key === 'euer.meals' || def.assetOnly) {
      throw new TreatmentError('form_line_invalid');
    }
    formLineKey = def.key;
  }

  let employmentLineKey: FormLineKey | null = null;
  if (needsEmploymentLine) {
    if (input.employmentLineKey === null || input.employmentLineKey === undefined || input.employmentLineKey === '') {
      throw new TreatmentError('employment_line_required');
    }
    if (!isFormLineKey(input.employmentLineKey)) throw new TreatmentError('employment_line_invalid');
    const def = rules.formLines.find((l) => l.key === input.employmentLineKey);
    if (!def || def.form !== 'employment') throw new TreatmentError('employment_line_invalid');
    employmentLineKey = def.key;
  }

  const severalLowValueItems = formLineKey === 'euer.low_value_assets' && input.severalLowValueItems === true;
  return { allocations, formLineKey, employmentLineKey, severalLowValueItems };
}

export function sameTreatment(a: TreatmentInput, b: TreatmentInput): boolean {
  return (
    a.formLineKey === b.formLineKey &&
    a.employmentLineKey === b.employmentLineKey &&
    (a.severalLowValueItems ?? false) === (b.severalLowValueItems ?? false) &&
    a.allocations.length === b.allocations.length &&
    a.allocations.every((x, i) => x.purpose === b.allocations[i].purpose && x.shareBp === b.allocations[i].shareBp)
  );
}

/**
 * The key a vendor is recognized by: lower case, accents and punctuation
 * dropped, legal form suffixes removed, so "Netzwerk Nord GmbH" and
 * "NETZWERK NORD" are one vendor. Null when nothing usable is left.
 */
export function vendorKey(vendor: string | null | undefined): string | null {
  if (!vendor) return null;
  const key = vendor
    .toLowerCase()
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\b(gmbh|ug|ag|kg|ohg|gbr|ev|e v|inc|llc|ltd|limited|sarl|bv|co|corp|corporation|pbc|haftungsbeschraenkt)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return key.length >= 2 ? key : null;
}

export interface VendorRule extends TreatmentInput {
  id: string;
  vendorKey: string;
  vendorLabel: string;
  /** ISO day, or '' for "from the beginning". */
  effectiveFrom: string;
}

/**
 * The rule entry in force for a vendor on a day: the latest entry that starts
 * on or before it. An item without a date only matches an entry that applies
 * from the beginning.
 */
export function ruleInForce(rules: readonly VendorRule[], key: string | null, day: string | null): VendorRule | null {
  if (!key) return null;
  let best: VendorRule | null = null;
  for (const rule of rules) {
    if (rule.vendorKey !== key) continue;
    if (rule.effectiveFrom !== '' && (day === null || rule.effectiveFrom > day)) continue;
    if (best === null || rule.effectiveFrom > best.effectiveFrom) best = rule;
  }
  return best;
}

export function isIsoDay(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
