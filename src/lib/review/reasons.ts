/**
 * Why a receipt needs a person's eye, as plain rules on plain data.
 *
 * Two kinds of reasons:
 *  - what the reader recorded when it read the receipt and could not settle
 *    (stored as flags, see the ReceiptReview model), and
 *  - what can be seen on the receipt as it is stored now (no amount, no date,
 *    a tax rate no receipt carries, another receipt that looks the same).
 *
 * The second kind is worked out on read. A receipt stored before this module
 * existed, or changed by hand since, is therefore judged exactly like one
 * uploaded today, and a reason ends the moment the receipt is completed.
 */

/** Doubts recorded at reading time. A person can confirm them away ("Geprüft"). */
export const READ_FLAGS = ['not_classified', 'page_not_read', 'several_documents', 'total_unconfirmed', 'total_conflict', 'date_conflict', 'category_doubt', 'einvoice_problem', 'credit_note', 'currency_unknown', 'image_only'] as const;
export type ReadFlag = (typeof READ_FLAGS)[number];

export type ReviewReason =
  | ReadFlag
  /** A file is attached but no text could be recognized on it. */
  | 'read_failed'
  | 'amount_missing'
  | 'date_missing'
  | 'vendor_missing'
  /** Nobody has said who bears the cost: business, university or private. */
  | 'assignment_missing'
  /** A tax rate outside anything a receipt can carry, or a net amount above the total. */
  | 'tax_implausible'
  /** Another receipt of the same day and total from the same vendor, where one of the two has no invoice number. */
  | 'possible_duplicate'
  /** The current reader reads the stored text differently than what is stored. */
  | 'reading_differs'
  /** The receipt's lines do not add up to its total (more than two cents apart). */
  | 'lines_differ';

export function isReadFlag(value: unknown): value is ReadFlag {
  return typeof value === 'string' && (READ_FLAGS as readonly string[]).includes(value);
}

/** One receipt, reduced to what the rules look at. */
export interface ReviewSnapshot {
  rowId: string;
  name: string;
  vendor: string;
  /** ISO day, or null. */
  date: string | null;
  gross: number | null;
  net: number | null;
  taxRate: number | null;
  currency: string;
  /** True when recognized text is stored for the receipt. */
  hasText: boolean;
  /** True when a file is attached. */
  hasFile: boolean;
  /** Content hashes of the attached files, where known. */
  fileHashes: string[];
  /**
   * The compared form of the receipt's invoice number (`invoiceNumberKey`), null when it has none or only a
   * weak one. Left out where the caller does not know it: the receipt then counts as one without a number.
   */
  invoiceKey?: string | null;
  /**
   * The assignment ("Zuordnung") as stored, null when its cell is empty.
   * Left out when the table has no such column: there is nothing to answer.
   */
  assignment?: string | null;
  /**
   * True when something else already says who bears the cost, so that the tax
   * side never looks at the assignment: the meal register (a business meal),
   * a tax decision on the receipt or on each of its lines, a rule for its vendor.
   */
  assignmentSettled?: boolean;
  /**
   * True when payments linked to the receipt cover its whole total (in euros,
   * at the receipt's exchange rate where it is in another currency). A total a
   * payment bears out needs no "Betrag prüfen".
   */
  totalPaid?: boolean;
  /** True for a credit note whose invoice is not linked among the receipts (see src/lib/receipt-references.ts). */
  creditNoteUnlinked?: boolean;
  /** True when the receipt's lines miss its total by more than the tolerance (src/lib/line-items/lines.ts, `checkLines`). */
  linesDiffer?: boolean;
  /** When the lines were read: a confirmation given before that says nothing about them. */
  linesReadAt?: Date | string | null;
}

/** No tax rate of a real receipt is above this (the highest standard rate in the European Union is 27 percent). */
const HIGHEST_REAL_RATE = 27;

