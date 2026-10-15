import { describe, expect, it } from 'vitest';
import { RevenueInputError, validateInvoiceInput } from '../revenue-input';

const base = { number: '39', issueDate: '2024-12-30', grossCents: 284_000, treatment: 'small_business', payments: [{ date: '2025-02-11', cents: 283_000 }] };
const code = (raw: unknown) => {
  try {
    validateInvoiceInput(raw);
    return null;
  } catch (error) {
    return error instanceof RevenueInputError ? error.code : 'other';
  }
};

describe('validateInvoiceInput: a part booked out as never to be paid', () => {
  it('defaults to nothing booked out', () => {
    expect(validateInvoiceInput(base)).toMatchObject({ writtenOffCents: 0, writtenOffOn: null });
  });

  it('takes the remainder with its day', () => {
    expect(validateInvoiceInput({ ...base, writtenOffCents: 1_000, writtenOffOn: '2026-10-15' })).toMatchObject({ writtenOffCents: 1_000, writtenOffOn: '2026-10-15' });
  });

  it('drops the day when nothing is booked out', () => {
    expect(validateInvoiceInput({ ...base, writtenOffCents: 0, writtenOffOn: '2026-10-15' }).writtenOffOn).toBeNull();
  });

  it('refuses a write-off without a day, a negative or fractional one, and one above what the payments leave open', () => {
    expect(code({ ...base, writtenOffCents: 1_000 })).toBe('invalid_write_off');
    expect(code({ ...base, writtenOffCents: 1_000, writtenOffOn: '15.10.2026' })).toBe('invalid_write_off');
    expect(code({ ...base, writtenOffCents: -1, writtenOffOn: '2026-10-15' })).toBe('invalid_write_off');
    expect(code({ ...base, writtenOffCents: 10.5, writtenOffOn: '2026-10-15' })).toBe('invalid_write_off');
    expect(code({ ...base, writtenOffCents: 1_001, writtenOffOn: '2026-10-15' })).toBe('invalid_write_off');
  });

  it('refuses a write-off dated before the invoice, and one on an invoice with tax', () => {
    expect(code({ ...base, writtenOffCents: 1_000, writtenOffOn: '2024-12-01' })).toBe('invalid_write_off');
    expect(code({ ...base, treatment: 'standard', vatCents: 45_345, writtenOffCents: 1_000, writtenOffOn: '2026-10-15' })).toBe('invalid_write_off');
  });

  it('refuses a declared year before the invoice existed', () => {
    expect(code({ ...base, declaredInYear: 2023 })).toBe('invalid_year');
    expect(code({ ...base, declaredInYear: 2024 })).toBeNull();
  });

  it('still accepts an overpaid invoice with nothing booked out', () => {
    expect(code({ ...base, payments: [{ date: '2025-02-11', cents: 290_000 }] })).toBeNull();
  });
});
