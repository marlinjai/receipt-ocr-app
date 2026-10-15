/**
 * Measure the receipt reading on a folder of real documents against a
 * hand-checked table of their date and total.
 *
 * It runs what an upload runs: text recognition, the text reader, the one
 * model call that sees the page, and the settling of the two readings
 * (src/lib/receipt-reading.ts). For every document it compares the invoice
 * date and the total with the table and prints COUNTS ONLY: totals, tallies
 * per vendor, the review flags raised, why a total was missed, tokens and
 * cost. It never prints a file name, an amount, a date or any text of a
 * document, and it writes nothing unless `--state` names a file.
 *
 *   npx tsx scripts/evaluate-page-reading.ts <folder> <table.csv> [options]
 *
 * The table is a CSV with the columns `file` (path below the folder),
 * `vendor`, `invoice_date` (YYYY-MM-DD, or empty when it is not known and the
 * date is then not judged), `total_gross` (empty when the
 * document states no total), optionally `vat_amount` (the tax contained in the
 * total; where given, the net that is stored is judged too) and
 * `duplicate_of` (rows that name another file are skipped).
 *
 * The import table of the tax folder is read as well: `date` in place of
 * `invoice_date` (YYYY-MM-DD or "Jul 24, 2026"), `total` in place of
 * `total_gross`, `currency` (judged where given), and `decision` (only rows
 * that say "imported" are read). A row whose file names one page of a scan
 * ("scan.pdf, page 3") is skipped: the script reads whole files.
 *
 * The vendor is judged too: right when the reading names the vendor of the
 * table, also without the legal form or as part of a longer name ("Hetzner"
 * and "Hetzner Online GmbH"); wrong when it names another (a legal entity
 * where the table has the name a customer uses, "Anysphere, Inc." for
 * "Cursor"). A person corrects such a name by hand, so the count says how
 * much of that work a reading leaves.
 *
 * Options:
 *   --sample <n>          read at most n documents, spread over the vendors
 *   --must <a,b,...>      vendors (parts of their names) the sample must contain
 *   --model <id>          the model that reads (default: the app's)
 *   --text-only           do not give the model the page, as production did before
 *                         the page reading: the "before" number for a model
 *   --state <file>        keep each document's outcome in this file and skip the
 *                         documents it already holds, so a run that was cut off
 *                         goes on where it stopped (outcomes and token counts
 *                         only; keep it out of the repository all the same)
 *   --retry-misses <file> read only the documents a former run got wrong
 *   --concurrency <n>     documents read at once (default 4)
 *   --max-seconds <n>     start no further document after n seconds; run again
 *                         with the same --state to go on
 *
 * Environment: GOOGLE_CLOUD_VISION_API_KEY and OPENROUTER_API_KEY, as the app
 * has them. Run it where they are injected; never paste a key.
 */

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { extractReceiptFields } from '@/lib/extract-receipt-fields';
import { amountsInText } from '@/lib/extraction/amounts';
import { classifyReceiptText } from '@/lib/receipt-classifier';
import { preparePage, sniffMediaType } from '@/lib/receipt-page';
import { settleReading, type SettledReading } from '@/lib/receipt-reading';
import { sameVendor } from '@/lib/extraction/vendor';
import { CATEGORY_TO_KONTO, ZUORDNUNG_OPTIONS } from '@/lib/receipts-constants';
import { recognizeText } from '@/lib/text-recognition';

interface Expected {
  file: string;
  vendor: string;
  /** YYYY-MM-DD; null when the table does not know it. */
  date: string | null;
  /** Null when the document states no total. */
  total: number | null;
  /** The tax contained in the total; null when the table does not say. */
  vat: number | null;
  /** ISO 4217 code; null when the table does not say. */
  currency: string | null;
}

type Verdict = 'correct' | 'wrong' | 'missing' | 'not judged';

/** Why the settled total is not the table's, by what the model itself answered. */
type MissCause =
  | 'model_right_not_printed_in_text'
  | 'model_right_overruled_by_text'
  | 'model_wrong_and_taken'
  | 'model_wrong_text_kept'
  | 'model_gave_none'
  | 'model_said_there_is_no_total'
  | 'model_named_a_total_where_there_is_none'
  | 'no_model_answer';

