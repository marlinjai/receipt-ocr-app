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
export const READ_FLAGS = ['not_classified', 'total_unconfirmed', 'total_conflict', 'category_doubt'] as const;
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
  /** Another receipt of the same day and total from the same vendor. */
  | 'possible_duplicate'
  /** The current reader reads the stored text differently than what is stored. */
  | 'reading_differs';

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
}

/** No tax rate of a real receipt is above this (the highest standard rate in the European Union is 27 percent). */
const HIGHEST_REAL_RATE = 27;

/** The reasons that follow from the stored receipt alone. */
export function derivedReasons(s: ReviewSnapshot): ReviewReason[] {
  // A photo nothing could be read from: the missing fields are the consequence, not three more findings.
  if (s.hasFile && !s.hasText && s.gross === null && !s.date) return ['read_failed'];
  const out: ReviewReason[] = [];
  if (s.gross === null || !(s.gross > 0)) out.push('amount_missing');
  if (!s.date) out.push('date_missing');
  if (!s.vendor.trim()) out.push('vendor_missing');
  // An empty assignment is an open check on the tax side (legacyAllocations
  // returns null for it). It is one here too, so that it is answered where
  // receipts are looked at and not first found in the statement.
  if (s.assignment === null && !s.assignmentSettled) out.push('assignment_missing');
  const rateOff = s.taxRate !== null && (s.taxRate < 0 || s.taxRate > HIGHEST_REAL_RATE);
  const netOff = s.net !== null && s.gross !== null && s.gross > 0 && s.net > s.gross + 0.005;
  if (rateOff || netOff) out.push('tax_implausible');
  return out;
}

const vendorKey = (vendor: string) => vendor.toLocaleLowerCase('de-DE').replace(/[^\p{L}\p{N}]+/gu, '');

/** Two vendor readings that can be the same business: equal, one inside the other, or one of them missing. */
function sameVendor(a: string, b: string): boolean {
  const x = vendorKey(a);
  const y = vendorKey(b);
  if (!x || !y) return true;
  return x === y || (x.length >= 4 && y.includes(x)) || (y.length >= 4 && x.includes(y));
}

/**
 * For every receipt, the other receipts that look like the same purchase:
 * the very same file, or the same day and total from a vendor that can be the
 * same. `distinct` holds the pairs a person has already said are different.
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

  const byHash = new Map<string, string[]>();
  const byDayAndTotal = new Map<string, ReviewSnapshot[]>();
  for (const s of snapshots) {
    for (const hash of s.fileHashes) byHash.set(hash, [...(byHash.get(hash) ?? []), s.rowId]);
    if (s.date && s.gross !== null && s.gross > 0) {
      const key = `${s.date}|${Math.round(s.gross * 100)}|${s.currency}`;
      byDayAndTotal.set(key, [...(byDayAndTotal.get(key) ?? []), s]);
    }
  }
  for (const rowIds of byHash.values()) {
    for (const a of rowIds) for (const b of rowIds) add(a, b);
  }
  for (const group of byDayAndTotal.values()) {
    for (const a of group) for (const b of group) if (a !== b && sameVendor(a.vendor, b.vendor)) add(a.rowId, b.rowId);
  }
  return out;
}

export interface StoredReview {
  flags: string[];
  checkedAt: Date | string | null;
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
  const recorded = stored && !stored.checkedAt ? stored.flags : [];
  const flags = READ_FLAGS.filter((f) => recorded.includes(f));
  // A doubt about the total is moot once there is no total at all.
  const kept = flags.filter((f) => !(derived.includes('amount_missing') && (f === 'total_unconfirmed' || f === 'total_conflict')));
  // A person who confirmed the receipt has seen it as it is: the offer is not repeated.
  const offer = readingDiffers && !stored?.checkedAt;
  return [
    ...derived,
    ...kept,
    ...(offer ? (['reading_differs'] as const) : []),
    ...(duplicates.length > 0 ? (['possible_duplicate'] as const) : []),
  ];
}

/** True for the reasons "Geprüft, stimmt so" settles: a recorded doubt, or an offered new reading. */
export function isConfirmable(reason: ReviewReason): boolean {
  return isReadFlag(reason) || reason === 'reading_differs';
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
  total_unconfirmed: 'Gesamtbetrag nur vom Etikett gelesen, ohne Gegenprobe über die Steuerzeilen.',
  total_conflict: 'Zwei Lesarten des Gesamtbetrags widersprechen sich.',
  category_doubt: 'Sieht nach einer Bewirtung aus, wurde aber anders eingeordnet.',
  possible_duplicate: 'Mögliches Duplikat: gleicher Tag, gleicher Betrag.',
  reading_differs: 'Der Beleg wurde mit einem älteren Leser erfasst. Die neue Lesart weicht ab.',
};
