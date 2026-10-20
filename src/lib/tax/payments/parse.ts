import { createHash } from 'node:crypto';
import { PaymentParseError, type NormalizedPayment, type ParsedFile, type PaymentFormat, type PaymentKind } from './types';

/**
 * Readers for the payment files the owner can export. Pure: text in, payments
 * out. A file is read whole or not at all: one row that cannot be read
 * rejects the file with that row's number, so an import is never partial.
 * Rows that are deliberately not payments (pending, declined, other
 * currencies, memo lines) are counted and reported, not silently dropped.
 */

const MAX_BYTES = 8 * 1024 * 1024;
const MAX_AMOUNT_EUR = 10_000_000;

/** Split CSV text into rows of cells: quoted fields, doubled quotes, line breaks inside quotes. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (quoted) {
      if (ch === '"' && body[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && body[i + 1] === '\n') i++;
      row.push(cell);
      cell = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else cell += ch;
  }
  row.push(cell);
  if (row.length > 1 || row[0] !== '') rows.push(row);
  return rows;
}

/** `YYYY-MM-DD` or `DD.MM.YYYY` to an ISO day; null when it is neither, no real day, or not text at all. */
export function toIsoDay(value: unknown): string | null {
  // A source may send a number or an object where a day belongs: that is no day, never a crash.
  if (typeof value !== 'string') return null;
  const text = value.trim();
  let iso: string | null = null;
  const direct = /^(\d{4})-(\d{2})-(\d{2})/.exec(text);
  const german = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(text);
  if (direct) iso = `${direct[1]}-${direct[2]}-${direct[3]}`;
  else if (german) iso = `${german[3]}-${german[2]}-${german[1]}`;
  if (!iso) return null;
  const date = new Date(`${iso}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === iso ? iso : null;
}

/**
 * A signed amount to cents. With a comma it is read the German way ("-1.234,56");
 * without one a point is the decimal sign ("-1234.56", "9.9"). Null when it is no amount.
 */
export function toCents(value: string | null | undefined): number | null {
  const text = (value ?? '').trim().replace(/\s/g, '');
  if (!text) return null;
  let normalized: string;
  if (text.includes(',')) {
    // German: points group thousands in threes, the comma is the decimal sign.
    // Anything else with a comma ("1,234.56") is not guessed at.
    if (!/^[+-]?(\d{1,3}(\.\d{3})+|\d+)(,\d{1,2})?$/.test(text)) return null;
    normalized = text.replace(/\./g, '').replace(',', '.');
  } else {
    // A point is the decimal sign, with at most two decimals: "1.234" is not read as 1.23.
    if (!/^[+-]?\d+(\.\d{1,2})?$/.test(text)) return null;
    normalized = text;
  }
  const n = Number(normalized);
  // No export holds a single movement of ten million euros; such a value is a misread.
  if (!Number.isFinite(n) || Math.abs(n) > MAX_AMOUNT_EUR) return null;
  return Math.sign(n) * Math.round(Math.abs(n) * 100 + 1e-7);
}

const clean = (value: unknown): string => (typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '');

interface Draft {
  bookingDay: string;
  valueDay: string | null;
  amountCents: number;
  counterparty: string;
  reference: string;
  entryReference: string | null;
  kind: PaymentKind;
  /** The source's own unique number for the movement; when set it alone is the identity. */
  identity?: string;
}

/** Give every draft its identity; identical movements are numbered in order of appearance. */
function withHashes(drafts: Draft[]): NormalizedPayment[] {
  const seen = new Map<string, number>();
  return drafts.map(({ identity, ...d }) => {
    if (identity) return { ...d, sourceHash: referenceHash(identity), byReference: true };
    const base = [d.bookingDay, d.amountCents, d.counterparty.toLowerCase(), d.reference.toLowerCase(), d.entryReference ?? ''].join('|');
    const occurrence = (seen.get(base) ?? 0) + 1;
    seen.set(base, occurrence);
    return { ...d, sourceHash: createHash('sha256').update(`${base}|${occurrence}`).digest('hex') };
  });
}

function finish(
  format: PaymentFormat,
  drafts: Draft[],
  skipped: Record<string, number>,
  extra: { cancelled: string[]; notices: Record<string, number>; unknownStatuses: string[] } = { cancelled: [], notices: {}, unknownStatuses: [] },
): ParsedFile {
  if (drafts.length === 0 && Object.keys(skipped).length === 0) throw new PaymentParseError('empty');
  const days = drafts.map((d) => d.bookingDay).sort();
  return { format, payments: withHashes(drafts), skipped, ...extra, firstDay: days[0] ?? null, lastDay: days[days.length - 1] ?? null };
}

const defaultKind = (amountCents: number): PaymentKind => (amountCents < 0 ? 'spend' : 'income');

function skip(skipped: Record<string, number>, reason: string) {
  skipped[reason] = (skipped[reason] ?? 0) + 1;
}

/** Rows of a CSV as objects by header name; a row with a different cell count is unreadable. */
function records(rows: string[][]): Array<{ line: number; get: (name: string) => string }> {
  const header = rows[0].map((h) => h.trim());
  return rows.slice(1).map((cells, index) => {
    if (cells.length !== header.length) throw new PaymentParseError('unreadable_row', index + 2);
    return { line: index + 2, get: (name: string) => cells[header.indexOf(name)] ?? '' };
  });
}

function parseN26(rows: string[][]): ParsedFile {
  const skipped: Record<string, number> = {};
  const drafts = records(rows).map((r): Draft => {
    const bookingDay = toIsoDay(r.get('Booking Date'));
    const amountCents = toCents(r.get('Amount (EUR)'));
    if (!bookingDay || amountCents === null) throw new PaymentParseError('unreadable_row', r.line);
    const type = clean(r.get('Type'));
    return {
      bookingDay,
      valueDay: toIsoDay(r.get('Value Date')),
      amountCents,
      counterparty: clean(r.get('Partner Name')),
      reference: clean(r.get('Payment Reference')),
      entryReference: null,
      kind: type === 'Fee' ? 'fee' : defaultKind(amountCents),
    };
  });
  return finish('n26_csv', drafts, skipped);
}

function parseTomorrow(rows: string[][]): ParsedFile {
  const skipped: Record<string, number> = {};
  const drafts: Draft[] = [];
  for (const r of records(rows)) {
    if (clean(r.get('currency')) !== 'EUR') {
      skip(skipped, 'other_currency');
      continue;
    }
    const bookingDay = toIsoDay(r.get('booking_date'));
    const amountCents = toCents(r.get('amount'));
    if (!bookingDay || amountCents === null) throw new PaymentParseError('unreadable_row', r.line);
    const type = clean(r.get('booking_type'));
    drafts.push({
      bookingDay,
      valueDay: toIsoDay(r.get('valuta_date')),
      amountCents,
      counterparty: clean(r.get('sender_or_recipient')),
      reference: clean(r.get('description')),
      entryReference: null,
      // A returned direct debit comes back as money in: it undoes a spend, it is no income.
      kind: type === 'Direct Debit return' ? 'refund' : defaultKind(amountCents),
    });
  }
  return finish('tomorrow_csv', drafts, skipped);
}

function parsePaypal(rows: string[][]): ParsedFile {
  const skipped: Record<string, number> = {};
  const drafts: Draft[] = [];
  const all = records(rows);
  // A purchase in another currency appears as the purchase itself (in that
  // currency) plus a currency conversion in euro that points back at it. The
  // euro conversion is what was actually paid, so it becomes the spend, under
  // the purchase's own name.
  const byCode = new Map(all.map((r) => [clean(r.get('Transaktionscode')), r]));
  for (const r of all) {
    // Only completed movements that changed the balance are payments. Pending
    // and declined ones never happened; memo lines repeat another row.
    if (clean(r.get('Status')) !== 'Abgeschlossen') {
      skip(skipped, 'not_completed');
      continue;
    }
    if (clean(r.get('Auswirkung auf Guthaben')) === 'Memo') {
      skip(skipped, 'memo_line');
      continue;
    }
    if (clean(r.get('Währung')) !== 'EUR') {
      skip(skipped, 'other_currency');
      continue;
    }
    const bookingDay = toIsoDay(r.get('Datum'));
    const amountCents = toCents(r.get('Brutto'));
    if (!bookingDay || amountCents === null) throw new PaymentParseError('unreadable_row', r.line);
    const type = clean(r.get('Typ'));
    const describe = (row: (typeof all)[number]) =>
      [clean(row.get('Artikelbezeichnung')), clean(row.get('Rechnungsnummer')), clean(row.get('Betreff'))].filter(Boolean).join(' ');
    if (/Währungsumrechnung/i.test(type)) {
      const purchase = byCode.get(clean(r.get('Zugehöriger Transaktionscode')));
      const foreign = purchase !== undefined && clean(purchase.get('Währung')) !== 'EUR' && !/Währungsumrechnung/i.test(clean(purchase.get('Typ')));
      drafts.push({
        bookingDay,
        valueDay: null,
        amountCents,
        counterparty: foreign ? clean(purchase.get('Name')) : '',
        reference: foreign ? describe(purchase) : 'Währungsumrechnung',
        entryReference: clean(r.get('Transaktionscode')) || null,
        // The euro side of a foreign movement is that movement: a spend, money
        // back on a purchase, or income from someone who paid in another
        // currency. A conversion that belongs to nothing only moves money.
        kind: !foreign ? 'own_transfer' : /Rückzahlung|Erstattung/i.test(clean(purchase.get('Typ'))) ? 'refund' : defaultKind(amountCents),
      });
      continue;
    }
    // Topping the balance up from the bank or the card moves the owner's money around; it buys nothing.
    const funding = /Bankgutschrift|Gutschrift auf Kreditkarte|Abbuchung|Einzahlung/i.test(type);
    drafts.push({
      bookingDay,
      valueDay: null,
      amountCents,
      counterparty: clean(r.get('Name')),
      reference: describe(r),
      entryReference: clean(r.get('Transaktionscode')) || null,
      kind: funding ? 'own_transfer' : /Rückzahlung|Erstattung/i.test(type) ? 'refund' : defaultKind(amountCents),
    });
  }
  return finish('paypal_csv', drafts, skipped);
}

/** The identity of a movement the source numbers uniquely: that number alone, whatever else the row says. */
export function referenceHash(reference: string): string {
  return createHash('sha256').update(`id|${reference}`).digest('hex');
}

const HOME_ZONE = 'Europe/Berlin';

/**
 * The day in German time of a moment given as day, time and time zone. The
 * list states its zone; when that is the German one (or the time is missing)
 * the day stands as written. A day in another zone is moved: 23:30 in UTC is
 * already the next day here, which matters at the edges of a proposal window
 * and on 31 December. Null when the zone is not a real one.
 */
export function homeDay(day: string, time: string, zone: string): string | null {
  const clock = /^(\d{2}):(\d{2})/.exec(time.trim());
  if (!zone || zone === HOME_ZONE || !clock) return day;
  const [y, m, d] = day.split('-').map(Number);
  const asUtc = Date.UTC(y, m - 1, d, Number(clock[1]), Number(clock[2]));
  try {
    // What the zone's clock shows at that instant tells how far the zone is from UTC.
    const shown = new Intl.DateTimeFormat('sv-SE', { timeZone: zone, dateStyle: 'short', timeStyle: 'medium' }).format(new Date(asUtc));
    const offset = Date.parse(`${shown.replace(' ', 'T')}Z`) - asUtc;
    return new Intl.DateTimeFormat('sv-SE', { timeZone: HOME_ZONE }).format(new Date(asUtc - offset));
  } catch {
    return null;
  }
}

type KlarnaStatus = 'purchase' | 'not_completed' | 'cancelled' | 'part_refunded';

/**
 * What a status of the pay-later list means, wording by wording. The
 * statuses are relative to the export day and say when the service collects
 * ("Gestern bezahlt", "In 13 Tagen fällig"): paid or due, the purchase
 * happened. Only the sentence about the merchant not having processed the
 * order means it has not. The wordings are open-ended, so an unknown one does
 * not refuse the file: the row is read as a purchase (dropping a real purchase
 * in silence is the worse mistake) and the wording is reported for a look.
 */
const KLARNA_STATUS: Array<[RegExp, KlarnaStatus]> = [
  // The merchant has not processed the order: it can still change or never be charged.
  // First, because the German sentence also ends in "fällig".
  [/^wenn der händler deine bestellung bearbeitet\b/, 'not_completed'],
  [/^(in bearbeitung|wird bearbeitet|ausstehend|pending|processing)$/, 'not_completed'],
  // Part of the money came back; the list does not say how much. The purchase stays.
  [/^(teilweise (rück)?erstattet|teilerstattet|teilerstattung|partially refunded|partial refund)$/, 'part_refunded'],
  // Never charged, or all of it came back.
  [/^(storniert|cancell?ed|vollständig (rück)?erstattet|(rück)?erstattet|fully refunded|refunded)$/, 'cancelled'],
  // An ordinary purchase: paid, or due on a later day ("Gestern bezahlt", "Am 5. Sept. bezahlt", "In 12 Tagen fällig", "Überfällig").
  [/^(normal|paid|completed|captured)$/, 'purchase'],
  [/(^|\s)bezahlt$/, 'purchase'],
  [/fällig$/, 'purchase'],
  // Left by the conversion on a row read from the web pages; it says nothing about the payment.
  [/^read$/, 'purchase'],
];

function klarnaStatus(status: string): KlarnaStatus | null {
  const text = status.toLowerCase();
  if (text === '') return 'purchase';
  return KLARNA_STATUS.find(([pattern]) => pattern.test(text))?.[1] ?? null;
}

/**
 * The purchase list of the pay-later service. One row is one purchase, always
 * a positive amount, on the day it was made. The list holds no settlements and
 * no single instalments: a purchase paid in instalments is one spend of the
 * full amount, and how the service collects the money shows on the bank
 * account, where it is a transfer (see `funding.ts`).
 */
function parseKlarna(rows: string[][]): ParsedFile {
  const skipped: Record<string, number> = {};
  const notices: Record<string, number> = {};
  const cancelled: string[] = [];
  const unknownStatuses: string[] = [];
  const drafts: Draft[] = [];
  const seen = new Set<string>();
  for (const r of records(rows)) {
    if (clean(r.get('currency')).toUpperCase() !== 'EUR') {
      skip(skipped, 'other_currency');
      continue;
    }
    const wording = clean(r.get('status'));
    const status = klarnaStatus(wording) ?? 'purchase';
    if (klarnaStatus(wording) === null) {
      notices.unknown_status = (notices.unknown_status ?? 0) + 1;
      if (!unknownStatuses.includes(wording.slice(0, 60)) && unknownStatuses.length < 5) unknownStatuses.push(wording.slice(0, 60));
    }
    if (status === 'not_completed') {
      skip(skipped, 'not_completed');
      continue;
    }
    const reference = clean(r.get('payment_reference'));
    if (status === 'cancelled') {
      skip(skipped, 'cancelled');
      // A purchase an earlier file brought as paid stops counting (see `importPayments`).
      if (reference) cancelled.push(referenceHash(reference));
      continue;
    }
    const writtenDay = toIsoDay(r.get('created_date'));
    const amountCents = toCents(r.get('amount'));
    const bookingDay = writtenDay ? homeDay(writtenDay, r.get('created_time'), clean(r.get('timezone'))) : null;
    if (!bookingDay || amountCents === null) throw new PaymentParseError('unreadable_row', r.line);
    if (amountCents === 0) {
      skip(skipped, 'zero_amount');
      continue;
    }
    // Money back carries its purchase's reference: it is a movement of its own, not a second copy of the purchase.
    const identity = reference ? (amountCents < 0 ? `${reference}|refund` : reference) : null;
    if (identity) {
      // The same movement listed twice (two extracts merged into one file) is one movement.
      if (seen.has(identity)) {
        skip(skipped, 'duplicate_row');
        continue;
      }
      seen.add(identity);
    }
    if (status === 'part_refunded') notices.part_refunded = (notices.part_refunded ?? 0) + 1;
    drafts.push({
      bookingDay,
      // The day the merchant captured the purchase, when the list has it.
      valueDay: toIsoDay(r.get('activated')),
      // The list states what was bought as a positive amount; a negative one is money back.
      amountCents: -amountCents,
      counterparty: clean(r.get('merchant')),
      reference: clean(r.get('items')),
      entryReference: reference || clean(r.get('statement_number')) || null,
      kind: amountCents < 0 ? 'refund' : 'spend',
      ...(identity ? { identity } : {}),
    });
  }
  // A row without a reference that a referenced row repeats (the same purchase
  // once from the web pages, once from the extract) is that purchase: day,
  // amount and merchant agree and neither side could mean another row.
  const sameMovement = (d: Draft) => `${d.bookingDay}|${d.amountCents}|${d.counterparty.toLowerCase()}`;
  const count = (list: Draft[]) => {
    const counts = new Map<string, number>();
    for (const d of list) counts.set(sameMovement(d), (counts.get(sameMovement(d)) ?? 0) + 1);
    return counts;
  };
  const referenced = count(drafts.filter((d) => d.identity));
  const unreferenced = count(drafts.filter((d) => !d.identity));
  const kept = drafts.filter((d) => {
    if (d.identity || referenced.get(sameMovement(d)) !== 1 || unreferenced.get(sameMovement(d)) !== 1) return true;
    skip(skipped, 'duplicate_row');
    return false;
  });
  return finish('klarna_csv', kept, skipped, { cancelled, notices, unknownStatuses });
}

function parseEnableBanking(data: unknown): ParsedFile {
  const list = Array.isArray(data) ? data : Array.isArray((data as { transactions?: unknown })?.transactions) ? (data as { transactions: unknown[] }).transactions : null;
  if (list === null) throw new PaymentParseError('unknown_layout');
  const skipped: Record<string, number> = {};
  const drafts: Draft[] = [];
  list.forEach((entry, index) => {
    const t = (entry ?? {}) as Record<string, unknown>;
    // Only booked movements: a pending one can still change or vanish.
    if (t.status !== 'BOOK') {
      skip(skipped, 'not_booked');
      return;
    }
    const amount = (t.transaction_amount ?? {}) as { amount?: unknown; currency?: unknown };
    if (amount.currency !== 'EUR') {
      skip(skipped, 'other_currency');
      return;
    }
    const bookingDay = toIsoDay((t.booking_date as string) ?? (t.transaction_date as string) ?? (t.value_date as string));
    const magnitude = toCents(typeof amount.amount === 'string' ? amount.amount : String(amount.amount ?? ''));
    const indicator = t.credit_debit_indicator;
    if (!bookingDay || magnitude === null || magnitude < 0 || (indicator !== 'DBIT' && indicator !== 'CRDT')) {
      throw new PaymentParseError('unreadable_row', index + 1);
    }
    const amountCents = indicator === 'DBIT' ? -magnitude : magnitude;
    const party = ((indicator === 'DBIT' ? t.creditor : t.debtor) ?? {}) as { name?: unknown };
    const remittance = Array.isArray(t.remittance_information) ? t.remittance_information.filter((x) => typeof x === 'string').join(' ') : '';
    drafts.push({
      bookingDay,
      valueDay: toIsoDay(t.value_date as string),
      amountCents,
      counterparty: clean(party.name),
      reference: clean(remittance),
      entryReference: clean(t.entry_reference) || null,
      kind: defaultKind(amountCents),
    });
  });
  return finish('enable_banking_json', drafts, skipped);
}

/** Recognize the layout from the content itself and read it. */
export function parsePaymentFile(text: string): ParsedFile {
  if (text.length > MAX_BYTES) throw new PaymentParseError('too_large');
  const trimmed = text.trimStart();
  if (!trimmed) throw new PaymentParseError('empty');
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    let data: unknown;
    try {
      data = JSON.parse(trimmed);
    } catch {
      throw new PaymentParseError('unknown_layout');
    }
    return parseEnableBanking(data);
  }
  const rows = parseCsv(text);
  if (rows.length === 0) throw new PaymentParseError('empty');
  const header = new Set(rows[0].map((h) => h.trim()));
  const has = (...names: string[]) => names.every((n) => header.has(n));
  if (has('Booking Date', 'Partner Name', 'Amount (EUR)', 'Payment Reference')) return parseN26(rows);
  if (has('booking_date', 'sender_or_recipient', 'amount', 'currency', 'booking_type')) return parseTomorrow(rows);
  if (has('Datum', 'Name', 'Typ', 'Status', 'Währung', 'Brutto', 'Transaktionscode', 'Auswirkung auf Guthaben')) return parsePaypal(rows);
  if (has('created_date', 'amount', 'currency', 'merchant', 'status', 'payment_reference')) return parseKlarna(rows);
  throw new PaymentParseError('unknown_layout');
}
