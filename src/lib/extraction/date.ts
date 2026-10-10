/**
 * Reading the invoice date from the recognized text of a receipt.
 *
 * An invoice prints several dates: the day it was issued, the day it is due,
 * the period it bills, the day a subscription renews, the day of an order or
 * of a delivery. Taking "the first date in the text" therefore depends on the
 * layout, and taking "the date on a line that says date" picked "Date due".
 *
 * Every date found is given a kind by the words that stand in front of it
 * (on its own line, or on the line above when a label stands alone), and the
 * kinds are ranked: a date the document calls the invoice date, then a plain
 * "Datum", then an order or payment date, then a date with no label at all,
 * and last a service period or delivery date. A due date, a renewal date and
 * an expiry date are never the invoice date: a document that prints nothing
 * else has no date, which a person then fills in.
 */

const MONTH_WORDS =
  'jan(?:uary|uar)?|feb(?:ruary|ruar)?|mar(?:ch)?|m(?:ä|ae)rz|mrz|apr(?:il)?|may|mai|june?|juni|july?|juli|aug(?:ust)?|sep(?:t(?:ember)?)?|o[ck]t(?:ober)?|nov(?:ember)?|de[cz](?:ember)?';

/** English and German month names by their first three letters ("März" and its spellings without the umlaut included). */
const MONTH_NUMBER: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, 'mär': 3, mae: 3, mrz: 3, apr: 4, may: 5, mai: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, okt: 10, nov: 11, dec: 12, dez: 12,
};

/** A year of four digits, or of two; never the hour of a time that follows ("8 May 12:30"). */
const YEAR = '(\\d{4}|\\d{2})(?![\\p{N}:])';

interface DatePattern {
  pattern: RegExp;
  /** Year, month and day of one match, as printed. */
  read: (m: RegExpMatchArray) => [number, number, number];
}

const DATE_PATTERNS: DatePattern[] = [
  // 2025-03-15
  { pattern: /(?<![\p{N}-])(\d{4})-(\d{2})-(\d{2})(?![\p{N}])/gu, read: (m) => [Number(m[1]), Number(m[2]), Number(m[3])] },
  // 8. March 2025, 26. Nov. 2025, 21st July 2025, 15 Mar 24, 20-NOV-2025
  {
    pattern: new RegExp(`(?<![\\p{L}\\p{N}]|\\p{N}[.,/-])(\\d{1,2})(?:st|nd|rd|th|\\.)?(?:\\s+|-)(${MONTH_WORDS})\\.?(?![\\p{L}])(?:,?\\s+|-)${YEAR}`, 'giu'),
    read: (m) => [Number(m[3]), MONTH_NUMBER[m[2].toLowerCase().slice(0, 3)], Number(m[1])],
  },
  // Mar 15, 2024, February 27th 2025
  {
    pattern: new RegExp(`(?<![\\p{L}])(${MONTH_WORDS})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,\\s*|\\.?\\s+)${YEAR}`, 'giu'),
    read: (m) => [Number(m[3]), MONTH_NUMBER[m[1].toLowerCase().slice(0, 3)], Number(m[2])],
  },
  // 15.03.2024, 19.02.25
  { pattern: new RegExp(`(?<![\\p{N}.])(\\d{1,2})\\.(\\d{1,2})\\.${YEAR}`, 'gu'), read: (m) => [Number(m[3]), Number(m[2]), Number(m[1])] },
  // 03/15/2024: the month first, unless the first number cannot be a month.
  {
    pattern: new RegExp(`(?<![\\p{N}/])(\\d{1,2})/(\\d{1,2})/${YEAR}`, 'gu'),
    read: (m) => {
      const [a, b] = [Number(m[1]), Number(m[2])];
      return a > 12 ? [Number(m[3]), b, a] : [Number(m[3]), a, b];
    },
  },
];

function toISO(year: number, month: number, day: number): string | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const y = year < 100 ? year + 2000 : year;
  if (y < 1900 || y > 2100) return null;
  // Midnight UTC of the printed day, whatever time zone the server runs in:
  // built in local time, a receipt of the 9th became the 8th at 23:00 UTC.
  const d = new Date(Date.UTC(y, month - 1, day));
  if (d.getUTCFullYear() !== y || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) return null;
  return d.toISOString();
}

