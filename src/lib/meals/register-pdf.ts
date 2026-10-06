import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFImage, type PDFPage } from 'pdf-lib';
import { formatGuest } from '@/lib/contacts/store';
import { MISSING_FIELD_LABELS } from './rules';
import type { MealRegister, RegisterEntry } from './register';
import type { MealFile } from './types';

/**
 * The register as a Portable Document Format (PDF) file: a summary table for
 * the year, then one sheet per meal with the legally required facts, the
 * receipt, and a blank line for place, date and signature.
 *
 * The entry timestamp is deliberately NOT printed: the sheet is dated and
 * signed by hand. The app cannot sign.
 *
 * Fonts: the built-in Helvetica covers German text (the Windows-1252
 * character set). A character outside it, for example in a guest's name, is
 * reduced to its base letter where possible and to "?" otherwise, and the
 * result carries a warning naming the count, so nothing changes silently.
 */

export type LoadedFile = { bytes: Uint8Array; mimeType: string };
export type ReceiptFileLoader = (file: MealFile) => Promise<LoadedFile | null>;

export interface RegisterPdfInput {
  register: MealRegister;
  /** Printed in the header so a register cannot be mistaken for another company's. */
  workspaceLabel: string;
  generatedAt: Date;
  loadFile: ReceiptFileLoader;
}

export interface RegisterPdfResult {
  bytes: Uint8Array;
  /** Human-readable notes about anything that could not be rendered exactly. */
  warnings: string[];
}

const A4 = { w: 595.28, h: 841.89 };
const MARGIN = 42;
const INK = rgb(0.1, 0.1, 0.12);
const MUTED = rgb(0.4, 0.4, 0.44);
const RULE = rgb(0.75, 0.75, 0.78);

