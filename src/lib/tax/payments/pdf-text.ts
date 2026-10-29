import { PaymentParseError } from './types';

/**
 * The text of a statement PDF, on the server, as lines a reader can split into
 * columns. A PDF holds pieces of text at positions, not lines: pieces on the
 * same height form one line, left to right, and a gap wider than about one
 * letter becomes two spaces, so columns stay apart the way `pdftotext -layout`
 * keeps them ("Wolt  Berlin  19,11", never "Wolt Berlin 19,11"). Pages follow
 * each other in order. Uses the same pdf.js the browser draws receipts with,
 * in its build for servers.
 */

const MAX_BYTES = 8 * 1024 * 1024;
/** No monthly statement has this many pages; a file that does is no statement and is not read through. */
const MAX_PAGES = 100;
/** A gap wider than this share of the letter height parts two columns; a smaller one parts two words. */
const COLUMN_GAP = 0.9;
const WORD_GAP = 0.15;

interface Piece {
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

/** One page's pieces as lines, top to bottom. */
export function piecesToLines(pieces: readonly Piece[]): string[] {
  const rows: Array<{ y: number; height: number; pieces: Piece[] }> = [];
  for (const piece of pieces) {
    // Pieces of one line can sit a little higher or lower (a smaller font, a superscript): within half a letter they are one line.
    const row = rows.find((r) => Math.abs(r.y - piece.y) <= Math.max(r.height, piece.height) / 2);
    if (row) row.pieces.push(piece);
    else rows.push({ y: piece.y, height: piece.height, pieces: [piece] });
  }
  // PDF heights grow upwards: the top line has the largest one.
  rows.sort((a, b) => b.y - a.y);
  return rows.map((row) => {
    const ordered = [...row.pieces].sort((a, b) => a.x - b.x);
    let line = '';
    let end: number | null = null;
    for (const piece of ordered) {
      if (end !== null) {
        const gap = piece.x - end;
        line += gap > row.height * COLUMN_GAP ? '  ' : gap > row.height * WORD_GAP ? ' ' : '';
      }
      line += piece.text;
      end = piece.x + piece.width;
    }
    return line;
  });
}

/**
 * The text of a PDF, line by line. `unreadable_pdf` when it is no PDF that can
 * be opened (damaged, protected by a password), `pdf_without_text` when it
 * holds pictures only (a scan), `too_large` beyond the size of an export.
 */
export async function pdfText(bytes: Uint8Array): Promise<string> {
  if (bytes.byteLength > MAX_BYTES) throw new PaymentParseError('too_large');
  // Every PDF starts with its marker (some writers put a few bytes before it); anything else is not opened at all.
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, 1024));
  if (!head.includes('%PDF-')) throw new PaymentParseError('unreadable_pdf');
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  // On a server pdf.js runs its worker in the same process. Handed over here it is found without loading a
  // file by a name computed at run time, which the server build would not know to ship.
  const globals = globalThis as { pdfjsWorker?: unknown };
  globals.pdfjsWorker ??= await import('pdfjs-dist/legacy/build/pdf.worker.mjs');
  // pdf.js takes the buffer over; a copy keeps the caller's bytes intact.
  const task = pdfjs.getDocument({ data: bytes.slice(), disableFontFace: true, useSystemFonts: false, verbosity: 0 });
  let doc: Awaited<typeof task.promise>;
  try {
    doc = await task.promise;
  } catch {
    void task.destroy();
    throw new PaymentParseError('unreadable_pdf');
  }
  try {
    if (doc.numPages > MAX_PAGES) throw new PaymentParseError('too_large');
    const lines: string[] = [];
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const content = await page.getTextContent();
      const pieces: Piece[] = [];
      for (const item of content.items) {
        if (!('str' in item) || item.str.trim() === '') continue;
        pieces.push({ text: item.str, x: item.transform[4], y: item.transform[5], width: item.width, height: Math.abs(item.transform[3]) || item.height || 1 });
      }
      lines.push(...piecesToLines(pieces));
      page.cleanup();
    }
    // Some writers set a letter with its accent as two signs ("u" and the two dots): one sign, so words compare as written.
    const text = lines.join('\n').normalize('NFC');
    if (text.trim() === '') throw new PaymentParseError('pdf_without_text');
    return text;
  } catch (e) {
    if (e instanceof PaymentParseError) throw e;
    throw new PaymentParseError('unreadable_pdf');
  } finally {
    void task.destroy();
  }
}
