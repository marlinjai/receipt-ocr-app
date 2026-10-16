import { isReturnItemKey, RETURN_ITEM_KINDS, type ReturnItemKey } from './return-items';
import { isFederalState, type FederalState } from './rules';
import { WAGE_FIELDS, type WageFigures } from './wages';

/**
 * What a person states about wages, return items and the church tax months
 * of a year, and the checks every write passes. Pure, shared by the forms,
 * the server and the tests.
 */

export type IncomeTaxInputErrorCode =
  | 'invalid_year'
  | 'employer_required'
  | 'employer_too_long'
  | 'invalid_month'
  | 'invalid_amount'
  | 'wage_tax_above_gross'
  | 'invalid_flag'
  | 'invalid_key'
  | 'invalid_days'
  | 'invalid_distance'
  | 'note_too_long'
  | 'invalid_church_months'
  | 'invalid_federal_state';

export class IncomeTaxInputError extends Error {
  readonly code: IncomeTaxInputErrorCode;
  constructor(code: IncomeTaxInputErrorCode) {
    super(code);
    this.name = 'IncomeTaxInputError';
    this.code = code;
  }
}

const fail = (code: IncomeTaxInputErrorCode): never => {
  throw new IncomeTaxInputError(code);
};
const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);
/** Bounded so a typo cannot overflow the integer columns. */
const MAX_CENTS = 1_000_000_000;

export function validateYear(raw: unknown): number {
  if (!isInt(raw) || raw < 2000 || raw > 2100) fail('invalid_year');
  return raw as number;
}

export interface WageInput extends WageFigures {
  year: number;
  employer: string;
  /** 0: annual wage statement; 1 to 12: pay slip. */
  month: number;
  healthWithSickPay: boolean;
  /** Pay slips only: church tax due in that month. Always null for an annual statement. */
  churchLiable: boolean | null;
}

export function validateWageInput(raw: unknown): WageInput {
  const input = (raw ?? {}) as Record<string, unknown>;
  const year = validateYear(input.year);
  const employer = typeof input.employer === 'string' ? input.employer.trim() : '';
  if (!employer) fail('employer_required');
  if (employer.length > 60) fail('employer_too_long');
  if (!isInt(input.month) || input.month < 0 || input.month > 12) fail('invalid_month');
  const month = input.month as number;
  const figures = {} as WageFigures;
  for (const field of WAGE_FIELDS) {
    const v = input[field] === undefined || input[field] === null ? 0 : input[field];
    if (!isInt(v) || v < 0 || v > MAX_CENTS) fail('invalid_amount');
    figures[field] = v as number;
  }
  if (figures.wageTaxCents > figures.grossCents) fail('wage_tax_above_gross');
  const healthWithSickPay = input.healthWithSickPay === undefined ? true : input.healthWithSickPay;
  if (typeof healthWithSickPay !== 'boolean') fail('invalid_flag');
  const church = input.churchLiable === undefined ? null : input.churchLiable;
  if (church !== null && typeof church !== 'boolean') fail('invalid_flag');
  return {
    year,
    employer,
    month,
    ...figures,
    healthWithSickPay: healthWithSickPay as boolean,
    // An annual statement does not say which months were liable; that is stated for the year.
    churchLiable: month === 0 ? null : (church as boolean | null),
  };
}

export interface ReturnItemInput {
  year: number;
  key: ReturnItemKey;
  amountCents: number | null;
  days: number | null;
  distanceKm: number | null;
  ownCar: boolean;
  note: string | null;
}

export function validateReturnItemInput(raw: unknown): ReturnItemInput {
  const input = (raw ?? {}) as Record<string, unknown>;
  const year = validateYear(input.year);
  if (!isReturnItemKey(input.key)) fail('invalid_key');
  const key = input.key as ReturnItemKey;
  const measure = RETURN_ITEM_KINDS[key].measure;
  const note = typeof input.note === 'string' && input.note.trim() ? input.note.trim() : null;
  if (note !== null && note.length > 200) fail('note_too_long');
  let amountCents: number | null = null;
  let days: number | null = null;
  let distanceKm: number | null = null;
  let ownCar = false;
  if (measure === 'amount') {
    if (!isInt(input.amountCents) || input.amountCents <= 0 || input.amountCents > MAX_CENTS) fail('invalid_amount');
    amountCents = input.amountCents as number;
  } else {
    if (!isInt(input.days) || input.days <= 0 || input.days > 366) fail('invalid_days');
    days = input.days as number;
    if (measure === 'commute') {
      if (!isInt(input.distanceKm) || input.distanceKm <= 0 || input.distanceKm > 1000) fail('invalid_distance');
      distanceKm = input.distanceKm as number;
      if (input.ownCar !== undefined && typeof input.ownCar !== 'boolean') fail('invalid_flag');
      ownCar = input.ownCar === true;
    }
  }
  return { year, key, amountCents, days, distanceKm, ownCar, note };
}

export interface YearSettingsInput {
  year: number;
  /** Twelve flags, January first; null clears the statement. */
  churchMonths: boolean[] | null;
}

export function validateYearSettings(raw: unknown): YearSettingsInput {
  const input = (raw ?? {}) as Record<string, unknown>;
  const year = validateYear(input.year);
  const months = input.churchMonths ?? null;
  if (months !== null && (!Array.isArray(months) || months.length !== 12 || !months.every((m) => typeof m === 'boolean'))) {
    fail('invalid_church_months');
  }
  return { year, churchMonths: months as boolean[] | null };
}

export function validateFederalState(raw: unknown): FederalState | null {
  if (raw === null || raw === undefined || raw === '') return null;
  if (!isFederalState(raw)) fail('invalid_federal_state');
  return raw as FederalState;
}

/** Twelve flags to the stored text ('1' liable, '0' not), and back. */
export function encodeChurchMonths(months: boolean[]): string {
  return months.map((m) => (m ? '1' : '0')).join('');
}

export function decodeChurchMonths(text: string | null): boolean[] | null {
  if (text === null || !/^[01]{12}$/.test(text)) return null;
  return [...text].map((c) => c === '1');
}