interface Outcome {
  vendor: string;
  date: Verdict;
  total: Verdict;
  /** The stored net against the table's total less its tax; absent where the table names no tax or the total is not right. */
  net?: 'correct' | 'wrong';
  /** The vendor against the table's; absent in outcomes stored by an older run. */
  vendorVerdict?: Verdict;
  /** The currency against the table's; absent where the table does not say. */
  currency?: 'correct' | 'wrong';
  flags: string[];
  sawPage: boolean;
  /** What the settled total rests on (see TotalBasis in the amount reader). */
  basis?: string;
  cause?: MissCause;
  /** Why the settled date is not the table's, by what the model itself answered. */
  dateCause?: 'model_right' | 'model_gave_none' | 'model_agrees_with_text' | 'model_named_another_day' | 'no_model_answer';
}

interface DocumentResult {
  /** The text reader alone, no model. */
  text: Outcome;
  /** Text and the model, settled as the app settles them. */
  reading?: Outcome;
  /** What the model call used; `cost` in US dollars, null where the provider does not say. */
  usage?: { inputTokens: number; outputTokens: number; cost: number | null };
  /** Set when the document could not be read at all (recognition failed, file gone). */
  failed?: 'recognition' | 'file';
}

// ── Arguments ────────────────────────────────────────────────────────

function parseArgs(argv: string[]) {
  const positional: string[] = [];
  const options = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--text-only') options.set('text-only', 'yes');
    else if (argv[i].startsWith('--')) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) throw new Error(`${argv[i]} needs a value`);
      options.set(argv[i].slice(2), value);
      i++;
    }
    else positional.push(argv[i]);
  }
  if (positional.length !== 2) {
    throw new Error('Usage: evaluate-page-reading <folder> <table.csv> [--sample n] [--must a,b] [--model id] [--text-only] [--state file] [--retry-misses file] [--concurrency n] [--max-seconds n]');
  }
  const number = (name: string, fallback: number) => {
    const raw = options.get(name);
    if (raw === undefined) return fallback;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 1) throw new Error(`--${name} must be a whole number above 0`);
    return value;
  };
  return {
    folder: positional[0],
    table: positional[1],
    sample: options.has('sample') ? number('sample', 0) : null,
    must: (options.get('must') ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
    model: options.get('model') || null,
    textOnly: options.has('text-only'),
    state: options.get('state') || null,
    retryMisses: options.get('retry-misses') || null,
    concurrency: number('concurrency', 4),
    maxSeconds: options.has('max-seconds') ? number('max-seconds', 0) : null,
  };
}

// ── The table ────────────────────────────────────────────────────────

/** A CSV with quoted fields, doubled quotes and line breaks inside quotes. */
export function parseCsv(text: string): Array<Record<string, string>> {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  const body = text.replace(/^﻿/, '');
  for (let i = 0; i < body.length; i++) {
    const char = body[i];
    if (quoted) {
      if (char === '"' && body[i + 1] === '"') {
        field += '"';
        i++;
      } else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"') quoted = true;
    else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && body[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      if (row.some((value) => value !== '')) rows.push(row);
      row = [];
    } else field += char;
  }
  row.push(field);
  if (row.some((value) => value !== '')) rows.push(row);
  const [header, ...data] = rows;
  if (!header) return [];
  return data.map((values) => Object.fromEntries(header.map((name, i) => [name.trim(), (values[i] ?? '').trim()])));
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** A day as YYYY-MM-DD, from "2026-07-24" or "Jul 24, 2026". Null for anything else. */
export function tableDay(value: string): string | null {
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  const named = /^([A-Za-z]{3})[a-z]*\.? (\d{1,2}), (\d{4})$/.exec(value);
  let parts: [number, number, number] | null = null;
  if (iso) parts = [Number(iso[1]), Number(iso[2]), Number(iso[3])];
  else if (named && MONTHS.includes(named[1].toLowerCase())) parts = [Number(named[3]), MONTHS.indexOf(named[1].toLowerCase()) + 1, Number(named[2])];
  if (!parts) return null;
  const date = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2]));
  if (date.getUTCMonth() !== parts[1] - 1 || date.getUTCDate() !== parts[2]) return null;
  return date.toISOString().slice(0, 10);
}