interface FoundDate {
  iso: string;
  start: number;
  end: number;
}

/** Every date on a line, left to right. Where two patterns read the same characters, the one that starts first stands. */
function datesOnLine(line: string): FoundDate[] {
  const found: FoundDate[] = [];
  for (const { pattern, read } of DATE_PATTERNS) {
    for (const match of line.matchAll(pattern)) {
      const iso = toISO(...read(match));
      if (iso) found.push({ iso, start: match.index, end: match.index + match[0].length });
    }
  }
  found.sort((a, b) => a.start - b.start);
  return found.filter((date, i) => i === 0 || date.start >= found[i - 1].end);
}

/**
 * What a date is, by the words in front of it. The order is the order of
 * trust; `never` is not ranked at all.
 */
type DateKind = 'invoice' | 'plain' | 'order' | 'unlabelled' | 'service' | 'never';

const RANK: Record<Exclude<DateKind, 'never'>, number> = { invoice: 0, plain: 1, order: 2, unlabelled: 3, service: 4 };

/** An English label may carry the word itself: "Due date", "Order date". Without this the plain "date" behind it would name the kind. */
const D = '(?:\\s+date)?';

/**
 * The labels, by kind. Where several stand in front of a date the nearest one
 * names it ("Due: on receipt   Invoice date: 5 Jan 2025" is an invoice date),
 * and of two that end at the same place the one listed first here.
 */
const LABELS: Array<{ kind: DateKind; pattern: RegExp }> = [
  {
    kind: 'never',
    pattern: new RegExp(
      `(?<![\\p{L}])(?:due${D}|expir(?:y|es|ation)${D}|valid\\s+(?:thru|through|until)|renew(?:s|al|ed)?${D}|next\\s+(?:billing|payment|charge|invoice)${D})(?![\\p{L}])` +
        '|f(?:ä|ae)llig|zahlbar|zahlungsziel|begleichung|abbuch|abgebucht|buchen\\s+wir|eingezogen|verl(?:ä|ae)nger|g(?:ü|ue)ltig\\s+bis|n(?:ä|ae)chste',
      'giu',
    ),
  },
  {
    kind: 'invoice',
    pattern:
      /invoice\s+date|date\s+of\s+(?:issue|invoice)|issue\s+date|(?<![\p{L}])issued(?![\p{L}])|receipt\s+date|transaction\s+date|bill(?:ing)?\s+date|rechnungs(?:nr|nummer)?\.?\s*\/?\s*-?\s*datum|rechnung\s+vom|ausstellungsdatum|ausgestellt|erstellungsdatum|erstellt\s+am|belegdatum|fakturadatum/giu,
  },
  {
    kind: 'service',
    pattern: new RegExp(
      `(?<![\\p{L}])(?:(?:service|billing|subscription)\\s+(?:term|period)|period|term|(?:service|start|end)\\s+date|deliver(?:y|ed)${D}|shipp(?:ing|ed)${D}|check-?\\s?(?:in|out))(?![\\p{L}])` +
        '|zeitraum|laufzeit|vertrags(?:beginn|ende)|leistungs|liefer|versand|hinfahrt|r(?:ü|ue)ckfahrt|abfahrt|anreise|abreise',
      'giu',
    ),
  },
  {
    kind: 'order',
    pattern: new RegExp(
      `(?<![\\p{L}])(?:order(?:ed)?${D}|purchased?${D}|payment${D}|paid|booked|bought)(?![\\p{L}])|bestell|bezahlt|gebucht|gekauft|kaufdatum|zahlungsdatum|buchungsdatum`,
      'giu',
    ),
  },
  // The bare word only: "Lieferscheindatum" and the "-datum" of "Bestellnr./-datum" belong to the word in front of them.
  { kind: 'plain', pattern: /(?<![\p{L}/-])(?:date|datum)(?![\p{L}])/giu },
];

/** The nearest label in front of the end of `text`, and where it ends. */
function lastLabel(text: string): { kind: DateKind; end: number } | null {
  let best: { kind: DateKind; end: number } | null = null;
  for (const { kind, pattern } of LABELS) {
    for (const match of text.matchAll(pattern)) {
      const end = match.index + match[0].length;
      if (!best || end > best.end) best = { kind, end };
    }
  }
  return best;
}

