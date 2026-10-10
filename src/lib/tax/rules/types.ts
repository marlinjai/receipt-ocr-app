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
  'euer.revenue_taxable',
  'euer.revenue_not_taxable',
  'euer.vat_received',
  'euer.vat_refunded',
  'euer.input_vat',
  'euer.vat_paid',
  'euer.goods',
  'euer.external_services',
  'euer.asset_disposal',
  'euer.depreciation_intangible',
  'euer.depreciation_movable',
  'euer.low_value_assets',
  'euer.pool_release',
  'euer.remaining_book_value',
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

/**
 * What is known about a line's number on that year's form.
 * - `verified`: compared with the official form; the number is printed.
 * - `unverified`: not compared yet; the app shows the label alone and says so,
 *   instead of printing a guess or another year's number.
 * - `structured`: the form has no single amount field for this (it asks for
 *   days, distances or several entries), so there is no line a euro total could
 *   go on and none is ever printed.
 */
export type LineNumbering = 'verified' | 'unverified' | 'structured';

export interface FormLine {
  key: FormLineKey;
  form: FormId;
  /** The line number printed on that year's form; set only when `numbering` is `verified`. */
  line: number | null;
  numbering: LineNumbering;
  /** For a `structured` line: what the form asks for instead of an amount. */
  structuredNote?: string;
  /** The German label as printed on the form. */
  label: string;
  kind: 'revenue' | 'expense';
  /** True for lines only the asset register may fill: they cannot be chosen for a receipt by hand. */
  assetOnly?: boolean;
  /** True for lines the app fills from invoices, input tax and settlements: never chosen for a receipt by hand. */
  computedOnly?: boolean;
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
  /**
   * Where each form's lines come from. The two forms are published by
   * different documents, so one source for the whole year could not cite both.
   * Null: that form of that year has not been compared with an official source.
   */
  formSources: Record<FormId, Source | null>;
  formLines: readonly FormLine[];
  /** The deductible part of a business meal, in basis points. */
  mealDeductibleShareBp: Sourced<number>;
  assets: AssetRules;
  /**
   * The small-business limits of section 19 of the value-added tax act, both
   * measured by money received: the previous year must not have exceeded the
   * first, the running year must not exceed the second.
   */
  smallBusinessLimits: Sourced<{ previousYearLimitCents: number; currentYearLimitCents: number }>;
}

/** The limits and methods for assets bought in this year. All limits are NET amounts (without value-added tax). */
export interface AssetRules {
  /** Up to this net cost an asset may be expensed in full in the year it is bought. */
  lowValueNetLimitCents: Sourced<number>;
  /** Above this net cost a low-value asset has to be listed in a register. */
  lowValueRegisterAboveNetCents: Sourced<number>;
  /** The pool: net cost above `minExclusive` up to `max`, released in equal parts over `years`. */
  pool: Sourced<{ minExclusiveNetCents: number; maxNetCents: number; years: number }>;
  /**
   * Computer hardware and software: the useful life that may be assumed, and
   * whether the whole cost may be taken in the year of purchase instead of
   * month by month.
   */
  computer: Sourced<{ usefulLifeMonths: number; fullAmountInFirstYear: boolean }>;
  /** Declining-balance depreciation of movable assets: the purchase dates it is open for and its caps. */
  declining: Sourced<{ acquiredFrom: string; acquiredTo: string; maxRateBp: number; maxMultipleOfLinear: number }>;
  /**
   * The highest standard rate of value-added tax in basis points. Used only to
   * decide a net limit from a gross amount when the net amount is unknown: a
   * gross amount above limit times (1 + this rate) is certainly above the limit.
   */
  highestVatRateBp: Sourced<number>;
}