/** The rows of the table that can be judged. A row with a date or a total that cannot be read is left out, never guessed. */
export function expectedRows(csv: string): Expected[] {
  const out: Expected[] = [];
  for (const row of parseCsv(csv)) {
    if (!row.file || row.duplicate_of) continue;
    if (row.decision !== undefined && row.decision !== 'imported') continue;
    if (/,\s*page\s+\d+$/i.test(row.file)) continue;
    const rawDate = row.invoice_date ?? row.date ?? '';
    const date = rawDate === '' ? null : tableDay(rawDate);
    if (rawDate !== '' && date === null) continue;
    const rawTotal = row.total_gross ?? row.total ?? '';
    const total = rawTotal === '' ? null : Number(rawTotal);
    if (total !== null && !Number.isFinite(total)) continue;
    const vat = row.vat_amount === undefined || row.vat_amount === '' ? null : Number(row.vat_amount);
    const currency = /^[A-Z]{3}$/.test(row.currency ?? '') ? row.currency : null;
    out.push({ file: row.file, vendor: row.vendor || 'unknown', date, total, vat: vat !== null && Number.isFinite(vat) ? vat : null, currency });
  }
  return out;
}

const vendorKey = (name: string) => name.toLocaleLowerCase('de-DE').replace(/[^\p{L}\p{N}]+/gu, '');

/**
 * The vendor a reading stored against the table's. Right when it is the same
 * name (see sameVendor), or one name holds the other ("Hetzner" in "Hetzner
 * Online GmbH"); not judged where the table names none.
 */
export function judgeVendor(expected: string, read: string | null): Verdict {
  if (!expected || expected === 'unknown') return 'not judged';
  if (!read || !read.trim()) return 'missing';
  if (sameVendor(expected, read)) return 'correct';
  const [a, b] = [vendorKey(expected), vendorKey(read)];
  return a.length >= 3 && b.length >= 3 && (a.includes(b) || b.includes(a)) ? 'correct' : 'wrong';
}

/**
 * At most `size` documents: first up to three of every vendor the caller
 * insists on, then one per other vendor in turn, so a vendor with fifty invoices does not crowd
 * out the one customs invoice. The order is that of the table, so a run can
 * be repeated.
 */
export function pickSample<T extends { vendor: string }>(rows: T[], size: number, must: string[]): T[] {
  const byVendor = new Map<string, T[]>();
  for (const row of rows) byVendor.set(row.vendor, [...(byVendor.get(row.vendor) ?? []), row]);
  const insisted = [...byVendor.keys()].filter((vendor) => must.some((part) => vendor.toLowerCase().includes(part)));
  const others = [...byVendor.keys()].filter((vendor) => !insisted.includes(vendor));
  const picked: T[] = [];
  // Up to three documents of a vendor the caller insists on (the invoices of one registrar, both leasing papers).
  for (const vendor of insisted) picked.push(...(byVendor.get(vendor) ?? []).slice(0, 3));
  for (let round = 0; picked.length < size; round++) {
    const next = others.map((vendor) => byVendor.get(vendor)?.[round]).filter((row): row is T => row !== undefined);
    if (next.length === 0) break;
    picked.push(...next.slice(0, size - picked.length));
  }
  return picked.slice(0, Math.max(size, 0));
}

// ── Reading one document ─────────────────────────────────────────────

const sameAmount = (a: number, b: number) => Math.abs(a - b) < 0.005;

export function judge(
  expected: Expected,
  settled: Pick<SettledReading, 'date' | 'gross' | 'net' | 'flags' | 'vendor' | 'currency'>,
  vendor: string,
  sawPage: boolean,
): Outcome {
  const day = settled.date?.slice(0, 10) ?? null;
  const date: Verdict = expected.date === null ? 'not judged' : day === null ? 'missing' : day === expected.date ? 'correct' : 'wrong';
  let total: Verdict;
  if (expected.total === null) total = settled.gross === null ? 'correct' : 'wrong';
  else total = settled.gross === null ? 'missing' : sameAmount(settled.gross, expected.total) ? 'correct' : 'wrong';
  const outcome: Outcome = { vendor, date, total, flags: settled.flags, sawPage, vendorVerdict: judgeVendor(expected.vendor, settled.vendor) };
  if (expected.currency !== null) outcome.currency = settled.currency === expected.currency ? 'correct' : 'wrong';
  if (total === 'correct' && expected.total !== null && expected.vat !== null) {
    outcome.net = settled.net !== null && Math.abs(settled.net - (expected.total - expected.vat)) < 0.011 ? 'correct' : 'wrong';
  }
  return outcome;
}

