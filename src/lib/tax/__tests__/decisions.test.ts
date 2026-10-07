import { describe, expect, it } from 'vitest';
import {
  TreatmentError,
  isIsoDay,
  parseAllocations,
  ruleInForce,
  sameTreatment,
  validateTreatment,
  vendorKey,
  type VendorRule,
} from '../decisions';
import { rulesForYear } from '../rules';

const rules = rulesForYear(2025).rules;
const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return e instanceof TreatmentError ? e.code : `unexpected: ${String(e)}`;
  }
  return 'no error';
};

describe('validateTreatment', () => {
  it('accepts business plus study and keeps both lines', () => {
    expect(
      validateTreatment(
        {
          allocations: [{ purpose: 'study', shareBp: 3000 }, { purpose: 'business', shareBp: 5000 }],
          formLineKey: 'euer.telecom',
          employmentLineKey: 'employment.study_costs',
        },
        rules,
      ),
    ).toEqual({
      // Stored in a fixed order, whatever order they were entered in.
      allocations: [{ purpose: 'business', shareBp: 5000 }, { purpose: 'study', shareBp: 3000 }],
      formLineKey: 'euer.telecom',
      employmentLineKey: 'employment.study_costs',
    });
  });

  it('drops a line that no share points at', () => {
    expect(
      validateTreatment(
        { allocations: [{ purpose: 'private', shareBp: 10000 }], formLineKey: 'euer.telecom', employmentLineKey: 'employment.study_costs' },
        rules,
      ),
    ).toEqual({ allocations: [{ purpose: 'private', shareBp: 10000 }], formLineKey: null, employmentLineKey: null });
  });

  it.each([
    ['not a list', { allocations: 'half' }, 'invalid_allocation'],
    ['an unknown purpose', { allocations: [{ purpose: 'hobby', shareBp: 100 }] }, 'invalid_allocation'],
    ['a fractional share', { allocations: [{ purpose: 'business', shareBp: 12.5 }] }, 'invalid_allocation'],
    ['a negative share', { allocations: [{ purpose: 'business', shareBp: -1 }] }, 'invalid_allocation'],
    ['more than the whole', { allocations: [{ purpose: 'business', shareBp: 7000 }, { purpose: 'study', shareBp: 3001 }] }, 'allocation_exceeds_whole'],
    ['nothing at all', { allocations: [] }, 'nothing_allocated'],
    ['a business share without a line', { allocations: [{ purpose: 'business', shareBp: 10000 }] }, 'form_line_required'],
    ['an unknown line', { allocations: [{ purpose: 'business', shareBp: 10000 }], formLineKey: 'euer.nonsense' }, 'form_line_invalid'],
    ['a revenue line for an expense', { allocations: [{ purpose: 'business', shareBp: 10000 }], formLineKey: 'euer.revenue_small_business' }, 'form_line_invalid'],
    ['the meal line chosen by hand', { allocations: [{ purpose: 'business', shareBp: 10000 }], formLineKey: 'euer.meals' }, 'form_line_invalid'],
    ['an annex line as statement line', { allocations: [{ purpose: 'business', shareBp: 10000 }], formLineKey: 'employment.study_costs' }, 'form_line_invalid'],
    ['a study share without an annex line', { allocations: [{ purpose: 'study', shareBp: 3000 }] }, 'employment_line_required'],
    ['a statement line as annex line', { allocations: [{ purpose: 'study', shareBp: 3000 }], employmentLineKey: 'euer.telecom' }, 'employment_line_invalid'],
  ])('rejects %s', (_name, input, expected) => {
    expect(code(() => validateTreatment(input, rules))).toBe(expected);
  });

  it('rejects null and garbage without throwing anything else', () => {
    expect(code(() => validateTreatment(null, rules))).toBe('invalid_allocation');
    expect(code(() => validateTreatment('x', rules))).toBe('invalid_allocation');
  });
});

describe('parseAllocations', () => {
  it('merges repeated purposes and drops zero shares', () => {
    expect(
      parseAllocations([
        { purpose: 'business', shareBp: 2000 },
        { purpose: 'business', shareBp: 3000 },
        { purpose: 'study', shareBp: 0 },
      ]),
    ).toEqual([{ purpose: 'business', shareBp: 5000 }]);
  });
});

describe('sameTreatment', () => {
  it('compares normalized treatments', () => {
    const a = validateTreatment({ allocations: [{ purpose: 'business', shareBp: 5000 }], formLineKey: 'euer.telecom' }, rules);
    const b = validateTreatment({ allocations: [{ purpose: 'business', shareBp: 5000 }], formLineKey: 'euer.telecom' }, rules);
    const c = validateTreatment({ allocations: [{ purpose: 'business', shareBp: 6000 }], formLineKey: 'euer.telecom' }, rules);
    expect(sameTreatment(a, b)).toBe(true);
    expect(sameTreatment(a, c)).toBe(false);
  });
});

describe('vendorKey', () => {
  it('recognizes one vendor under several spellings', () => {
    expect(vendorKey('Netzwerk Nord GmbH')).toBe('netzwerk nord');
    expect(vendorKey('NETZWERK NORD')).toBe('netzwerk nord');
    expect(vendorKey('  Netzwerk-Nord, Inc. ')).toBe('netzwerk nord');
    expect(vendorKey('Bücher Müller UG (haftungsbeschränkt)')).toBe('buecher mueller');
  });

  it('has no key for nothing', () => {
    expect(vendorKey(null)).toBeNull();
    expect(vendorKey('  ')).toBeNull();
    expect(vendorKey('GmbH')).toBeNull();
  });
});

describe('ruleInForce', () => {
  const rule = (id: string, effectiveFrom: string, key = 'netzwerk nord'): VendorRule => ({
    id,
    vendorKey: key,
    vendorLabel: key,
    effectiveFrom,
    allocations: [{ purpose: 'business', shareBp: 10000 }],
    formLineKey: 'euer.telecom',
    employmentLineKey: null,
  });
  const entries = [rule('always', ''), rule('from-july', '2025-07-01'), rule('other', '', 'anderer laden')];

  it('picks the latest entry on or before the day', () => {
    expect(ruleInForce(entries, 'netzwerk nord', '2025-06-30')?.id).toBe('always');
    expect(ruleInForce(entries, 'netzwerk nord', '2025-07-01')?.id).toBe('from-july');
    expect(ruleInForce(entries, 'netzwerk nord', '2026-01-01')?.id).toBe('from-july');
  });

  it('an item without a date only follows an entry that always applies', () => {
    expect(ruleInForce(entries, 'netzwerk nord', null)?.id).toBe('always');
    expect(ruleInForce([rule('from-july', '2025-07-01')], 'netzwerk nord', null)).toBeNull();
  });

  it('has no rule for an unknown or missing vendor', () => {
    expect(ruleInForce(entries, 'niemand', '2025-07-01')).toBeNull();
    expect(ruleInForce(entries, null, '2025-07-01')).toBeNull();
  });
});

describe('isIsoDay', () => {
  it('accepts real calendar days only', () => {
    expect(isIsoDay('2025-02-28')).toBe(true);
    expect(isIsoDay('2025-02-30')).toBe(false);
    expect(isIsoDay('28.02.2025')).toBe(false);
    expect(isIsoDay(20250228)).toBe(false);
  });
});
