/**
 * Payments as the finance area sees them: one booked movement on one of the
 * owner's accounts, whatever file or interface it came from.
 */

export type PaymentFormat =
  /** The transaction list of the bank interface (Enable Banking), as JSON. */
  | 'enable_banking_json'
  | 'n26_csv'
  | 'tomorrow_csv'
  | 'paypal_csv'
  /** The purchase list of the pay-later service (Klarna), converted to a table from its data extract. */
  | 'klarna_csv';

export const PAYMENT_FORMAT_LABELS: Record<PaymentFormat, string> = {
  enable_banking_json: 'Bankschnittstelle (JSON)',
  n26_csv: 'N26 (CSV)',
  tomorrow_csv: 'Tomorrow (CSV)',
  paypal_csv: 'PayPal (CSV)',
  klarna_csv: 'Klarna-Käufe (CSV)',
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
  | 'own_transfer'
  /** Nothing to do with the business. Only ever set by a person, for one payment. */
  | 'private';

export const PAYMENT_KINDS: readonly PaymentKind[] = ['spend', 'income', 'refund', 'fee', 'own_transfer', 'private'];

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
   * and text) are told apart by their order of appearance. Where the source
   * numbers its movements uniquely (the pay-later list), that number alone is
   * the identity.
   */
  sourceHash: string;
  /** True when `sourceHash` is built from the source's own number alone (see `referenceHash`). */
  byReference?: boolean;
  /** How the purchase was paid, as the pay-later list says; only that list fills it. */
  detail?: PayLaterDetail;
}

/**
 * What the pay-later list says about how one purchase was paid. Stored with
 * the payment (`source_detail`), because the day a purchase counts on for tax
 * depends on it (see `tax-day.ts`).
 */
export interface PayLaterDetail {
  /** The list's `payment_method` as written ("Invoice", "Cards", "Term Loan", "In 30 Tagen zahlen"); '' when empty. */
  method: string;
  /** The list marks a card on the purchase (its `card` column is filled). */
  card: boolean;
  /** The statement the purchase is billed on, when the list names one. */
  statement: string | null;
  /** The service's own number for the purchase, when the list has one. */
  reference: string | null;
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
  /**
   * Identities (`sourceHash`) of purchases the file lists as cancelled or
   * refunded in full. They are not payments of this file; a payment stored by
   * an earlier import under one of them stops counting.
   */
  cancelled: string[];
  /** Rows that were read but need a person's attention, by reason (a part refund the list gives no amount for). */
  notices: Record<string, number>;
  /**
   * Status wordings the reader did not know (the service's wordings are
   * open-ended). Such a row is read as a purchase and named here, so a person
   * looks at it; it is never dropped in silence.
   */
  unknownStatuses: string[];
  /**
   * Payment method wordings of the pay-later list the reader did not know.
   * Such a purchase is read as paid later at the checkout (the cautious
   * reading: it counts on the day the service collects it) and named here.
   */
  unknownMethods: string[];
  firstDay: string | null;
  lastDay: string | null;
}