function missCause(expected: Expected, modelGross: number | null | undefined, settledGross: number | null, fullText: string, saidNoTotal = false): MissCause {
  if (modelGross === undefined) return 'no_model_answer';
  if (expected.total === null) return modelGross !== null ? 'model_named_a_total_where_there_is_none' : 'model_wrong_text_kept';
  if (modelGross === null) return saidNoTotal ? 'model_said_there_is_no_total' : 'model_gave_none';
  if (sameAmount(modelGross, expected.total)) {
    const printed = amountsInText(fullText).some((a) => a.cents === Math.round(expected.total! * 100));
    return printed ? 'model_right_overruled_by_text' : 'model_right_not_printed_in_text';
  }
  return settledGross !== null && sameAmount(settledGross, modelGross) ? 'model_wrong_and_taken' : 'model_wrong_text_kept';
}

const CATEGORY_NAMES = Object.keys(CATEGORY_TO_KONTO);

async function readDocument(expected: Expected, folder: string, visionKey: string, withPage: boolean): Promise<DocumentResult> {
  const failed = (reason: 'recognition' | 'file'): DocumentResult => ({
    text: { vendor: expected.vendor, date: 'missing', total: 'missing', flags: [], sawPage: false },
    failed: reason,
  });
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await readFile(path.join(folder, expected.file)));
  } catch {
    return failed('file');
  }
  const mediaType = sniffMediaType(bytes);
  if (!mediaType) return failed('file');

  let fullText: string;
  let confidence: number;
  try {
    const ocr = await recognizeText(Buffer.from(bytes).toString('base64'), mediaType === 'application/pdf', visionKey);
    fullText = ocr.fullText;
    confidence = ocr.confidence;
  } catch {
    return failed('recognition');
  }
  if (!fullText.trim()) return failed('recognition');

  const extracted = extractReceiptFields({ fullText, blocks: [], confidence });
  const result: DocumentResult = {
    text: judge(expected, { date: extracted.date, gross: extracted.gross, net: extracted.net, flags: [], vendor: extracted.vendor, currency: extracted.currency }, expected.vendor, false),
  };

  const page = withPage ? ((await preparePage(bytes)).page ?? null) : null;
  let answer: Awaited<ReturnType<typeof classifyReceiptText>> | null = null;
  try {
    answer = await classifyReceiptText({
      vendor: extracted.vendor,
      gross: extracted.gross,
      date: extracted.date,
      fullText,
      categoryNames: CATEGORY_NAMES,
      categoryToKonto: CATEGORY_TO_KONTO,
      zuordnungOptions: ZUORDNUNG_OPTIONS,
      page,
    });
    result.usage = answer.usage;
    // As in the app: an answer without a category is no classification.
    if (!answer.category) answer = null;
  } catch {
    answer = null;
  }
  const settled = settleReading(fullText, extracted, answer);
  result.reading = { ...judge(expected, settled, expected.vendor, answer?.sawPage ?? false), basis: settled.amounts.basis };
  if (result.reading.date === 'wrong' || result.reading.date === 'missing') {
    const modelDay = answer?.date?.slice(0, 10) ?? null;
    result.reading.dateCause = !answer
      ? 'no_model_answer'
      : modelDay === null
        ? 'model_gave_none'
        : modelDay === expected.date
          ? 'model_right'
          : modelDay === extracted.date?.slice(0, 10)
            ? 'model_agrees_with_text'
            : 'model_named_another_day';
  }
  if (result.reading.total !== 'correct') result.reading.cause = missCause(expected, answer ? answer.gross : undefined, settled.gross, fullText, answer?.noTotal ?? false);
  // How much of the document the model was given, and whether the text prints the table's total at all.
  if (result.reading.total !== 'correct' && expected.total !== null) {
    const printed = new RegExp(`(?<![\\d.,])${expected.total.toFixed(2).replace('.', '[.,]')}(?!\\d)`).test(fullText);
    result.reading.basis = `${result.reading.basis}; pages ${page?.pagesSent ?? '-'} of ${page?.pagesTotal ?? '-'}; table total ${printed ? 'printed' : 'not printed'} in the text`;
  }
  return result;
}

