/**
 * The mailbox port: step 3 of the missing-receipt loop ("is the invoice in the
 * mailbox?"). Invoices are sent to an expenses address (the one in
 * `SPENDING_MAILBOX_ADDRESS`) that delivers into a Google Workspace mailbox;
 * an adapter reads it. The mailbox belongs to exactly one company (the
 * workspace in `SPENDING_MAILBOX_WORKSPACE_ID`): for every other company it is
 * off. The app never sends or changes mail, it only searches and downloads
 * attachments. Until the server holds the mailbox settings, the adapter is off
 * and says so; the loop then goes straight on to asking the owner.
 */

export interface MailSearch {
  /** Words the vendor is known by (the counterparty's normalized name, aliases learned from links). Never empty: without a name there is no search. */
  vendorWords: readonly string[];
  /** ISO days: the window the invoice mail may have arrived in. */
  fromDay: string;
  toDay: string;
  /** The amount paid, in cents, to find in the subject or text. */
  amountCents: number;
}

/** One attachment of one mail that may be the invoice. */
export interface MailCandidate {
  messageId: string;
  /**
   * Which readable attachment of the mail it is (0 for the first). Gmail's own
   * attachment ids change from one read to the next, so the attachment is found
   * again by its place and name when it is downloaded.
   */
  partIndex: number;
  fileName: string;
  mimeType: string;
  /** ISO day the mail arrived. */
  receivedDay: string;
  subject: string;
  /** The sender's address, for the owner to recognize the mail. */
  from: string;
}

export interface MailAttachment {
  bytes: Uint8Array;
  mimeType: string;
  fileName: string;
}

export type MailboxStatus = { configured: true } | { configured: false; missing: string[]; reason?: 'other_company' };

export interface MailboxPort {
  status(): MailboxStatus;
  /** Attachments (PDF or image) of mails in the window that name the vendor and the amount. `signal` ends a search that takes too long. */
  search(query: MailSearch, signal?: AbortSignal): Promise<MailCandidate[]>;
  fetchAttachment(messageId: string, partIndex: number, fileName: string): Promise<MailAttachment>;
}

export class MailboxError extends Error {
  readonly code: 'not_configured' | 'auth_failed' | 'unavailable' | 'not_found' | 'too_large';
  constructor(code: MailboxError['code'], detail = '') {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'MailboxError';
    this.code = code;
  }
}

/** File types the upload path reads. */
export const READABLE_TYPES = ['application/pdf', 'image/jpeg', 'image/png', 'image/heic', 'image/webp'];

/** The largest attachment taken over, in bytes: an invoice is far smaller, anything bigger is no receipt. */
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

/** The window around a payment the invoice mail may have arrived in: two weeks before to three days after. */
export const MAIL_DAYS_BEFORE = 14;
export const MAIL_DAYS_AFTER = 3;

const shiftDay = (day: string, days: number) => new Date(Date.parse(`${day}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

/** The search for one payment; null when it names no vendor (an amount alone finds any mail with that number). */
export function searchFor(payment: { bookingDay: string; amountCents: number }, vendorWords: readonly string[]): MailSearch | null {
  const words = [...new Set(vendorWords.map((w) => w.trim()).filter((w) => w.length >= 2))];
  if (words.length === 0) return null;
  return { vendorWords: words, fromDay: shiftDay(payment.bookingDay, -MAIL_DAYS_BEFORE), toDay: shiftDay(payment.bookingDay, MAIL_DAYS_AFTER), amountCents: Math.abs(payment.amountCents) };
}

/** An adapter for a mailbox that is not set up: every call says so, nothing is pretended. */
export function unconfiguredMailbox(missing: string[], reason?: 'other_company'): MailboxPort {
  return {
    status: () => (reason ? { configured: false, missing, reason } : { configured: false, missing }),
    search: async () => {
      throw new MailboxError('not_configured');
    },
    fetchAttachment: async () => {
      throw new MailboxError('not_configured');
    },
  };
}

const LEGAL_FORMS = /\b(gmbh|ug|ag|kg|ohg|gbr|e\.?\s?v|inc|llc|ltd|limited|sarl|s\.?\s?a\.?\s?r\.?\s?l|s\.?\s?c\.?\s?a|b\.?\s?v|co|corp|corporation|pbc|haftungsbeschr(ä|ae)nkt|et\s+cie|cie)\b\.?/gi;

/**
 * The names a mailbox search uses for a payment: the counterparty as the bank
 * writes it but without its legal form (umlauts kept: an invoice says
 * "Müller", not "mueller"), its first word when it has four or more letters (a bank's
 * long legal name rarely stands word for word in a mail), the normalized key,
 * and the vendors earlier links paired it with.
 */
export function mailWordsFor(counterparty: string, key: string, aliases: Iterable<string> = []): string[] {
  const plain = counterparty.replace(LEGAL_FORMS, ' ').replace(/[^\p{L}\p{N}&+\-' ]+/gu, ' ').replace(/\s+/g, ' ').trim();
  // Only the name's own first word, and only when it is long enough to mean something ("Zyx Handel" gives none).
  const first = plain.split(' ')[0] ?? '';
  const firstWord = /\p{L}{4,}/u.test(first) ? first : '';
  return [...new Set([plain, firstWord, key, ...aliases].map((w) => w.trim()).filter((w) => w.length >= 2))];
}
