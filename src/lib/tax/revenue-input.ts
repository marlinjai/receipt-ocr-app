import { isIsoDay } from './decisions';
import { INVOICE_TREATMENTS, type InvoiceTreatment } from './types';
import type { VatFrequency, VatMethod } from './vat';

/**
 * What a person states about an issued invoice, a status change, the
 * value-added tax settings and a settlement with the tax office, and the
 * checks every write passes. Pure, shared by the forms, the server and tests.
 */

export interface InvoiceInput {
  number: string;
  issueDate: string | null;
  grossCents: number;
  vatCents: number;
  treatment: InvoiceTreatment;
  declaredInYear: number | null;
  payments: Array<{ date: string; cents: number }>;
}

export type RevenueInputErrorCode =
  | 'number_required'
  | 'number_too_long'
  | 'invalid_date'
  | 'invalid_amount'
  | 'invalid_vat'
  | 'vat_without_treatment'
  | 'invalid_treatment'
  | 'invalid_year'
  | 'invalid_payment'
  | 'too_many_payments'
  | 'invalid_status'
  | 'invalid_vat_settings'
  | 'invalid_settlement'
  | 'invalid_expectation';

export class RevenueInputError extends Error {
  readonly code: RevenueInputErrorCode;
  constructor(code: RevenueInputErrorCode) {
    super(code);
    this.name = 'RevenueInputError';
    this.code = code;
  }
}

const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);
/** Amounts are bounded so a typo cannot overflow the integer columns. */
const MAX_CENTS = 1_000_000_000;
const fail = (code: RevenueInputErrorCode): never => {
  throw new RevenueInputError(code);
};

export function validateInvoiceInput(raw: unknown): InvoiceInput {
  const input = (raw ?? {}) as Record<string, unknown>;
  const number = typeof input.number === 'string' ? input.number.trim() : '';
  if (!number) fail('number_required');
  if (number.length > 60) fail('number_too_long');

  const issueDate = input.issueDate === null || input.issueDate === undefined || input.issueDate === '' ? null : input.issueDate;
  if (issueDate !== null && !isIsoDay(issueDate)) fail('invalid_date');

  if (!isInt(input.grossCents) || input.grossCents <= 0 || input.grossCents > MAX_CENTS) fail('invalid_amount');
  const grossCents = input.grossCents as number;

  if (typeof input.treatment !== 'string' || !(INVOICE_TREATMENTS as readonly string[]).includes(input.treatment)) fail('invalid_treatment');
  const treatment = input.treatment as InvoiceTreatment;
  const taxed = treatment === 'standard' || treatment === 'reduced';

  const vat = input.vatCents === undefined || input.vatCents === null ? 0 : input.vatCents;
  if (!isInt(vat) || vat < 0 || vat >= grossCents) fail('invalid_vat');
  // An invoice with tax needs its tax amount; an invoice without tax must not carry one.
  if (taxed && vat === 0) fail('invalid_vat');
  if (!taxed && vat !== 0) fail('vat_without_treatment');

  const declared = input.declaredInYear === undefined || input.declaredInYear === null || input.declaredInYear === '' ? null : input.declaredInYear;
  if (declared !== null && (!isInt(declared) || declared < 1990 || declared > 2100)) fail('invalid_year');

  const rawPayments = Array.isArray(input.payments) ? input.payments : [];
  if (rawPayments.length > 60) fail('too_many_payments');
  const payments = rawPayments.map((p) => {
    const payment = (p ?? {}) as Record<string, unknown>;
    if (!isIsoDay(payment.date) || !isInt(payment.cents) || payment.cents <= 0 || payment.cents > MAX_CENTS) fail('invalid_payment');
    return { date: payment.date as string, cents: payment.cents as number };
  });
  payments.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.cents - b.cents));

  return { number, issueDate: issueDate as string | null, grossCents, vatCents: vat as number, treatment, declaredInYear: declared as number | null, payments };
}

export interface StatusChangeInput {
  effectiveFrom: string;
  smallBusiness: boolean;
}

export function validateStatusChange(raw: unknown): StatusChangeInput {
  const input = (raw ?? {}) as Record<string, unknown>;
  if (!isIsoDay(input.effectiveFrom) || typeof input.smallBusiness !== 'boolean') fail('invalid_status');
  return { effectiveFrom: input.effectiveFrom as string, smallBusiness: input.smallBusiness as boolean };
}

export interface VatSettingsInput {
  frequency: VatFrequency;
  method: VatMethod;
}

export function validateVatSettings(raw: unknown): VatSettingsInput {
  const input = (raw ?? {}) as Record<string, unknown>;
  if ((input.frequency !== 'monthly' && input.frequency !== 'quarterly') || (input.method !== 'issued' && input.method !== 'received')) {
    fail('invalid_vat_settings');
  }
  return { frequency: input.frequency as VatFrequency, method: input.method as VatMethod };
}

export interface SettlementInput {
  date: string;
  cents: number;
  direction: 'paid' | 'refunded';
}

export function validateSettlement(raw: unknown): SettlementInput {
  const input = (raw ?? {}) as Record<string, unknown>;
  if (
    !isIsoDay(input.date) ||
    !isInt(input.cents) || input.cents <= 0 || input.cents > MAX_CENTS ||
    (input.direction !== 'paid' && input.direction !== 'refunded')
  ) {
    fail('invalid_settlement');
  }
  return { date: input.date as string, cents: input.cents as number, direction: input.direction as 'paid' | 'refunded' };
}

/** The owner's expectation of monthly revenue for the forecast; null clears it. */
export function validateExpectation(raw: unknown): number | null {
  if (raw === null || raw === undefined || raw === '') return null;
  if (!isInt(raw) || raw < 0 || raw > MAX_CENTS) fail('invalid_expectation');
  return raw as number;
}