// ── Tallies ──────────────────────────────────────────────────────────

// A text-only run never shows the model the page, so `page_not_read` there is the mode, not a review flag.
export function tally(outcomes: Outcome[], textOnly = false) {
  const count = (pick: (o: Outcome) => boolean) => outcomes.filter(pick).length;
  const flagged = (o: Outcome) => o.flags.some((f) => f === 'total_conflict' || f === 'total_unconfirmed' || f === 'not_classified' || (f === 'page_not_read' && !textOnly));
  return {
    documents: outcomes.length,
    date: { correct: count((o) => o.date === 'correct'), wrong: count((o) => o.date === 'wrong'), missing: count((o) => o.date === 'missing'), notJudged: count((o) => o.date === 'not judged') },
    total: { correct: count((o) => o.total === 'correct'), wrong: count((o) => o.total === 'wrong'), missing: count((o) => o.total === 'missing') },
    // Judged only where the total is right and the table names the tax.
    net: { correct: count((o) => o.net === 'correct'), wrong: count((o) => o.net === 'wrong') },
    // Judged where the table names the vendor; a legal entity for the name a customer uses counts as wrong.
    vendor: { correct: count((o) => o.vendorVerdict === 'correct'), wrong: count((o) => o.vendorVerdict === 'wrong'), missing: count((o) => o.vendorVerdict === 'missing') },
    currency: { correct: count((o) => o.currency === 'correct'), wrong: count((o) => o.currency === 'wrong') },
    // The number that matters most: a wrong total stored with nothing asking for a look.
    wrongTotalWithoutFlag: count((o) => o.total === 'wrong' && !flagged(o)),
    wrongDateWithoutFlag: count((o) => o.date === 'wrong' && !o.flags.includes('date_conflict')),
    correctTotalButFlagged: count((o) => o.total === 'correct' && o.flags.some((f) => f === 'total_conflict' || f === 'total_unconfirmed')),
    sawPage: count((o) => o.sawPage),
  };
}

