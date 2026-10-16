/**
 * Read the text production stores again with the current text reader, and
 * count where it agrees with the stored date and total.
 *
 * The reader's date and total rules were measured on local text extraction of
 * the purchase documents, with labels torn from their amounts to imitate the
 * text recognition. This script checks them against the text the recognition
 * really returned: the "OCR Text" cell of every stored receipt. No model is
 * asked, nothing is written, and it prints COUNTS ONLY: never a document's
 * text, an amount, a date or a name. With `--ids` it also prints the row ids
 * of the receipts whose reading differs, so a person can look at them in the
 * app.
 *
 * A stored total the text alone does not lead to can still be one a page
 * reading settled (the customs invoice: the text proves the taxed part, the
 * page names the total above it). Where the current reader, handed the stored
 * total as the page's, settles on exactly that total without a conflict, the
 * stored total counts as borne out, as the review list judges it
 * (src/lib/review/reading.ts).
 *
 *   Against the database (read only; run where DATABASE_URL is injected, never paste it):
 *     npx tsx scripts/rerun-stored-readings.ts --database [--workspace <id>] [--ids]
 *   Against an export (a JSON array of { id, text, date, gross, currency }):
 *     npx tsx scripts/rerun-stored-readings.ts --export <file.json> [--ids]
 *
 * What the counts mean:
 *   date / total   agree, differ, read none (the reader finds nothing), stored none
 *   total differs  split by whether the reader itself is sure (no check) or not
 *   text           how many stored texts carry empty lines, and labels followed
 *                  by an empty line: whether the stored text looks like the
 *                  local extraction the rules were measured on
 */

import { readFile } from 'node:fs/promises';
import { extractReceiptFields } from '@/lib/extract-receipt-fields';
import { readAmounts } from '@/lib/extraction/amounts';
import { CURRENCY_OPTIONS } from '@/lib/receipts-constants';

/** One stored receipt, as far as the comparison needs it. */
export interface StoredRow {
  id: string;
  /** The recognized text stored with the receipt. */
  text: string;
  /** Any form the Date cell holds; compared as YYYY-MM-DD. */
  date: string | null;
  gross: number | null;
  /** ISO 4217 code; null reads as euros, as the app does. */
  currency: string | null;
}

type Verdict = 'agree' | 'differ' | 'read_none' | 'stored_none';

export interface RowResult {
  id: string;
  date: Verdict;
  total: Verdict;
  /** For a total that differs: the reader was sure of its own (no check), or not. */
  readerSure?: boolean;
}

const day = (value: string | null): string | null => {
  if (!value) return null;
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(value);
  if (match) return match[1];
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 10);
};
const sameAmount = (a: number, b: number) => Math.abs(a - b) < 0.005;

/** The current reader against one stored receipt. Pure. */
export function compareRow(row: StoredRow): RowResult | null {
  if (!row.text.trim()) return null;
  const read = extractReceiptFields({ fullText: row.text, blocks: [], confidence: 1 });
  const storedDay = day(row.date);
  const readDay = read.date?.slice(0, 10) ?? null;
  const date: Verdict = storedDay === null ? 'stored_none' : readDay === null ? 'read_none' : readDay === storedDay ? 'agree' : 'differ';

  let total: Verdict;
  let readerSure: boolean | undefined;
  if (row.gross === null) total = 'stored_none';
  else if (read.gross === null) total = 'read_none';
  else if (sameAmount(read.gross, row.gross)) total = 'agree';
  else {
    // The stored total as a page reading: borne out when the reader settles on it without a conflict.
    const currency = row.currency && CURRENCY_OPTIONS.includes(row.currency) ? row.currency : read.currency;
    const asPage = readAmounts(row.text, { date: read.date, currency, modelGross: row.gross, modelSawPage: true });
    if (asPage.gross !== null && sameAmount(asPage.gross, row.gross) && !asPage.checks.includes('total_conflict')) total = 'agree';
    else {
      total = 'differ';
      readerSure = read.amountChecks.length === 0 || (read.amountChecks.length === 1 && read.amountChecks[0] === 'tax_estimated');
    }
  }
  return { id: row.id, date, total, ...(readerSure !== undefined ? { readerSure } : {}) };
}

/** A label line ("Summe", "Total:") followed by an empty line, as local text extraction leaves them. */
const LABEL_THEN_BLANK = /^(?:[^\d\n]{2,40}):?\s*\n\s*\n/gmu;

export interface Tally {
  receipts: number;
  withoutText: number;
  date: Record<Verdict, number>;
  total: Record<Verdict, number>;
  totalDiffers: { readerSure: number; readerUnsure: number };
  text: { withEmptyLines: number; withLabelBeforeEmptyLine: number };
}

