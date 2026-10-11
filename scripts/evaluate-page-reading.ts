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
 * `vendor`, `invoice_date` (YYYY-MM-DD), `total_gross` (empty when the
 * document states no total) and `duplicate_of` (rows that name another file
 * are skipped).
 *
 * Options:
 *   --sample <n>          read at most n documents, spread over the vendors
 *   --must <a,b,...>      vendors (parts of their names) the sample must contain
 *   --model <id>          the model that sees the page (default: the app's)
 *   --before <id>         also read every document from its text alone with this
 *                         model, as production did before the page reading
 *   --state <file>        keep each document's outcome in this file (it holds the
 *                         amounts read, so keep it out of the repository)
 *   --retry-misses <file> read only the documents a former run got wrong
 *   --concurrency <n>     documents read at once (default 4)
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
import { CATEGORY_TO_KONTO, ZUORDNUNG_OPTIONS } from '@/lib/receipts-constants';
import { recognizeText } from '@/lib/text-recognition';

interface Expected {
  file: string;
  vendor: string;
  /** YYYY-MM-DD. */
  date: string;
  /** Null when the document states no total. */
  total: number | null;
}

type Verdict = 'correct' | 'wrong' | 'missing';

/** Why the settled total is not the table's, by what the model itself answered. */
type MissCause =
  | 'model_right_not_printed_in_text'
  | 'model_right_overruled_by_text'
  | 'model_wrong_and_taken'
  | 'model_wrong_text_kept'
  | 'model_gave_none'
  | 'model_named_a_total_where_there_is_none'
  | 'no_model_answer';

interface Outcome {
  vendor: string;
  date: Verdict;
  total: Verdict;
  flags: string[];
  sawPage: boolean;
  cause?: MissCause;
}

interface DocumentResult {
  /** The text reader alone, no model. */
  text: Outcome;
  /** Text and a model that read the text alone (`--before`). */
  before?: Outcome;
  /** Text and the model that sees the page. */
  page?: Outcome;
  /** Set when the document could not be read at all (recognition failed, file gone). */
  failed?: 'recognition' | 'file';
}

interface Usage {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cost: number;
  costKnown: boolean;
}

// ── Arguments ────────────────────────────────────────────────────────

function parseArgs(argv: string[]) {
  const positional: string[] = [];
  const options = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) options.set(argv[i].slice(2), argv[++i] ?? '');
    else positional.push(argv[i]);
  }
  if (positional.length !== 2) {
    throw new Error('Usage: evaluate-page-reading <folder> <table.csv> [--sample n] [--must a,b] [--model id] [--before id] [--state file] [--retry-misses file] [--concurrency n]');
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
    before: options.get('before') || null,
    state: options.get('state') || null,
    retryMisses: options.get('retry-misses') || null,
    concurrency: number('concurrency', 4),
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

function expectedRows(csv: string): Expected[] {
  const out: Expected[] = [];
  for (const row of parseCsv(csv)) {
    if (!row.file || row.duplicate_of) continue;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(row.invoice_date ?? '')) continue;
    const total = row.total_gross === '' ? null : Number(row.total_gross);
    if (total !== null && !Number.isFinite(total)) continue;
    out.push({ file: row.file, vendor: row.vendor || 'unknown', date: row.invoice_date, total });
  }
  return out;
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

function judge(expected: Expected, settled: Pick<SettledReading, 'date' | 'gross' | 'flags'>, vendor: string, sawPage: boolean): Outcome {
  const day = settled.date?.slice(0, 10) ?? null;
  const date: Verdict = day === null ? 'missing' : day === expected.date ? 'correct' : 'wrong';
  let total: Verdict;
  if (expected.total === null) total = settled.gross === null ? 'correct' : 'wrong';
  else total = settled.gross === null ? 'missing' : sameAmount(settled.gross, expected.total) ? 'correct' : 'wrong';
  return { vendor, date, total, flags: settled.flags, sawPage };
}

function missCause(expected: Expected, modelGross: number | null | undefined, settledGross: number | null, fullText: string): MissCause {
  if (modelGross === undefined) return 'no_model_answer';
  if (expected.total === null) return modelGross !== null ? 'model_named_a_total_where_there_is_none' : 'model_wrong_text_kept';
  if (modelGross === null) return 'model_gave_none';
  if (sameAmount(modelGross, expected.total)) {
    const printed = amountsInText(fullText).some((a) => a.cents === Math.round(expected.total! * 100));
    return printed ? 'model_right_overruled_by_text' : 'model_right_not_printed_in_text';
  }
  return settledGross !== null && sameAmount(settledGross, modelGross) ? 'model_wrong_and_taken' : 'model_wrong_text_kept';
}

const CATEGORY_NAMES = Object.keys(CATEGORY_TO_KONTO);
/** The model the environment names when the script starts; `--model` and `--before` override it per reading. */
const CONFIGURED_MODEL = process.env.AI_CLASSIFY_MODEL;

async function readDocument(
  expected: Expected,
  folder: string,
  visionKey: string,
  models: { page: string | null; before: string | null },
  usage: { page: Usage; before: Usage },
): Promise<DocumentResult> {
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
    text: judge(expected, { date: extracted.date, gross: extracted.gross, flags: [] }, expected.vendor, false),
  };

  const ask = async (model: string | null, withPage: boolean, tally: Usage): Promise<Outcome> => {
    // The app reads the model from the environment; the two readings of a document run one after the other.
    if (model) process.env.AI_CLASSIFY_MODEL = model;
    else if (CONFIGURED_MODEL === undefined) delete process.env.AI_CLASSIFY_MODEL;
    else process.env.AI_CLASSIFY_MODEL = CONFIGURED_MODEL;
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
      tally.calls++;
      tally.inputTokens += answer.usage.inputTokens;
      tally.outputTokens += answer.usage.outputTokens;
      if (answer.usage.cost === null) tally.costKnown = false;
      else tally.cost += answer.usage.cost;
      // As in the app: an answer without a category is no classification.
      if (!answer.category) answer = null;
    } catch {
      answer = null;
    }
    const settled = settleReading(fullText, extracted, answer);
    const outcome = judge(expected, settled, expected.vendor, answer?.sawPage ?? false);
    if (outcome.total !== 'correct') outcome.cause = missCause(expected, answer ? answer.gross : undefined, settled.gross, fullText);
    return outcome;
  };

  if (models.before) result.before = await ask(models.before, false, usage.before);
  result.page = await ask(models.page, true, usage.page);
  return result;
}