/** The reasons that follow from the stored receipt alone. */
export function derivedReasons(s: ReviewSnapshot): ReviewReason[] {
  // A photo nothing could be read from: the missing fields are the consequence, not three more findings.
  if (s.hasFile && !s.hasText && s.gross === null && !s.date) return ['read_failed'];
  const out: ReviewReason[] = [];
  // A credit note is stored with a negative amount: money back, not a missing one.
  if (s.gross === null || s.gross === 0 || !Number.isFinite(s.gross)) out.push('amount_missing');
  if (!s.date) out.push('date_missing');
  if (!s.vendor.trim()) out.push('vendor_missing');
  // An empty assignment is an open check on the tax side (legacyAllocations
  // returns null for it). It is one here too, so that it is answered where
  // receipts are looked at and not first found in the statement.
  if (s.assignment === null && !s.assignmentSettled) out.push('assignment_missing');
  const rateOff = s.taxRate !== null && (s.taxRate < 0 || s.taxRate > HIGHEST_REAL_RATE);
  // The net is never larger than the total in amount, also on a credit note (both negative).
  const netOff = s.net !== null && s.gross !== null && s.gross !== 0 && (Math.sign(s.net) === -Math.sign(s.gross) || Math.abs(s.net) > Math.abs(s.gross) + 0.005);
  if (rateOff || netOff) out.push('tax_implausible');
  return out;
}

const vendorKey = (vendor: string) => vendor.toLocaleLowerCase('de-DE').replace(/[^\p{L}\p{N}]+/gu, '');

/** Two vendor readings that can be the same business: equal, one inside the other, or one of them missing. */
export function sameVendor(a: string, b: string): boolean {
  const x = vendorKey(a);
  const y = vendorKey(b);
  if (!x || !y) return true;
  return x === y || (x.length >= 4 && y.includes(x)) || (y.length >= 4 && x.includes(y));
}

type InvoiceFacts = Pick<ReviewSnapshot, 'vendor' | 'gross' | 'invoiceKey'>;

/**
 * True when two receipts are the same invoice (plan docs/plans/2026-10-29-invoice-number-duplicates.md,
 * decision 2): both carry an invoice number, the numbers are equal in their compared form, and the vendors
 * can be the same business. A credit note is never the same invoice as the invoice it corrects (its text
 * names that invoice's number): totals of opposite sign are two documents.
 */
export function sameInvoice(a: InvoiceFacts, b: InvoiceFacts): boolean {
  if (!a.invoiceKey || !b.invoiceKey || a.invoiceKey !== b.invoiceKey) return false;
  if (a.gross !== null && b.gross !== null && a.gross !== 0 && b.gross !== 0 && Math.sign(a.gross) !== Math.sign(b.gross)) return false;
  return sameVendor(a.vendor, b.vendor);
}

/** True when both receipts hold a file with the same content: identical file, same receipt (decision 5). */
export function sameFile(a: Pick<ReviewSnapshot, 'fileHashes'>, b: Pick<ReviewSnapshot, 'fileHashes'>): boolean {
  return a.fileHashes.some((hash) => b.fileHashes.includes(hash));
}

export type AutomaticDuplicate = 'same_file' | 'same_invoice';

/** Why two receipts are one without anybody being asked; null when they are not, or a person said they are different. */
export function automaticDuplicate(a: ReviewSnapshot, b: ReviewSnapshot, distinct: ReadonlyMap<string, ReadonlySet<string>>): AutomaticDuplicate | null {
  if (a.rowId === b.rowId || distinct.get(a.rowId)?.has(b.rowId) || distinct.get(b.rowId)?.has(a.rowId)) return null;
  if (sameFile(a, b)) return 'same_file';
  return sameInvoice(a, b) ? 'same_invoice' : null;
}

/**
 * For every receipt, the other receipts that MAY be the same purchase and need a person's word: the same
 * day and total from a vendor that can be the same, where at least one of the two has no invoice number.
 * Never a pair the app settles itself: the same file or the same invoice is merged automatically
 * (`src/lib/review/merge.ts`), and two different invoice numbers are two invoices. `distinct` holds the
 * pairs a person has already said are different.
 */
