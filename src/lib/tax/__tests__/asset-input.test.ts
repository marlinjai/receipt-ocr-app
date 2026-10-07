import { describe, expect, it } from 'vitest';
import { AssetInputError, validateAssetInput, validateDisposalInput } from '../asset-input';

const base = {
  label: ' Kamera ',
  kind: 'movable',
  acquisitionDate: '2025-03-10',
  method: 'linear',
  usefulLifeMonths: 60,
  decliningRateBp: 3000,
  rowIds: ['r-1', 'r-1', 'r-2'],
};
const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return e instanceof AssetInputError ? e.code : `unexpected: ${String(e)}`;
  }
  return 'no error';
};

describe('validateAssetInput', () => {
  it('normalizes a well formed asset and drops what plays no role for the method', () => {
    expect(validateAssetInput(base)).toEqual({
      label: 'Kamera',
      kind: 'movable',
      acquisitionDate: '2025-03-10',
      method: 'linear',
      usefulLifeMonths: 60,
      decliningRateBp: null,
      businessShareBp: 10000,
      reminderCents: 0,
      opening: null,
      rowIds: ['r-1', 'r-2'],
    });
    expect(validateAssetInput({ ...base, method: 'computer_one_year' })).toMatchObject({ usefulLifeMonths: null, decliningRateBp: null });
  });

  it('accepts an asset carried in from before the app without receipts or date', () => {
    const carried = validateAssetInput({
      label: 'Schreibtisch',
      kind: 'movable',
      method: 'linear',
      reminderCents: 100,
      opening: { year: 2025, bookValueCents: 100, remainingMonths: 0 },
      rowIds: [],
    });
    expect(carried).toMatchObject({ acquisitionDate: null, opening: { year: 2025, bookValueCents: 100, remainingMonths: 0 }, rowIds: [] });
  });

  it.each([
    ['no label', { label: '  ' }, 'label_required'],
    ['a label of 201 characters', { label: 'x'.repeat(201) }, 'label_too_long'],
    ['an unknown kind', { kind: 'building' }, 'invalid_kind'],
    ['an unknown method', { method: 'magic' }, 'invalid_method'],
    ['a date that does not exist', { acquisitionDate: '2025-02-30' }, 'invalid_date'],
    ['no date on a new asset', { acquisitionDate: null }, 'date_required'],
    ['a fractional useful life', { usefulLifeMonths: 60.5 }, 'invalid_useful_life'],
    ['a rate above the whole', { method: 'declining', decliningRateBp: 10001 }, 'invalid_rate'],
    ['a share of zero', { businessShareBp: 0 }, 'invalid_share'],
    ['a reminder above one euro', { reminderCents: 101 }, 'invalid_reminder'],
    ['no receipts on a new asset', { rowIds: [] }, 'receipts_required'],
    ['receipts on a carried-in asset', { opening: { year: 2025, bookValueCents: 100, remainingMonths: 0 } }, 'receipts_and_opening'],
    ['a broken opening', { rowIds: [], opening: { year: 2025, bookValueCents: -1, remainingMonths: 0 } }, 'invalid_opening'],
  ])('rejects %s', (_name, overrides, expected) => {
    expect(code(() => validateAssetInput({ ...base, ...overrides }))).toBe(expected);
  });

  it('rejects null and garbage without throwing anything else', () => {
    expect(code(() => validateAssetInput(null))).toBe('label_required');
    expect(code(() => validateAssetInput('x'))).toBe('label_required');
  });
});

describe('validateDisposalInput', () => {
  it('accepts a sale, a scrapping and a withdrawal', () => {
    expect(validateDisposalInput({ date: '2026-07-01', kind: 'sold', proceedsCents: 90000 })).toEqual({ date: '2026-07-01', kind: 'sold', proceedsCents: 90000 });
    expect(validateDisposalInput({ date: '2026-07-01', kind: 'scrapped' })).toEqual({ date: '2026-07-01', kind: 'scrapped', proceedsCents: 0 });
  });

  it.each([
    ['a bad date', { date: '01.07.2026', kind: 'sold', proceedsCents: 1 }],
    ['an unknown kind', { date: '2026-07-01', kind: 'lost', proceedsCents: 1 }],
    ['negative proceeds', { date: '2026-07-01', kind: 'sold', proceedsCents: -1 }],
    ['proceeds for something scrapped', { date: '2026-07-01', kind: 'scrapped', proceedsCents: 100 }],
  ])('rejects %s', (_name, input) => {
    expect(code(() => validateDisposalInput(input))).toBe('invalid_disposal');
  });
});