/** The kind the words of `text` give to a date that follows them. */
function kindOf(text: string): DateKind {
  return lastLabel(text)?.kind ?? 'unlabelled';
}

/** A card's expiry is no date of the receipt, wherever on the line it is named. */
const EXPIRY_LINE = /\b(?:exp|expir|valid\s*thru|valid\s*through|card|cvv|cvc)\b/i;
/** Two dates with only this between them are a period: "1. März 2025 - 31. März 2025", "20-NOV-2025 to 19-DEC-2025". */
const RANGE_JOIN = /^\s*(?:-|\u2013|\u2014|to|bis|until|through)\s*$/i;
/** A line of nothing, or of dots and rules, between a label and its value. */
const FILLER_LINE = /^[\s.\-_=*·|]*$/;
/**
 * A label that stands alone above its value is short and ends the line
 * ("Rechnungsdatum", "Bezahlt am:", "Date due"). "Gebuchtes Produkt: Tarif L"
 * is a line about something else, and so is a sentence that mentions a payment.
 */
const LABEL_LINE_MAX = 40;
const AFTER_LABEL = /^(?:\s+(?:am|vom|on|at))?[\s:.]*$/i;

/**
 * The invoice date of a receipt as an ISO 8601 instant (midnight UTC of the
 * printed day), or null when the text prints none.
 */
export function readDate(text: string): string | null {
  const lines = text.split('\n');
  const dates = lines.map((line) => (EXPIRY_LINE.test(line) ? [] : datesOnLine(line)));
  const isFiller = (i: number) => FILLER_LINE.test(lines[i]);
  const labelAlone = (i: number): DateKind | null => {
    if (dates[i].length > 0 || EXPIRY_LINE.test(lines[i]) || lines[i].trim().length > LABEL_LINE_MAX) return null;
    const label = lastLabel(lines[i]);
    return label && AFTER_LABEL.test(lines[i].slice(label.end)) ? label.kind : null;
  };
  /** A line that is one date and nothing else: the value of a label in a block of labels. */
  const bareDate = (i: number) =>
    dates[i].length === 1 && !/[\p{L}\p{N}]/u.test(lines[i].slice(0, dates[i][0].start) + lines[i].slice(dates[i][0].end));

  // Labels that stand alone name the date below them. One label names the
  // first date of the next line. A block of labels names a block of dates of
  // the same length, in order ("Date of issue / Date due" above two dates);
  // where the lengths differ nothing can be told and the dates stay unlabelled.
  const fromAbove = new Map<number, DateKind>();
  for (let i = 0; i < lines.length; ) {
    if (labelAlone(i) === null) {
      i++;
      continue;
    }
    const block: DateKind[] = [];
    let next = i;
    for (; next < lines.length; next++) {
      const kind = labelAlone(next);
      if (kind !== null) block.push(kind);
      else if (!isFiller(next)) break;
    }
    if (block.length === 1) {
      if (next < lines.length && dates[next].length > 0) fromAbove.set(next, block[0]);
    } else {
      const values: number[] = [];
      for (let v = next; v < lines.length && values.length < block.length; v++) {
        if (isFiller(v)) continue;
        if (!bareDate(v)) break;
        values.push(v);
      }
      if (values.length === block.length) values.forEach((line, n) => fromAbove.set(line, block[n]));
    }
    i = next;
  }

  let best: { iso: string; rank: number } | null = null;
  for (let i = 0; i < lines.length; i++) {
    const onLine = dates[i];
    for (let n = 0; n < onLine.length; n++) {
      const before = lines[i].slice(n === 0 ? 0 : onLine[n - 1].end, onLine[n].start);
      const after = n + 1 < onLine.length ? lines[i].slice(onLine[n].end, onLine[n + 1].start) : null;
      let kind = kindOf(before);
      if (kind === 'unlabelled' && n === 0) kind = fromAbove.get(i) ?? 'unlabelled';
      // Either end of a period is a service date, whatever stands in front of it.
      if (kind !== 'never' && ((n > 0 && RANGE_JOIN.test(before)) || (after !== null && RANGE_JOIN.test(after)))) kind = 'service';
      if (kind === 'never') continue;
      if (!best || RANK[kind] < best.rank) best = { iso: onLine[n].iso, rank: RANK[kind] };
    }
  }
  return best?.iso ?? null;
}