export function lookAlikes(
  snapshots: ReviewSnapshot[],
  distinct: ReadonlyMap<string, ReadonlySet<string>>,
): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const add = (a: string, b: string) => {
    if (a === b || distinct.get(a)?.has(b) || distinct.get(b)?.has(a)) return;
    const list = out.get(a) ?? [];
    if (!list.includes(b)) out.set(a, [...list, b]);
  };

  const byDayAndTotal = new Map<string, ReviewSnapshot[]>();
  for (const s of snapshots) {
    if (s.date && s.gross !== null && s.gross !== 0) {
      const key = `${s.date}|${Math.round(s.gross * 100)}|${s.currency}`;
      byDayAndTotal.set(key, [...(byDayAndTotal.get(key) ?? []), s]);
    }
  }
  for (const group of byDayAndTotal.values()) {
    for (const a of group) {
      for (const b of group) {
        if (a === b || !sameVendor(a.vendor, b.vendor)) continue;
        // Both numbered: the numbers decide, never a person (decisions 2 and 3).
        if (a.invoiceKey && b.invoiceKey) continue;
        // The same file is merged by the app, not asked about (decision 5).
        if (sameFile(a, b)) continue;
        add(a.rowId, b.rowId);
      }
    }
  }
  return out;
}

export interface StoredReview {
  flags: string[];
  checkedAt: Date | string | null;
  /** The total the reader read when it recorded the flags, in cents; null for a review recorded before it was kept. */
  readGrossCents?: number | null;
}

/** How far a payment in euros may be from a total in another currency at its exchange rate: the card's conversion spread. */
const FX_SPREAD = 0.03;

/**
 * True when the payments linked to a receipt cover its whole total: to the
 * cent in euros; in another currency, the total at the receipt's exchange
 * rate (euros per unit) within the conversion spread of a card payment.
 * Never without a total, or in another currency without a rate.
 */
export function paymentsCoverTotal(paidCents: number, receipt: { gross: number | null; currency: string; fxRate: number | null }): boolean {
  if (receipt.gross === null || !(receipt.gross > 0) || !(paidCents > 0)) return false;
  if (receipt.currency === 'EUR') return paidCents === Math.round(receipt.gross * 100);
  if (receipt.fxRate === null || !(receipt.fxRate > 0)) return false;
  const expected = receipt.gross * receipt.fxRate * 100;
  return Math.abs(paidCents - expected) <= expected * FX_SPREAD;
}

/**
 * True when the doubts about the total are settled without a person
 * confirming them: the stored total was corrected since the reading (it
 * differs from the total the reader recorded its doubt about), or payments
 * linked to the receipt bear it out.
 */
export function totalSettled(snapshot: Pick<ReviewSnapshot, 'gross' | 'totalPaid'>, stored: StoredReview | undefined): boolean {
  if (snapshot.totalPaid) return true;
  const read = stored?.readGrossCents;
  return read !== null && read !== undefined && snapshot.gross !== null && Math.round(snapshot.gross * 100) !== read;
}

/** Everything that currently asks for a look at one receipt, most serious first. */
export function reviewReasons(
  snapshot: ReviewSnapshot,
  stored: StoredReview | undefined,
  duplicates: readonly string[],
  /** True when a new reading of the stored text differs from what is stored. */
  readingDiffers = false,
): ReviewReason[] {
  const derived = derivedReasons(snapshot);
  if (derived.includes('read_failed')) return ['read_failed'];
  // In the order of READ_FLAGS, whatever order they were recorded in.
  // "Credit note without its invoice" is worked out from the link, not stored: it ends when the
  // invoice arrives and comes back when it is deleted. A person can still confirm it away.
  const recorded = !stored?.checkedAt ? [...(stored?.flags ?? []).filter((f) => f !== 'credit_note'), ...(snapshot.creditNoteUnlinked ? ['credit_note'] : [])] : [];
  const flags = READ_FLAGS.filter((f) => recorded.includes(f));
  // A doubt about the total is moot once there is no total at all, and ends
  // once the total was corrected or payments bear it out.
  const totalDoubtEnds = derived.includes('amount_missing') || totalSettled(snapshot, stored);
  // A reading from the image alone is settled by a person, or by payments that cover its total; never by an edit.
  const kept = flags.filter((f) => !(totalDoubtEnds && (f === 'total_unconfirmed' || f === 'total_conflict')) && !(f === 'image_only' && snapshot.totalPaid));
  // A person who confirmed the receipt has seen it as it is: the offer is not repeated.
  const offer = readingDiffers && !stored?.checkedAt;
  // Lines that miss the total are worked out on read (a corrected total ends it at once). A person who
  // confirmed the receipt has seen them: a café bill whose tip is not printed as a line never adds up.
  const confirmedAfterLines = Boolean(stored?.checkedAt) && (!snapshot.linesReadAt || new Date(stored!.checkedAt!).getTime() >= new Date(snapshot.linesReadAt).getTime());
  const linesOff = Boolean(snapshot.linesDiffer) && !confirmedAfterLines && !derived.includes('amount_missing');
  return [
    ...derived,
    ...kept,
    ...(offer ? (['reading_differs'] as const) : []),
    ...(linesOff ? (['lines_differ'] as const) : []),
    ...(duplicates.length > 0 ? (['possible_duplicate'] as const) : []),
  ];
}