function countBy<T>(items: T[], key: (item: T) => string | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  for (const item of items) {
    const name = key(item);
    if (name !== undefined) out[name] = (out[name] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
}

function perVendor(outcomes: Outcome[]): Record<string, string> {
  const vendors = [...new Set(outcomes.map((o) => o.vendor))].sort();
  return Object.fromEntries(
    vendors.map((vendor) => {
      const own = outcomes.filter((o) => o.vendor === vendor);
      const n = (pick: (o: Outcome) => boolean) => own.filter(pick).length;
      const flagged = n((o) => o.flags.length > 0);
      return [
        vendor,
        `n=${own.length} vendor ${n((o) => o.vendorVerdict === 'correct')}/${own.length} date ${n((o) => o.date === 'correct')}/${own.length} (wrong ${n((o) => o.date === 'wrong')}, missing ${n((o) => o.date === 'missing')}) total ${n((o) => o.total === 'correct')}/${own.length} (wrong ${n((o) => o.total === 'wrong')}, missing ${n((o) => o.total === 'missing')}) net wrong ${n((o) => o.net === 'wrong')} flagged ${flagged}${flagged > 0 ? ` [${[...new Set(own.flatMap((o) => o.flags))].sort().join(',')}]` : ''}`,
      ];
    }),
  );
}

function report(name: string, outcomes: Outcome[], used?: Array<NonNullable<DocumentResult['usage']>>, textOnly = false) {
  console.log(`\n== ${name} ==`);
  console.log(JSON.stringify(tally(outcomes, textOnly), null, 2));
  console.log('flags:', JSON.stringify(countBy(outcomes.flatMap((o) => o.flags), (f) => f)));
  console.log('why a total was missed:', JSON.stringify(countBy(outcomes, (o) => (o.cause ? `${o.cause} (kept: ${o.basis})` : undefined))));
  console.log('why a date was missed:', JSON.stringify(countBy(outcomes, (o) => (o.dateCause ? `${o.dateCause} (${o.vendor})` : undefined))));
  console.log('what the totals rest on:', JSON.stringify(countBy(outcomes, (o) => o.basis)));
  console.log('what a wrong net rests on:', JSON.stringify(countBy(outcomes, (o) => (o.net === 'wrong' ? `${o.basis ?? 'text reader'} (${o.vendor})` : undefined))));
  console.log('what flagged totals rest on:', JSON.stringify(countBy(outcomes, (o) => (o.flags.some((f) => f === 'total_conflict' || f === 'total_unconfirmed') ? `${o.basis}, total ${o.total}` : undefined))));
  if (used && used.length > 0) {
    const sum = (pick: (u: NonNullable<DocumentResult['usage']>) => number) => used.reduce((total, u) => total + pick(u), 0);
    const cost = used.every((u) => u.cost !== null) ? sum((u) => u.cost ?? 0) : null;
    console.log(
      `model calls ${used.length}, input tokens ${sum((u) => u.inputTokens)}, output tokens ${sum((u) => u.outputTokens)}, cost ${cost === null ? 'not reported by the provider' : `${cost.toFixed(4)} US dollars (${(cost / used.length).toFixed(5)} per document)`}`,
    );
  }
  console.log('per vendor:', JSON.stringify(perVendor(outcomes), null, 2));
}

async function inBatches<T, R>(items: T[], size: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (next < items.length) {
        const index = next++;
        out[index] = await work(items[index]);
      }
    }),
  );
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const visionKey = process.env.GOOGLE_CLOUD_VISION_API_KEY;
  if (!visionKey) throw new Error('GOOGLE_CLOUD_VISION_API_KEY is not set');
  if (!process.env.OPENROUTER_API_KEY && !process.env.ANTHROPIC_API_KEY) throw new Error('No model key is set (OPENROUTER_API_KEY)');

  let rows = expectedRows(await readFile(args.table, 'utf-8'));
  if (args.retryMisses) {
    const former = JSON.parse(await readFile(args.retryMisses, 'utf-8')) as Record<string, DocumentResult>;
    rows = rows.filter((row) => {
      const reading = former[row.file]?.reading;
      return reading !== undefined && (reading.total !== 'correct' || reading.date !== 'correct');
    });
  }
  if (args.sample !== null) rows = pickSample(rows, args.sample, args.must);
  // The app reads the model from the environment.
  if (args.model) process.env.AI_CLASSIFY_MODEL = args.model;

  const results: Record<string, DocumentResult> = {};
  if (args.state) {
    try {
      Object.assign(results, JSON.parse(await readFile(args.state, 'utf-8')));
    } catch {
      // No former run: start from nothing.
    }
  }
  const open = rows.filter((row) => !(row.file in results));
  console.log(`documents: ${rows.length}, already read: ${rows.length - open.length}`);

  const started = Date.now();
  const inTime = () => args.maxSeconds === null || Date.now() - started < args.maxSeconds * 1000;
  let saving = Promise.resolve();
  await inBatches(open, args.concurrency, async (row) => {
    if (!inTime()) return;
    results[row.file] = await readDocument(row, args.folder, visionKey, !args.textOnly);
    // One writer at a time, after every document: a run that is cut off loses nothing it paid for.
    if (args.state) saving = saving.then(() => writeFile(args.state!, JSON.stringify(results)));
  });
  await saving;

  const read = rows.flatMap((row) => (results[row.file] ? [results[row.file]] : []));
  if (read.length < rows.length) {
    console.log(`stopped after ${args.maxSeconds} seconds: ${read.length} of ${rows.length} read. Run again with the same --state to go on.`);
    return;
  }
  console.log(`could not be read: ${JSON.stringify(countBy(read, (r) => (r.failed ? `${r.failed} (${r.text.vendor})` : undefined)))}`);
  const readable = read.filter((r) => !r.failed);
  report('text reader alone (no model)', readable.map((r) => r.text));
  report(
    `text and the model ${args.textOnly ? 'that reads the text alone' : 'that sees the page'} (${args.model ?? process.env.AI_CLASSIFY_MODEL ?? 'app default'})`,
    readable.flatMap((r) => (r.reading ? [r.reading] : [])),
    readable.flatMap((r) => (r.usage ? [r.usage] : [])),
    args.textOnly,
  );
}

// Run only as a script: the tests import the pure helpers above.
if (process.argv[1] && /evaluate-page-reading/.test(process.argv[1])) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : 'evaluation failed');
    process.exit(1);
  });
}
