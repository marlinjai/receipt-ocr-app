import { describe, expect, it } from 'vitest';
import {
  IncomeTaxInputError,
  decodeChurchMonths,
  encodeChurchMonths,
  validateFederalState,
  validateReturnItemInput,
  validateWageInput,
  validateYearSettings,
} from '../input';

const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    if (e instanceof IncomeTaxInputError) return e.code;
    throw e;
  }
  return 'no error';
};

const slip = (overrides: Record<string, unknown> = {}) => ({
  year: 2026,
  employer: 'Arbeitgeber',
  month: 3,
  grossCents: 450_000,
  wageTaxCents: 70_000,
  ...overrides,
});

describe('validateWageInput', () => {
  it('accepts a pay slip and fills missing figures with 0', () => {
    const w = validateWageInput(slip({ churchLiable: false }));
    expect(w).toMatchObject({ year: 2026, employer: 'Arbeitgeber', month: 3, grossCents: 450_000, solidarityCents: 0, healthWithSickPay: true, churchLiable: false });
  });

  it('drops a church flag on an annual statement: that is stated for the year', () => {
    expect(validateWageInput(slip({ month: 0, churchLiable: true })).churchLiable).toBeNull();
  });

  it.each([
    [{ employer: '  ' }, 'employer_required'],
    [{ employer: 'x'.repeat(61) }, 'employer_too_long'],
    [{ month: 13 }, 'invalid_month'],
    [{ month: -1 }, 'invalid_month'],
    [{ grossCents: -1 }, 'invalid_amount'],
    [{ grossCents: 1.5 }, 'invalid_amount'],
    [{ wageTaxCents: 500_000 }, 'wage_tax_above_gross'],
    [{ grossCents: 0, wageTaxCents: 1 }, 'wage_tax_above_gross'],
    [{ year: 1999 }, 'invalid_year'],
    [{ churchLiable: 'ja' }, 'invalid_flag'],
    [{ healthWithSickPay: 1 }, 'invalid_flag'],
  ])('refuses %o with %s', (overrides, expected) => {
    expect(code(() => validateWageInput(slip(overrides)))).toBe(expected);
  });
});

describe('validateReturnItemInput', () => {
  it('reads an amount item and ignores days on it', () => {
    expect(validateReturnItemInput({ year: 2025, key: 'special.vocational_training', amountCents: 77_766, days: 4, note: ' Zinsen ' })).toEqual({
      year: 2025,
      key: 'special.vocational_training',
      amountCents: 77_766,
      days: null,
      distanceKm: null,
      ownCar: false,
      note: 'Zinsen',
    });
  });

  it('needs days and a distance for a commute', () => {
    expect(validateReturnItemInput({ year: 2025, key: 'employment.commute', days: 4, distanceKm: 20 })).toMatchObject({ days: 4, distanceKm: 20, amountCents: null, ownCar: false });
    expect(validateReturnItemInput({ year: 2025, key: 'employment.commute', days: 4, distanceKm: 20, ownCar: true }).ownCar).toBe(true);
    expect(code(() => validateReturnItemInput({ year: 2025, key: 'employment.commute', days: 4, distanceKm: 20, ownCar: 'ja' }))).toBe('invalid_flag');
    // Only a commute knows a car.
    expect(validateReturnItemInput({ year: 2025, key: 'employment.home_office_days', days: 4, ownCar: true }).ownCar).toBe(false);
    expect(code(() => validateReturnItemInput({ year: 2025, key: 'employment.commute', days: 4 }))).toBe('invalid_distance');
    expect(code(() => validateReturnItemInput({ year: 2025, key: 'employment.home_office_days', days: 400 }))).toBe('invalid_days');
  });

  it('refuses an unknown key, a zero amount and a long note', () => {
    expect(code(() => validateReturnItemInput({ year: 2025, key: 'children', amountCents: 1 }))).toBe('invalid_key');
    expect(code(() => validateReturnItemInput({ year: 2025, key: 'special.donations', amountCents: 0 }))).toBe('invalid_amount');
    expect(code(() => validateReturnItemInput({ year: 2025, key: 'special.donations', amountCents: 1, note: 'x'.repeat(201) }))).toBe('note_too_long');
  });
});

describe('church months and federal state', () => {
  it('round-trips twelve flags', () => {
    const months = Array.from({ length: 12 }, (_, i) => i < 11);
    expect(encodeChurchMonths(months)).toBe('111111111110');
    expect(decodeChurchMonths('111111111110')).toEqual(months);
    expect(decodeChurchMonths('11')).toBeNull();
    expect(decodeChurchMonths(null)).toBeNull();
  });

  it('accepts twelve flags or null, nothing else', () => {
    expect(validateYearSettings({ year: 2025, churchMonths: null })).toEqual({ year: 2025, churchMonths: null });
    expect(code(() => validateYearSettings({ year: 2025, churchMonths: [true] }))).toBe('invalid_church_months');
    expect(code(() => validateYearSettings({ year: 2025, churchMonths: Array(12).fill('1') }))).toBe('invalid_church_months');
  });

  it('knows the sixteen states', () => {
    expect(validateFederalState('BE')).toBe('BE');
    expect(validateFederalState('')).toBeNull();
    expect(code(() => validateFederalState('XX'))).toBe('invalid_federal_state');
  });
});