/** True for the reasons "Geprüft, stimmt so" settles: a recorded doubt, or an offered new reading. */
export function isConfirmable(reason: ReviewReason): boolean {
  return isReadFlag(reason) || reason === 'reading_differs' || reason === 'lines_differ';
}

/** What a reason means, for the person who has to act on it. */
export const REASON_TEXT: Record<ReviewReason, string> = {
  read_failed: 'Nicht lesbar: Auf dem Bild wurde kein Text erkannt.',
  amount_missing: 'Betrag fehlt.',
  date_missing: 'Datum fehlt.',
  vendor_missing: 'Händler fehlt.',
  assignment_missing: 'Zuordnung fehlt: geschäftlich, Universität oder privat?',
  tax_implausible: 'Steuersatz oder Nettobetrag passt nicht zum Gesamtbetrag.',
  not_classified: 'Nicht automatisch eingeordnet: Kategorie und Zuordnung bitte prüfen.',
  several_documents: 'Die Datei enthält mehr als einen Beleg, gelesen wurde nur einer: bitte die Datei aufteilen und jeden Beleg einzeln hochladen.',
  einvoice_problem: 'Die elektronische Rechnung rechnet nicht auf: Summen, Steuer oder Gruppen der XML-Daten passen nicht zusammen. Bitte mit der Rechnung vergleichen.',
  currency_unknown: 'Die elektronische Rechnung ist in einer Währung, die die App nicht führt: Die Beträge bleiben leer, die Zahlen stehen im erkannten Text. Bitte Betrag und Währung eintragen, bei einer Gutschrift als negativen Betrag.',
  credit_note: 'Gutschrift (elektronisch): Geld zurück, als negativer Betrag gebucht. Die Rechnung, die sie korrigiert, ist unter den Belegen nicht eindeutig gefunden, oder die Gutschrift nennt keine. Sobald die Rechnung hochgeladen ist, wird sie zugeordnet.',
  page_not_read: 'Nur aus dem erkannten Text gelesen: Die Seite selbst konnte dem Sprachmodell nicht gezeigt werden. Beträge und Datum bitte prüfen.',
  image_only: 'Unbestätigt, nur aus dem Bild gelesen: Auf dem Beleg wurde kein Text erkannt, Datum, Betrag und Währung hat das Sprachmodell vom Bild abgelesen. Bitte mit dem Beleg vergleichen.',
  total_unconfirmed: 'Gesamtbetrag nur vom Etikett gelesen, ohne Gegenprobe über die Steuerzeilen.',
  total_conflict: 'Zwei Lesarten des Gesamtbetrags widersprechen sich.',
  date_conflict: 'Das Rechnungsdatum ist nicht gesichert: Zwei Lesarten widersprechen sich, oder das Datum steht nicht im erkannten Text.',
  category_doubt: 'Sieht nach einer Bewirtung aus, wurde aber anders eingeordnet.',
  possible_duplicate: 'Mögliches Duplikat: gleicher Tag, gleicher Betrag, und einem der beiden Belege fehlt die Rechnungsnummer. Steht sie auf dem Beleg, genügt es, sie einzutragen: Belege mit gleicher Nummer führt die App selbst zusammen.',
  reading_differs: 'Der Beleg wurde mit einem älteren Leser erfasst. Die neue Lesart weicht ab.',
  lines_differ: 'Die Positionen ergeben nicht den Gesamtbetrag: Betrag prüfen, oder den Beleg mit „Seite neu lesen“ neu lesen. Gezählt wird der Gesamtbetrag.',
};
