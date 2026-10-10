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

/** `YYYY-MM-DD` or `DD.MM.YYYY` to an ISO day; null when it is neither or no real day. */
export function toIsoDay(value: string | null | undefined): string | null {
  const text = (value ?? '').trim();
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
  const normalized = text.includes(',') ? text.replace(/\./g, '').replace(',', '.') : text;
  if (!/^[+-]?\d+(\.\d+)?$/.test(normalized)) return null;
  const n = Number(normalized);
  if (!Number.isFinite(n)) return null;
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
}

/** Give every draft its identity; identical movements are numbered in order of appearance. */
function withHashes(drafts: Draft[]): NormalizedPayment[] {
  const seen = new Map<string, number>();
  return drafts.map((d) => {
    const base = [d.bookingDay, d.amountCents, d.counterparty.toLowerCase(), d.reference.toLowerCase(), d.entryReference ?? ''].join('|');
    const occurrence = (seen.get(base) ?? 0) + 1;
    seen.set(base, occurrence);
    return { ...d, sourceHash: createHash('sha256').update(`${base}|${occurrence}`).digest('hex') };
  });
}

function finish(format: PaymentFormat, drafts: Draft[], skipped: Record<string, number>): ParsedFile {
  if (drafts.length === 0 && Object.keys(skipped).length === 0) throw new PaymentParseError('empty');
  const days = drafts.map((d) => d.bookingDay).sort();
  return { format, payments: withHashes(drafts), skipped, firstDay: days[0] ?? null, lastDay: days[days.length - 1] ?? null };
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
  for (const r of records(rows)) {
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
    // Topping the balance up from the bank or the card, and the service's own
    // currency conversion, move the owner's money around; they buy nothing.
    const funding = /Bankgutschrift|Gutschrift auf Kreditkarte|Währungsumrechnung|Abbuchung|Einzahlung/i.test(type);
    drafts.push({
      bookingDay,
      valueDay: null,
      amountCents,
      counterparty: clean(r.get('Name')),
      reference: [clean(r.get('Artikelbezeichnung')), clean(r.get('Rechnungsnummer')), clean(r.get('Betreff'))].filter(Boolean).join(' '),
      entryReference: clean(r.get('Transaktionscode')) || null,
      kind: funding ? 'own_transfer' : /Rückzahlung|Erstattung/i.test(type) ? 'refund' : defaultKind(amountCents),
    });
  }
  return finish('paypal_csv', drafts, skipped);
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
  throw new PaymentParseError('unknown_layout');
}