// ── Tallies ──────────────────────────────────────────────────────────

function tally(outcomes: Outcome[]) {
  const count = (pick: (o: Outcome) => boolean) => outcomes.filter(pick).length;
  const flagged = (o: Outcome) => o.flags.some((f) => f === 'total_conflict' || f === 'total_unconfirmed' || f === 'not_classified' || f === 'page_not_read');
  return {
    documents: outcomes.length,
    date: { correct: count((o) => o.date === 'correct'), wrong: count((o) => o.date === 'wrong'), missing: count((o) => o.date === 'missing') },
    total: { correct: count((o) => o.total === 'correct'), wrong: count((o) => o.total === 'wrong'), missing: count((o) => o.total === 'missing') },
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
      return [vendor, `n=${own.length} date ${n((o) => o.date === 'correct')}/${own.length} total ${n((o) => o.total === 'correct')}/${own.length} (wrong ${n((o) => o.total === 'wrong')}, missing ${n((o) => o.total === 'missing')})`];
    }),
  );
}

function report(name: string, outcomes: Outcome[], usage?: Usage) {
  console.log(`\n== ${name} ==`);
  console.log(JSON.stringify(tally(outcomes), null, 2));
  console.log('flags:', JSON.stringify(countBy(outcomes.flatMap((o) => o.flags), (f) => f)));
  console.log('why a total was missed:', JSON.stringify(countBy(outcomes, (o) => o.cause)));
  if (usage) {
    const each = usage.calls > 0 ? usage.cost / usage.calls : 0;
    console.log(
      `model calls ${usage.calls}, input tokens ${usage.inputTokens}, output tokens ${usage.outputTokens}, cost ${usage.costKnown ? `${usage.cost.toFixed(4)} US dollars (${each.toFixed(5)} per document)` : 'not reported by the provider'}`,
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
      const page = former[row.file]?.page;
      return page !== undefined && (page.total !== 'correct' || page.date !== 'correct');
    });
  }
  if (args.sample !== null) rows = pickSample(rows, args.sample, args.must);
  console.log(`documents to read: ${rows.length}`);

  const usage = {
    page: { calls: 0, inputTokens: 0, outputTokens: 0, cost: 0, costKnown: true },
    before: { calls: 0, inputTokens: 0, outputTokens: 0, cost: 0, costKnown: true },
  };
  const results: Record<string, DocumentResult> = {};
  // With `--before` two models take turns through one environment variable, so the documents are read one at a time.
  const concurrency = args.before ? 1 : args.concurrency;
  const read = await inBatches(rows, concurrency, (row) => readDocument(row, args.folder, visionKey, { page: args.model, before: args.before }, usage));
  rows.forEach((row, i) => (results[row.file] = read[i]));
  if (args.state) await writeFile(args.state, JSON.stringify(results));

  const all = Object.values(results);
  console.log(`could not be read: ${JSON.stringify(countBy(all, (r) => r.failed))}`);
  const readable = all.filter((r) => !r.failed);
  report('text reader alone (no model)', readable.map((r) => r.text));
  if (args.before) report(`text and a model that reads the text alone (${args.before})`, readable.flatMap((r) => (r.before ? [r.before] : [])), usage.before);
  report(`text and the model that sees the page (${args.model ?? 'app default'})`, readable.flatMap((r) => (r.page ? [r.page] : [])), usage.page);
}

// Run only as a script: the tests import the pure helpers above.
if (process.argv[1] && /evaluate-page-reading/.test(process.argv[1])) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : 'evaluation failed');
    process.exit(1);
  });
}