/** Counts over all rows. Pure. */
export function tally(rows: readonly StoredRow[]): { tally: Tally; differing: string[] } {
  const zero = (): Record<Verdict, number> => ({ agree: 0, differ: 0, read_none: 0, stored_none: 0 });
  const out: Tally = {
    receipts: rows.length,
    withoutText: 0,
    date: zero(),
    total: zero(),
    totalDiffers: { readerSure: 0, readerUnsure: 0 },
    text: { withEmptyLines: 0, withLabelBeforeEmptyLine: 0 },
  };
  const differing: string[] = [];
  for (const row of rows) {
    const result = compareRow(row);
    if (!result) {
      out.withoutText++;
      continue;
    }
    out.date[result.date]++;
    out.total[result.total]++;
    if (result.total === 'differ') out.totalDiffers[result.readerSure ? 'readerSure' : 'readerUnsure']++;
    if (result.date === 'differ' || result.total === 'differ') differing.push(row.id);
    if (/\n\s*\n/.test(row.text)) out.text.withEmptyLines++;
    if (LABEL_THEN_BLANK.test(row.text)) out.text.withLabelBeforeEmptyLine++;
    LABEL_THEN_BLANK.lastIndex = 0;
  }
  return { tally: out, differing };
}

/** An export file: a JSON array of stored rows. Anything malformed is refused, never guessed. */
export function parseExport(json: string): StoredRow[] {
  const data: unknown = JSON.parse(json);
  if (!Array.isArray(data)) throw new Error('The export must be a JSON array of rows.');
  return data.map((raw, i) => {
    const r = raw as Record<string, unknown>;
    if (typeof r?.id !== 'string' || typeof r.text !== 'string') throw new Error(`Row ${i} has no id or no text.`);
    const gross = r.gross === null || r.gross === undefined || r.gross === '' ? null : Number(r.gross);
    if (gross !== null && !Number.isFinite(gross)) throw new Error(`Row ${i} has a total that is no number.`);
    return {
      id: r.id,
      text: r.text,
      date: typeof r.date === 'string' ? r.date : null,
      gross,
      currency: typeof r.currency === 'string' && r.currency ? r.currency : null,
    };
  });
}

/** Every receipt of the Receipts tables, read only, through the app's own table adapter. */
async function rowsFromDatabase(workspace: string | null): Promise<StoredRow[]> {
  const { prisma } = await import('@/lib/prisma');
  const { PrismaAdapter } = await import('@marlinjai/data-table-adapter-prisma');
  const { isGroupRow } = await import('@/lib/receipts-kind');
  const adapter = new PrismaAdapter({ prisma });
  const tables = await prisma.dtTable.findMany({ where: { name: 'Receipts', ...(workspace ? { workspaceId: workspace } : {}) }, select: { id: true } });
  const out: StoredRow[] = [];
  for (const table of tables) {
    const columns = await adapter.getColumns(table.id);
    const id = (name: string) => columns.find((c) => c.name === name)?.id;
    const [textId, dateId, grossId, currencyId] = [id('OCR Text'), id('Date'), id('Gross'), id('Currency')];
    if (!textId) continue;
    const currencyNames = new Map(currencyId ? (await adapter.getSelectOptions(currencyId)).map((o) => [o.id, o.name]) : []);
    for (let offset = 0; ; ) {
      const page = await adapter.getRows(table.id, { limit: 500, offset });
      for (const row of page.items) {
        if (row.archived || isGroupRow(row, columns)) continue;
        const cell = (columnId: string | undefined) => (columnId ? row.cells[columnId] : null);
        const gross = cell(grossId);
        const currency = cell(currencyId);
        out.push({
          id: row.id,
          text: typeof cell(textId) === 'string' ? (cell(textId) as string) : '',
          date: typeof cell(dateId) === 'string' ? (cell(dateId) as string) : null,
          gross: typeof gross === 'number' ? gross : gross === null || gross === undefined || gross === '' ? null : Number(gross),
          currency: typeof currency === 'string' ? (currencyNames.get(currency) ?? null) : null,
        });
      }
      if (!page.hasMore || page.items.length === 0) break;
      offset += page.items.length;
    }
  }
  await prisma.$disconnect();
  return out;
}

function parseArgs(argv: string[]) {
  const value = (flag: string) => {
    const i = argv.indexOf(flag);
    if (i === -1) return null;
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) throw new Error(`${flag} needs a value`);
    return v;
  };
  const database = argv.includes('--database');
  const exportFile = value('--export');
  if (database === (exportFile !== null)) throw new Error('Usage: rerun-stored-readings (--database [--workspace <id>] | --export <file.json>) [--ids]');
  return { database, exportFile, workspace: value('--workspace'), ids: argv.includes('--ids') };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const rows = args.exportFile ? parseExport(await readFile(args.exportFile, 'utf-8')) : await rowsFromDatabase(args.workspace);
  const { tally: counts, differing } = tally(rows);
  console.log(JSON.stringify(counts, null, 2));
  if (args.ids) console.log('rows whose reading differs:', JSON.stringify(differing));
}

// Run only as a script: the tests import the pure helpers above.
if (process.argv[1] && /rerun-stored-readings/.test(process.argv[1])) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : 'the rerun failed');
    process.exit(1);
  });
}
