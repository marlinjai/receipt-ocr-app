/**
 * Payments as the finance area sees them: one booked movement on one of the
 * owner's accounts, whatever file or interface it came from.
 */

export type PaymentFormat =
  /** The transaction list of the bank interface (Enable Banking), as JSON. */
  | 'enable_banking_json'
  | 'n26_csv'
  | 'tomorrow_csv'
  | 'paypal_csv';

export const PAYMENT_FORMAT_LABELS: Record<PaymentFormat, string> = {
  enable_banking_json: 'Bankschnittstelle (JSON)',
  n26_csv: 'N26 (CSV)',
  tomorrow_csv: 'Tomorrow (CSV)',
  paypal_csv: 'PayPal (CSV)',
};

/** What a movement is, as far as the source itself says. A person can override it. */
export type PaymentKind =
  /** Money out for something bought. */
  | 'spend'
  /** Money in. */
  | 'income'
  /** Money back for an earlier spend (a refund, a returned debit). */
  | 'refund'
  /** A bank or service fee. */
  | 'fee'
  /** Moving money between the owner's own accounts, or funding a payment service: neither spend nor income. */
  | 'own_transfer';

export const PAYMENT_KINDS: readonly PaymentKind[] = ['spend', 'income', 'refund', 'fee', 'own_transfer'];

export interface NormalizedPayment {
  /** ISO day the movement was booked. */
  bookingDay: string;
  valueDay: string | null;
  /** Euro cents, signed: negative is money out. */
  amountCents: number;
  /** The other side as the source names it; empty when the source gives none. */
  counterparty: string;
  /** The remittance text or item description. */
  reference: string;
  /** The source's own id for the movement, when it has one. Not unique at every bank. */
  entryReference: string | null;
  kind: PaymentKind;
  /**
   * Identity of the movement within its account, stable across files: the
   * same movement in an overlapping export gets the same hash and is stored
   * once. Two genuinely identical movements (same day, amount, counterparty
   * and text) are told apart by their order of appearance.
   */
  sourceHash: string;
}

export type ParseErrorCode =
  | 'unknown_layout'
  | 'empty'
  | 'unreadable_row'
  | 'too_large';

export class PaymentParseError extends Error {
  readonly code: ParseErrorCode;
  /** 1-based line or entry number of the first row that could not be read. */
  readonly row: number | null;
  constructor(code: ParseErrorCode, row: number | null = null) {
    super(row === null ? code : `${code} at row ${row}`);
    this.name = 'PaymentParseError';
    this.code = code;
    this.row = row;
  }
}

export interface ParsedFile {
  format: PaymentFormat;
  payments: NormalizedPayment[];
  /** Rows of the file that are not booked movements in euro and were left out on purpose, by reason. */
  skipped: Record<string, number>;
  firstDay: string | null;
  lastDay: string | null;
}
