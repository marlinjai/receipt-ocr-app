import { PDFDocument, StandardFonts } from 'pdf-lib';

/**
 * Statements of the Advanzia credit card for tests. Only the layout is the
 * real one: card number, merchants, places and amounts are all invented.
 */

export interface StatementRow {
  /** DD.MM.YYYY */
  day: string;
  text: string;
  place?: string;
  /** The card's own way: positive is money spent, "-2.000,00" is money onto the card. */
  amount: string;
}

export interface Statement {
  from: string;
  to: string;
  oldBalance: string;
  rows: StatementRow[];
  /** The new balance as printed; by default the one the rows lead to. */
  newBalance?: string;
}

const cents = (amount: string) => Math.round(Number(amount.replace(/\./g, '').replace(',', '.')) * 100);
const german = (c: number) => {
  const abs = Math.abs(c);
  const euros = Math.floor(abs / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${c < 0 ? '-' : ''}${euros},${String(abs % 100).padStart(2, '0')}`;
};

export function newBalanceOf(s: Statement): string {
  return s.newBalance ?? german(cents(s.oldBalance) + s.rows.reduce((sum, r) => sum + cents(r.amount), 0));
}

/** The lines of the statement's table and what frames it, each line as its cells. */
function statementLines(s: Statement): string[][] {
  return [
    ['Rechnung Gebührenfrei Mastercard Gold (Kreditkartennummer: ************1234)'],
    [`Abrechnung vom ${s.from} bis ${s.to}`, `Rechnung vom ${s.to}`],
    ['Datum', 'Beschreibung', 'Ort', 'Betrag EUR'],
    ['', 'ALTER SALDO', '', s.oldBalance],
    ...s.rows.map((r) => [r.day, r.text, r.place ?? '', r.amount]),
    [s.to, 'NEUER SALDO', '', newBalanceOf(s)],
    ['', 'Mindestbetrag fällig am 22.04.2026', '', '30,00'],
    ['Kreditlimit', 'Verfügbar', 'Saldo', 'Mindestbetrag', 'Fällig am'],
    ['5.000,00', '4.000,00', newBalanceOf(s), '30,00', '22.04.2026'],
  ];
}

/** The statement as `pdftotext -layout` prints it; `indent` puts a space before every line, as some statements have. */
export function statementText(s: Statement, indent = false): string {
  const widths = [18, 88, 26, 14];
  return statementLines(s)
    .map((cells) => {
      const line = cells.length === 4 ? cells.map((c, i) => (i === 3 ? c.padStart(widths[3]) : c.padEnd(widths[i]))).join('') : cells.join('     ');
      return `${indent ? ' ' : ''}${line.trimEnd()}`;
    })
    .join('\n');
}

/**
 * The statement as a PDF, drawn the way the bank lays it out: columns at fixed
 * places, amounts right-aligned, `rowsPerPage` rows of the table on a page
 * before it continues on the next.
 */
export async function statementPdf(s: Statement, rowsPerPage = 40): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const size = 8;
  const columns = [40, 110, 380];
  const right = 560;
  const lines = statementLines(s);
  let page = doc.addPage([595, 842]);
  let y = 800;
  let onPage = 0;
  for (const cells of lines) {
    if (onPage === rowsPerPage) {
      // The next page repeats the table's head, like the bank's.
      page = doc.addPage([595, 842]);
      y = 800;
      onPage = 0;
      ['Datum', 'Beschreibung', 'Ort'].forEach((c, i) => page.drawText(c, { x: columns[i], y, size, font }));
      page.drawText('Betrag EUR', { x: right - font.widthOfTextAtSize('Betrag EUR', size), y, size, font });
      y -= 14;
    }
    if (cells.length === 4) {
      cells.slice(0, 3).forEach((c, i) => c && page.drawText(c, { x: columns[i], y, size, font }));
      page.drawText(cells[3], { x: right - font.widthOfTextAtSize(cells[3], size), y, size, font });
    } else {
      cells.forEach((c, i) => page.drawText(c, { x: 40 + i * (520 / cells.length), y, size, font }));
    }
    y -= 14;
    onPage += 1;
  }
  return doc.save();
}
