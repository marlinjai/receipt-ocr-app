/**
 * Payments as the finance area sees them: one booked movement on one of the
 * owner's accounts, whatever file or interface it came from.
 */

/** How far the payments of a receipt may go beyond its own amount before a person is asked: fees and exchange rates. */
export const OVERPAID_TOLERANCE_PERCENT = 8;

export type PaymentFormat =
  /** The transaction list of the bank interface (Enable Banking), as JSON. */
  | 'enable_banking_json'
  | 'n26_csv'
  | 'tomorrow_csv'
  | 'paypal_csv'
  /** The purchase list of the pay-later service (Klarna), converted to a table from its data extract. */
  | 'klarna_csv'
  /** The monthly statement of the Advanzia credit card ("Gebührenfrei Mastercard Gold"), read from its PDF (see `pdf-text.ts`). */
  | 'advanzia_pdf';

export const PAYMENT_FORMAT_LABELS: Record<PaymentFormat, string> = {
  enable_banking_json: 'Bankschnittstelle (JSON)',
  n26_csv: 'N26 (CSV)',
  tomorrow_csv: 'Tomorrow (CSV)',
  paypal_csv: 'PayPal (CSV)',
  klarna_csv: 'Klarna-Käufe (CSV)',
  advanzia_pdf: 'Advanzia-Mastercard (PDF)',
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
  /**
   * A movement in another currency: what the source states (signed cents of
   * that currency) and the currency. Null or absent for a movement in euro.
   */
  original?: { currency: string; amountCents: number } | null;
  /** True when `amountCents` is the original amount at the reference rate, not what was charged in euro. */
  estimated?: boolean;
  /**
   * Further numbers of the source that name the same movement (the purchase a
   * currency conversion of the PayPal list belongs to). Only used to recognize
   * a movement another source brought; the first is stored as the payment's
   * `relatedReference`, never part of the identity.
   */
  relatedReferences?: string[];
}

/** How a list is read where the content alone cannot say it. */
export interface ParseOptions {
  /**
   * The bank interface's list of a payment service's wallet (PayPal): rows in
   * another currency are read at these reference rates (see `rateKey`) instead
   * of being skipped, and PayPal's transaction code is the identity of every
   * row whose code no other row of the list repeats.
   */
  wallet?: { rates: ReadonlyMap<string, number> };
  /**
   * The text was taken from a PDF (see `pdfText`): only the statements read
   * from a PDF are recognized, and any other PDF is `unknown_pdf`, never
   * guessed at as a table.
   */
  pdf?: boolean;
}

export type ParseErrorCode =
  | 'unknown_layout'
  | 'empty'
  | 'unreadable_row'
  | 'too_large'
  /** The file is no PDF that can be opened (damaged, or protected by a password). */
  | 'unreadable_pdf'
  /** The PDF holds no text, only pictures (a scan): there is nothing to read the movements from. */
  | 'pdf_without_text'
  /** A readable PDF, but not a statement of a known layout. */
  | 'unknown_pdf'
  /** The movements read from a statement do not lead from its old balance to its new one: a row was misread or missed. */
  | 'unbalanced_statement';

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
  firstDay: string | null;
  lastDay: string | null;
}