function euro(value: number | null | undefined): string {
  if (value === null || value === undefined) return '';
  const [whole, frac] = Math.abs(value).toFixed(2).split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${value < 0 ? '-' : ''}${grouped},${frac} EUR`;
}

function dateDE(isoDay: string | null): string {
  if (!isoDay) return '';
  const [y, m, d] = isoDay.split('-');
  return `${d}.${m}.${y}`;
}

class Writer {
  private readonly supported: Set<number>;
  replaced = 0;

  constructor(
    readonly doc: PDFDocument,
    readonly font: PDFFont,
    readonly bold: PDFFont,
  ) {
    this.supported = new Set(font.getCharacterSet());
  }

  /** Make text encodable in the built-in font; count what had to be replaced. */
  safe(input: string): string {
    let out = '';
    for (const ch of input.replace(/[\r\n\t]+/g, ' ')) {
      const cp = ch.codePointAt(0)!;
      if (this.supported.has(cp)) {
        out += ch;
        continue;
      }
      const base = ch.normalize('NFKD').replace(/[̀-ͯ]/g, '');
      if (base && [...base].every((b) => this.supported.has(b.codePointAt(0)!))) {
        out += base;
      } else {
        out += '?';
      }
      this.replaced += 1;
    }
    return out;
  }

  width(text: string, size: number, font: PDFFont = this.font): number {
    return font.widthOfTextAtSize(text, size);
  }

  /** Break text into lines no wider than `maxWidth`, splitting over-long words. */
  wrap(input: string, size: number, maxWidth: number, font: PDFFont = this.font): string[] {
    const text = this.safe(input).trim();
    if (!text) return [''];
    const lines: string[] = [];
    let line = '';
    for (const word of text.split(/\s+/)) {
      let piece = word;
      while (this.width(piece, size, font) > maxWidth && piece.length > 1) {
        let cut = piece.length - 1;
        while (cut > 1 && this.width(piece.slice(0, cut), size, font) > maxWidth) cut -= 1;
        if (line) {
          lines.push(line);
          line = '';
        }
        lines.push(piece.slice(0, cut));
        piece = piece.slice(cut);
      }
      const candidate = line ? `${line} ${piece}` : piece;
      if (this.width(candidate, size, font) <= maxWidth) {
        line = candidate;
      } else {
        lines.push(line);
        line = piece;
      }
    }
    if (line) lines.push(line);
    return lines;
  }

  text(page: PDFPage, value: string, x: number, y: number, size: number, opts: { bold?: boolean; muted?: boolean; right?: number } = {}) {
    const font = opts.bold ? this.bold : this.font;
    const safe = this.safe(value);
    const drawX = opts.right !== undefined ? opts.right - this.width(safe, size, font) : x;
    page.drawText(safe, { x: drawX, y, size, font, color: opts.muted ? MUTED : INK });
  }

  rule(page: PDFPage, x1: number, x2: number, y: number) {
    page.drawLine({ start: { x: x1, y }, end: { x: x2, y }, thickness: 0.6, color: RULE });
  }
}

// ── Summary table (landscape) ───────────────────────────────────────────────

interface ColumnSpec {
  title: string;
  width: number;
  align?: 'right';
  value: (e: RegisterEntry) => string;
}

/** Printable width of the landscape summary page. */
export const SUMMARY_TABLE_WIDTH = A4.h - 2 * MARGIN;

/**
 * The summary columns, sized to fill the printable width exactly: the amount
 * columns are fixed, the three text columns share whatever is left. (The net
 * basis has two more amount columns; with hand-set widths that table once ran
 * off the right edge of the page.)
 */
export function summaryColumns(register: Pick<MealRegister, 'basis'>): ColumnSpec[] {
  const net = register.basis === 'net';
  const amount = (e: RegisterEntry, pick: (d: NonNullable<RegisterEntry['deduction']>) => number | null) =>
    e.deduction ? euro(pick(e.deduction)).replace(' EUR', '') : '';
  const fixed: ColumnSpec[] = [
    { title: 'Nr.', width: 24, value: (e) => String(e.no) },
    { title: 'Datum', width: 52, value: (e) => dateDE(e.record.date) },
  ];
  const amounts: ColumnSpec[] = [
    { title: 'Brutto', width: 54, align: 'right', value: (e) => amount(e, (d) => d.gross) },
    { title: 'Trinkgeld', width: 48, align: 'right', value: (e) => amount(e, (d) => d.tip) },
  ];
  if (net) {
    amounts.push(
      { title: 'Netto', width: 54, align: 'right', value: (e) => amount(e, (d) => d.net) },
      { title: 'Vorsteuer', width: 50, align: 'right', value: (e) => amount(e, (d) => d.inputVat) },
    );
  }
  amounts.push(
    { title: 'Abziehbar 70 %', width: 66, align: 'right', value: (e) => amount(e, (d) => d.deductible) },
    { title: 'Nicht abz. 30 %', width: 66, align: 'right', value: (e) => amount(e, (d) => d.nonDeductible) },
  );
  const used = [...fixed, ...amounts].reduce((sum, c) => sum + c.width, 0);
  const flexible = SUMMARY_TABLE_WIDTH - used;
  const textCols: ColumnSpec[] = [
    { title: 'Ort', width: flexible * 0.32, value: (e) => e.record.place },
    {
      title: 'Bewirtete Personen',
      width: flexible * 0.34,
      value: (e) => e.record.guests.map((g) => formatGuest(g.name, g.company)).join(', '),
    },
    { title: 'Anlass', width: flexible * 0.34, value: (e) => e.record.occasion },
  ];
  return [...fixed, ...textCols, ...amounts];
}

function drawSummary(w: Writer, input: RegisterPdfInput) {
  const { register } = input;
  const pageW = A4.h;
  const pageH = A4.w;
  const cols = summaryColumns(register);
  const size = 8;
  const lineH = 10.5;
  const pad = 3;
  let page = w.doc.addPage([pageW, pageH]);
  let y = pageH - MARGIN;

  const header = (first: boolean) => {
    w.text(page, `Bewirtungsverzeichnis ${register.year}`, MARGIN, y - 4, 16, { bold: true });
    w.text(page, input.workspaceLabel, 0, y - 2, 10, { right: pageW - MARGIN, muted: true });
    y -= 24;
    if (first) {
      const basis =
        register.basis === 'gross'
          ? 'Kleinunternehmer nach § 19 UStG: kein Vorsteuerabzug, 70 % vom Bruttobetrag zuzüglich Trinkgeld.'
          : 'Vorsteuerabzug: 70 % vom Nettobetrag zuzüglich Trinkgeld, Vorsteuer in voller Höhe gesondert.';
      w.text(page, `Bewirtungsaufwendungen nach § 4 Abs. 5 Nr. 2 EStG. ${basis}`, MARGIN, y, 8.5, { muted: true });
      y -= 12;
      const stamp = input.generatedAt.toISOString().replace('T', ' ').slice(0, 16);
      w.text(page, `Erstellt am ${stamp} UTC`, MARGIN, y, 8.5, { muted: true });
      y -= 16;
    }
    let x = MARGIN;
    for (const col of cols) {
      if (col.align === 'right') w.text(page, col.title, 0, y, size, { bold: true, right: x + col.width - pad });
      else w.text(page, col.title, x + pad, y, size, { bold: true });
      x += col.width;
    }
    y -= 5;
    w.rule(page, MARGIN, x, y);
    y -= lineH;
  };

  const newPage = () => {
    page = w.doc.addPage([pageW, pageH]);
    y = pageH - MARGIN;
    header(false);
  };

  header(true);
  const tableRight = MARGIN + cols.reduce((s, c) => s + c.width, 0);

  for (const entry of register.entries) {
    const cells = cols.map((col) => w.wrap(col.value(entry), size, col.width - 2 * pad));
    const rows = Math.max(...cells.map((c) => c.length));
    if (y - rows * lineH < MARGIN + 30) newPage();
    let x = MARGIN;
    cols.forEach((col, i) => {
      cells[i].forEach((line, li) => {
        const ly = y - li * lineH;
        if (col.align === 'right') w.text(page, line, 0, ly, size, { right: x + col.width - pad });
        else w.text(page, line, x + pad, ly, size);
      });
      x += col.width;
    });
    y -= rows * lineH + 3;
    w.rule(page, MARGIN, tableRight, y + lineH - 2.5);
  }

  if (register.entries.length === 0) {
    w.text(page, 'Keine vollständigen Bewirtungen in diesem Jahr.', MARGIN + pad, y, 9, { muted: true });
    y -= lineH + 4;
  }

  if (register.totals) {
    if (y < MARGIN + 60) newPage();
    y -= 4;
    const t = register.totals;
    const totalValues: Record<string, string> = {
      Brutto: euro(t.gross),
      Trinkgeld: euro(t.tip),
      Netto: euro(t.net),
      Vorsteuer: euro(t.inputVat),
      'Abziehbar 70 %': euro(t.deductible),
      'Nicht abz. 30 %': euro(t.nonDeductible),
    };
    let x = MARGIN;
    w.text(page, 'Summe', x + pad, y, size, { bold: true });
    for (const col of cols) {
      const value = totalValues[col.title];
      if (value) w.text(page, value.replace(' EUR', ''), 0, y, size, { bold: true, right: x + col.width - pad });
      x += col.width;
    }
    y -= lineH + 8;
    w.text(
      page,
      `Abziehbar (Konto 4650): ${euro(t.deductible)}    Nicht abziehbar (Konto 4654): ${euro(t.nonDeductible)}    Alle Beträge in Euro.`,
      MARGIN,
      y,
      8.5,
    );
    y -= lineH + 8;
  }

  const note = (line: string, bold = false) => {
    for (const part of w.wrap(line, 8.5, pageW - 2 * MARGIN, bold ? w.bold : w.font)) {
      if (y < MARGIN + 12) newPage();
      w.text(page, part, MARGIN, y, 8.5, { bold, muted: !bold });
      y -= 11.5;
    }
  };

  if (register.vatEstimatedCount > 0) {
    note(
      `Hinweis: Bei ${register.vatEstimatedCount} Einträgen ist die Umsatzsteuer geschätzt (keine Steuerzeilen erfasst).`,
    );
  }
  if (register.vatMismatchCount > 0) {
    note(`Hinweis: Bei ${register.vatMismatchCount} Einträgen weichen die Steuerzeilen vom Rechnungsbetrag ab.`);
  }
  const separate: string[] = [];
  if (register.staffMeals.count) separate.push(`Mitarbeiterbewirtung: ${register.staffMeals.count} (${euro(register.staffMeals.grossEur)})`);
  if (register.travelMeals.count) separate.push(`Verpflegung auf Reise: ${register.travelMeals.count} (${euro(register.travelMeals.grossEur)})`);
  if (separate.length) note(`Nicht Teil dieses Verzeichnisses: ${separate.join(', ')}.`);

  if (register.incomplete.length > 0) {
    y -= 6;
    note(`Unvollständig, nicht in den Summen enthalten (${register.incomplete.length}):`, true);
    for (const entry of register.incomplete) {
      const r = entry.record;
      const what = [dateDE(r.date) || 'ohne Datum', r.place || r.vendor || r.name || 'ohne Ort', euro(r.gross)].filter(Boolean).join(', ');
      note(`${what}. Es fehlt: ${entry.missing.map((m) => MISSING_FIELD_LABELS[m]).join(', ')}.`);
    }
  }
}

// ── One sheet per meal (portrait) ───────────────────────────────────────────

async function drawMealSheet(w: Writer, input: RegisterPdfInput, entry: RegisterEntry, warnings: string[]) {
  const { record, deduction } = entry;
  const page = w.doc.addPage([A4.w, A4.h]);
  const right = A4.w - MARGIN;
  const labelW = 150;
  const valueX = MARGIN + labelW;
  const valueW = right - valueX;
  let y = A4.h - MARGIN;

  w.text(page, 'Bewirtungsbeleg', MARGIN, y - 6, 18, { bold: true });
  w.text(page, `Nr. ${entry.no} / ${input.register.year}`, 0, y - 4, 11, { right, muted: true });
  y -= 26;
  w.text(page, 'Angaben zum Nachweis von Bewirtungsaufwendungen nach § 4 Abs. 5 Nr. 2 EStG', MARGIN, y, 8.5, { muted: true });
  w.text(page, input.workspaceLabel, 0, y, 8.5, { right, muted: true });
  y -= 10;
  w.rule(page, MARGIN, right, y);
  y -= 20;

  const field = (label: string, value: string | string[], opts: { bold?: boolean } = {}) => {
    const lines = (Array.isArray(value) ? value : [value]).flatMap((v) => w.wrap(v, 10.5, valueW, opts.bold ? w.bold : w.font));
    w.text(page, label, MARGIN, y, 9.5, { muted: true });
    lines.forEach((line, i) => w.text(page, line, valueX, y - i * 14, 10.5, { bold: opts.bold }));
    y -= lines.length * 14 + 8;
  };

  field('Tag der Bewirtung', dateDE(record.date));
  field('Ort der Bewirtung', record.place);
  field(
    'Bewirtete Personen',
    record.guests.map((g, i) => `${i + 1}. ${formatGuest(g.name, g.company)}`),
  );
  field('Anlass der Bewirtung', record.occasion);
  field('Gastgeber', record.host);
  y -= 4;
  w.rule(page, MARGIN, right, y + 6);
  y -= 8;

  if (deduction) {
    field('Rechnungsbetrag (brutto)', euro(deduction.gross));
    field('Trinkgeld', deduction.tip > 0 ? euro(deduction.tip) : 'keines');
    if (deduction.basis === 'net') {
      field('Nettobetrag', `${euro(deduction.net)}${deduction.vatEstimated ? ' (Umsatzsteuer geschätzt)' : ''}`);
      field('Vorsteuer', euro(deduction.inputVat));
    }
    field('Bemessungsgrundlage', euro(deduction.base));
    field('Abziehbar (70 %)', euro(deduction.deductible), { bold: true });
    field('Nicht abziehbar (30 %)', euro(deduction.nonDeductible));
    if (record.currency !== 'EUR') {
      field('Währung des Belegs', `${record.currency}, umgerechnet mit Kurs ${record.fxRate}`);
    }
  }

  // Blank line for place, date and signature: filled in by hand.
  y -= 26;
  const half = (right - MARGIN - 30) / 2;
  w.rule(page, MARGIN, MARGIN + half, y);
  w.rule(page, right - half, right, y);
  w.text(page, 'Ort, Datum', MARGIN, y - 11, 8.5, { muted: true });
  w.text(page, 'Unterschrift des Gastgebers', right - half, y - 11, 8.5, { muted: true });
  y -= 34;

  // The receipt: images below the facts when they fit, otherwise on their own
  // page; receipt PDFs are appended page by page.
  let imageIndex = 0;
  for (const file of record.files) {
    let loaded: LoadedFile | null = null;
    try {
      loaded = await input.loadFile(file);
    } catch {
      loaded = null;
    }
    if (!loaded) {
      warnings.push(`Nr. ${entry.no}: Beleg "${file.originalName}" konnte nicht geladen werden.`);
      continue;
    }
    const mime = loaded.mimeType || file.mimeType;
    try {
      if (mime.includes('pdf')) {
        const source = await PDFDocument.load(loaded.bytes, { ignoreEncryption: true });
        const copied = await w.doc.copyPages(source, source.getPageIndices());
        copied.forEach((p) => w.doc.addPage(p));
        continue;
      }
      let image: PDFImage;
      if (mime.includes('png')) image = await w.doc.embedPng(loaded.bytes);
      else if (mime.includes('jpeg') || mime.includes('jpg')) image = await w.doc.embedJpg(loaded.bytes);
      else {
        warnings.push(`Nr. ${entry.no}: Beleg "${file.originalName}" hat ein nicht unterstütztes Format (${mime}).`);
        continue;
      }
      const availableOnSheet = y - MARGIN;
      const maxW = A4.w - 2 * MARGIN;
      // On the sheet only when the receipt stays readable there: a long till
      // receipt squeezed under the facts would be a thin unreadable strip, so
      // it gets its own page instead.
      const widthOnSheet = image.width * Math.min(maxW / image.width, availableOnSheet / image.height);
      const onSheet = imageIndex === 0 && availableOnSheet > 220 && widthOnSheet >= maxW * 0.5;
      const target = onSheet ? page : w.doc.addPage([A4.w, A4.h]);
      const maxH = onSheet ? availableOnSheet : A4.h - 2 * MARGIN - 16;
      const scale = Math.min(maxW / image.width, maxH / image.height, 1.5);
      const drawW = image.width * scale;
      const drawH = image.height * scale;
      const top = onSheet ? y : A4.h - MARGIN - 16;
      if (!onSheet) {
        w.text(target, `Beleg zu Bewirtungsbeleg Nr. ${entry.no} / ${input.register.year}`, MARGIN, A4.h - MARGIN, 8.5, { muted: true });
      }
      target.drawImage(image, { x: MARGIN + (maxW - drawW) / 2, y: top - drawH, width: drawW, height: drawH });
      imageIndex += 1;
    } catch {
      warnings.push(`Nr. ${entry.no}: Beleg "${file.originalName}" konnte nicht in das Dokument übernommen werden.`);
    }
  }
  if (record.files.length === 0) {
    warnings.push(`Nr. ${entry.no}: Es ist kein Beleg hinterlegt.`);
    w.text(page, 'Kein Beleg hinterlegt.', MARGIN, y, 9, { muted: true });
  }
}

export async function registerPdf(input: RegisterPdfInput): Promise<RegisterPdfResult> {
  const doc = await PDFDocument.create();
  doc.setTitle(`Bewirtungsverzeichnis ${input.register.year}`);
  doc.setSubject('Bewirtungsaufwendungen nach § 4 Abs. 5 Nr. 2 EStG');
  doc.setCreationDate(input.generatedAt);
  doc.setModificationDate(input.generatedAt);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const w = new Writer(doc, font, bold);
  const warnings: string[] = [];

  drawSummary(w, input);
  for (const entry of input.register.entries) {
    await drawMealSheet(w, input, entry, warnings);
  }

  // Page numbers on every page, including appended receipt pages.
  const pages = doc.getPages();
  pages.forEach((page, i) => {
    const { width } = page.getSize();
    w.text(page, `Seite ${i + 1} von ${pages.length}`, 0, 20, 7.5, { right: width - MARGIN, muted: true });
  });

  if (w.replaced > 0) {
    warnings.push(
      `${w.replaced} Zeichen außerhalb des druckbaren Zeichensatzes wurden vereinfacht dargestellt (zum Beispiel in Namen).`,
    );
  }
  return { bytes: await doc.save(), warnings };
}
