/**
 * The shape of one year's rule set.
 *
 * Every value that comes from the law or from an official form is a `Sourced`
 * value: it names where it comes from and when a person last checked it. A
 * rule without a source does not get in. Laws change inside a year, so a value
 * may carry a validity range; an item is judged by its own date.
 */

export interface Source {
  /** Statute and paragraph, or the ministry letter, in the words a person would search for. */
  citation: string;
  url: string;
  /** ISO day the value was last compared with the source. */
  checkedOn: string;
}

export interface Sourced<T> {
  value: T;
  source: Source;
  /** ISO days, inclusive. Absent means the whole year. */
  validFrom?: string;
  validTo?: string;
}

/** Which form a line belongs to. */
export type FormId =
  /** Anlage EÜR, the income-surplus statement. */
  | 'euer'
  /** Anlage N, the employment annex of the income tax return. */
  | 'employment';

/**
 * Stable keys for form lines. Code and stored data only ever hold a key; the
 * printed line number and label of a year come from that year's catalog,
 * because the numbers shift between years.
 */
export const FORM_LINE_KEYS = [
  'euer.revenue_small_business',
  'euer.goods',
  'euer.external_services',
  'euer.depreciation_movable',
  'euer.low_value_assets',
  'euer.rent_business_premises',
  'euer.telecom',
  'euer.travel_lodging',
  'euer.training',
  'euer.legal_tax_advice',
  'euer.leasing_movable',
  'euer.maintenance',
  'euer.fees_insurance',
  'euer.it_running',
  'euer.work_equipment',
  'euer.packaging_transport',
  'euer.advertising',
  'euer.other_unlimited',
  'euer.gifts',
  'euer.meals',
  'euer.travel_meal_allowance',
  'euer.home_office_flat',
  'euer.other_travel',
  'employment.work_equipment',
  'employment.study_costs',
  'employment.commute',
  'employment.home_office',
] as const;

export type FormLineKey = (typeof FORM_LINE_KEYS)[number];

export function isFormLineKey(value: unknown): value is FormLineKey {
  return typeof value === 'string' && (FORM_LINE_KEYS as readonly string[]).includes(value);
}

export interface FormLine {
  key: FormLineKey;
  form: FormId;
  /**
   * The line number printed on that year's form. Null when it has not been
   * compared with the official form yet: the app then shows the label alone
   * and says the number is unverified, instead of printing a guess.
   */
  line: number | null;
  /** The German label as printed on the form. */
  label: string;
  kind: 'revenue' | 'expense';
  /**
   * True for lines of the form that have a "not deductible" column beside the
   * deductible one (gifts, business meals).
   */
  limited?: boolean;
}

export interface YearRules {
  year: number;
  /** ISO day a person last went through the whole rule set. */
  reviewedOn: string;
  /** Where the form line catalog comes from. */
  formLinesSource: Source;
  /**
   * False when the line numbers were carried over from another year's form
   * and not yet compared with this year's.
   */
  formLinesVerified: boolean;
  formLines: readonly FormLine[];
  /** The deductible part of a business meal, in basis points. */
  mealDeductibleShareBp: Sourced<number>;
}
