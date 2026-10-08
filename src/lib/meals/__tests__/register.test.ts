import { describe, it, expect } from 'vitest';
import { PDFDocument, degrees } from 'pdf-lib';
import { buildRegister, exportRefusal, incompleteQueue, registerYears } from '../register';
import { CSV_BOM, REGISTER_CSV_HEADERS, csvSafeText, registerCsv } from '../register-csv';
import { SUMMARY_TABLE_WIDTH, registerPdf, rotatedImagePlacement, summaryColumns } from '../register-pdf';
import { GUEST_A, GUEST_B, REGULAR_BUSINESS, SMALL_BUSINESS, UNANSWERED, meal } from './fixtures';

// A 1x1 PNG, the smallest valid receipt "photo".
const PNG_1PX = Uint8Array.from(
  Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64'),
);

const records = [
  meal({ rowId: 'b', date: '2025-06-10', gross: 60, tip: null, guests: [GUEST_B] }),
  meal({ rowId: 'a', date: '2025-03-14', gross: 119, tip: 11 }),
  meal({ rowId: 'c', date: '2025-09-01', guests: [] }), // incomplete
  meal({ rowId: 'd', date: '2025-10-01', mealType: 'travel_meal', gross: 20, guests: [] }),
  meal({ rowId: 'e', date: '2025-10-02', mealType: 'staff_meal_internal', gross: 80 }),
  meal({ rowId: 'f', date: '2025-11-02', zuordnung: 'Privat', gross: 30 }),
  meal({ rowId: 'g', date: '2025-12-02', category: 'Reisekosten' }), // not a meal
  meal({ rowId: 'h', date: '2026-01-15', gross: 50, tip: null }), // other year
  meal({ rowId: 'i', date: null, gross: 12, guests: [] }), // no date
];

describe('buildRegister', () => {
  const register = buildRegister(records, SMALL_BUSINESS, 2025);

  it('lists the complete entries of the year by date, numbered', () => {
    expect(register.entries.map((e) => [e.no, e.record.rowId])).toEqual([
      [1, 'a'],
      [2, 'b'],
    ]);
  });

  it('keeps incomplete entries in their own block, outside the totals', () => {
    expect(register.incomplete.map((e) => e.record.rowId)).toEqual(['c']);
    expect(register.totals).toEqual({
      gross: 179,
      tip: 11,
      net: null,
      inputVat: null,
      base: 190,
      deductible: 133,
      nonDeductible: 57,
    });
  });

  it('counts staff, travel and private meals separately with their sums', () => {
    expect(register.travelMeals).toEqual({ count: 1, grossEur: 20 });
    expect(register.staffMeals).toEqual({ count: 1, grossEur: 80 });
    expect(register.privateMeals).toEqual({ count: 1, grossEur: 30 });
  });

  it('leaves out other years, non-meals and receipts without a date', () => {
    const ids = [...register.entries, ...register.incomplete].map((e) => e.record.rowId);
    expect(ids).not.toContain('g');
    expect(ids).not.toContain('h');
    expect(ids).not.toContain('i');
  });

  it('the totals are the sum of the entries, to the cent', () => {
    const many = Array.from({ length: 40 }, (_, i) =>
      meal({ rowId: `r${String(i).padStart(2, '0')}`, date: '2025-05-05', gross: 33.33 + i * 0.07, tip: i % 3 ? 1.11 : null }),
    );
    const r = buildRegister(many, SMALL_BUSINESS, 2025);
    const cents = (n: number) => Math.round(n * 100);
    const sum = (pick: (d: NonNullable<(typeof r.entries)[number]['deduction']>) => number) =>
      r.entries.reduce((s, e) => s + cents(pick(e.deduction!)), 0);
    expect(cents(r.totals!.deductible)).toBe(sum((d) => d.deductible));
    expect(cents(r.totals!.nonDeductible)).toBe(sum((d) => d.nonDeductible));
    expect(cents(r.totals!.deductible) + cents(r.totals!.nonDeductible)).toBe(cents(r.totals!.base));
  });

  it('on the net basis the totals carry net and input tax and count estimated entries', () => {
    const r = buildRegister(records, REGULAR_BUSINESS, 2025);
    expect(r.basis).toBe('net');
    expect(r.totals).toMatchObject({ net: 150.42, inputVat: 28.58 });
    expect(r.vatEstimatedCount).toBe(2);
  });

  it('with the section 19 question unanswered it lists the entries but shows no amounts or totals', () => {
    const r = buildRegister(records, UNANSWERED, 2025);
    expect(r.settingMissing).toBe(true);
    expect(r.totals).toBeNull();
    expect(r.entries).toHaveLength(2);
    expect(r.entries.every((e) => e.deduction === null)).toBe(true);
  });

  it('an edit is reflected by the next build (re-entry: nothing is cached)', () => {
    const edited = records.map((r) => (r.rowId === 'a' ? { ...r, gross: 219 } : r));
    expect(buildRegister(edited, SMALL_BUSINESS, 2025).totals!.gross).toBe(279);
  });
});

describe('queue and years', () => {
  it('the queue holds every incomplete meal of any year, oldest first, including undated receipts', () => {
    expect(incompleteQueue(records).map((e) => e.record.rowId)).toEqual(['i', 'c']);
  });
  it('lists the years that have meal records, newest first', () => {
    expect(registerYears(records)).toEqual([2026, 2025]);
  });
});

describe('exportRefusal', () => {
  const register = buildRegister(records, SMALL_BUSINESS, 2025);
  it('refuses while the section 19 question is unanswered', () => {
    expect(exportRefusal(buildRegister(records, UNANSWERED, 2025), 1)).toEqual({ code: 'setting_missing' });
  });
  it('refuses with open incomplete entries until exactly that count is acknowledged', () => {
    expect(exportRefusal(register, null)).toEqual({ code: 'incomplete_unacknowledged', incompleteCount: 1 });
    expect(exportRefusal(register, 0)).toEqual({ code: 'incomplete_unacknowledged', incompleteCount: 1 });
    expect(exportRefusal(register, 2)).toEqual({ code: 'incomplete_unacknowledged', incompleteCount: 1 });
    expect(exportRefusal(register, 1)).toBeNull();
  });
  it('needs no acknowledgement when nothing is incomplete', () => {
    expect(exportRefusal(buildRegister(records, SMALL_BUSINESS, 2026), null)).toBeNull();
  });
});

describe('registerCsv', () => {
  const csv = registerCsv(buildRegister(records, SMALL_BUSINESS, 2025));
  const lines = csv.split('\r\n');
  const cells = (line: string) => line.split(';');

  it('has the header, one line per entry, a totals line and the incomplete block', () => {
    expect(lines[0]).toBe(REGISTER_CSV_HEADERS.join(';'));
    expect(lines).toHaveLength(1 + 2 + 1 + 1);
    expect(cells(lines[1]).length).toBe(REGISTER_CSV_HEADERS.length);
    expect(cells(lines[3])[1]).toBe('Summe');
    expect(cells(lines[4])[1]).toBe('unvollständig');
  });

  it('uses German dates and numbers and carries the legally required facts', () => {
    const first = cells(lines[1]);
    expect(first[0]).toBe('1');
    expect(first[2]).toBe('14.03.2025');
    expect(first[4]).toBe('Erika Beispiel (Beispiel GmbH)');
    expect(first[5]).toBe('1');
    expect(first[6]).toBe('"Abstimmung Relaunch Webshop, Angebot Phase 2"'.replace(/^"|"$/g, ''));
    expect(first[8]).toBe('119,00');
    expect(first[9]).toBe('11,00');
    expect(first[13]).toBe('91,00');
    expect(first[14]).toBe('39,00');
    expect(first[19]).toBe('business_meal_external');
  });

  it('claims no amounts for incomplete entries and names what is missing', () => {
    const incomplete = cells(lines[4]);
    expect(incomplete.slice(8, 15).every((c) => c === '')).toBe(true);
    expect(incomplete[16]).toBe('Teilnehmer');
  });

  it('carries the true entry timestamp', () => {
    expect(cells(lines[1])[17]).toBe('15.03.2025 09:00 UTC');
  });

  it('neutralizes spreadsheet formulas in free text', () => {
    expect(csvSafeText('=SUM(A1:A9)')).toBe("'=SUM(A1:A9)");
    expect(csvSafeText('+49 30 123')).toBe("'+49 30 123");
    expect(csvSafeText('Planung')).toBe('Planung');
    const evil = registerCsv(
      buildRegister([meal({ occasion: '=HYPERLINK("http://example.invalid") Angebot' })], SMALL_BUSINESS, 2025),
    );
    expect(evil).toContain(`"'=HYPERLINK(""http://example.invalid"") Angebot"`);
  });

  it('exposes a byte order mark for spreadsheet programs', () => {
    expect(CSV_BOM).toBe('﻿');
  });
});

describe('registerPdf', () => {
  const generatedAt = new Date('2026-10-06T12:00:00.000Z');

  it.each(['gross', 'net'] as const)('the %s-basis summary table fits the printable width exactly', (basis) => {
    const width = summaryColumns({ basis }).reduce((sum, c) => sum + c.width, 0);
    expect(width).toBeCloseTo(SUMMARY_TABLE_WIDTH, 5);
    expect(summaryColumns({ basis }).every((c) => c.width >= 24)).toBe(true);
  });

  it('renders a summary page plus one sheet per meal, with the receipt image on the sheet', async () => {
    const withFiles = records.map((r) =>
      r.rowId === 'a'
        ? { ...r, files: [{ refId: 'ref-1', rotation: null, fileId: 'f1', fileUrl: '/api/files/f1', mimeType: 'image/png', originalName: 'beleg.png' }] }
        : r,
    );
    const { bytes, warnings } = await registerPdf({
      register: buildRegister(withFiles, SMALL_BUSINESS, 2025),
      workspaceLabel: 'Beispiel Studio',
      generatedAt,
      loadFile: async () => ({ bytes: PNG_1PX, mimeType: 'image/png' }),
    });
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBe(3); // summary + 2 sheets
    expect(doc.getTitle()).toBe('Bewirtungsverzeichnis 2025');
    // Entry "b" has no receipt attached: that is said, not hidden.
    expect(warnings).toEqual(['Nr. 2: Es ist kein Beleg hinterlegt.']);
  });

  it('appends the pages of a PDF receipt', async () => {
    const receipt = await PDFDocument.create();
    receipt.addPage();
    receipt.addPage();
    const receiptBytes = await receipt.save();
    const one = [meal({ files: [{ refId: 'ref-1', rotation: null, fileId: 'f1', fileUrl: '/api/files/f1', mimeType: 'application/pdf', originalName: 'scan.pdf' }] })];
    const { bytes, warnings } = await registerPdf({
      register: buildRegister(one, SMALL_BUSINESS, 2025),
      workspaceLabel: 'Beispiel Studio',
      generatedAt,
      loadFile: async () => ({ bytes: receiptBytes, mimeType: 'application/pdf' }),
    });
    expect((await PDFDocument.load(bytes)).getPageCount()).toBe(1 + 1 + 2);
    expect(warnings).toEqual([]);
  });

  it('a PDF receipt is printed the way it was turned in the viewer, on top of its own page rotation', async () => {
    const receipt = await PDFDocument.create();
    receipt.addPage([600, 200]);
    receipt.addPage([600, 200]).setRotation(degrees(90));
    const receiptBytes = await receipt.save();
    const file = { refId: 'ref-1', rotation: 90 as const, fileId: 'f1', fileUrl: '/api/files/f1', mimeType: 'application/pdf', originalName: 'quer.pdf' };
    const print = async (rotation: 0 | 90 | null) =>
      PDFDocument.load(
        (
          await registerPdf({
            register: buildRegister([meal({ files: [{ ...file, rotation }] })], SMALL_BUSINESS, 2025),
            workspaceLabel: 'Beispiel Studio',
            generatedAt,
            loadFile: async () => ({ bytes: receiptBytes, mimeType: 'application/pdf' }),
          })
        ).bytes,
      );
    const turned = (await print(90)).getPages().slice(-2).map((p) => p.getRotation().angle);
    expect(turned).toEqual([90, 180]);
    // No rotation chosen: the pages are appended exactly as they are.
    const plain = (await print(null)).getPages().slice(-2).map((p) => p.getRotation().angle);
    expect(plain).toEqual([0, 90]);
    expect((await print(0)).getPages().slice(-2).map((p) => p.getRotation().angle)).toEqual([0, 90]);
  });

  it('a picture turned by a quarter is placed so that it covers exactly the box it would cover upright', () => {
    const box = { x: 100, y: 200, width: 60, height: 180 };
    // Corners of the drawn picture: the format turns it counter-clockwise by `rotate` around (x, y).
    const corners = (p: ReturnType<typeof rotatedImagePlacement>) => {
      const a = (p.rotate.angle * Math.PI) / 180;
      const pt = (dx: number, dy: number) => [p.x + dx * Math.cos(a) - dy * Math.sin(a), p.y + dx * Math.sin(a) + dy * Math.cos(a)];
      const pts = [pt(0, 0), pt(p.width, 0), pt(0, p.height), pt(p.width, p.height)];
      const xs = pts.map((c) => c[0]);
      const ys = pts.map((c) => c[1]);
      return { x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) };
    };
    for (const rotation of [0, 90, 180, 270] as const) {
      const covered = corners(rotatedImagePlacement(box, rotation));
      expect(covered.x).toBeCloseTo(box.x);
      expect(covered.y).toBeCloseTo(box.y);
      expect(covered.width).toBeCloseTo(box.width);
      expect(covered.height).toBeCloseTo(box.height);
    }
    // Clockwise for the viewer is the negative angle in the format; the picture's own sides swap on a quarter turn.
    expect(rotatedImagePlacement(box, 90)).toMatchObject({ width: 180, height: 60 });
    expect(rotatedImagePlacement(box, 90).rotate.angle).toBe(-90);
  });

  it('a sideways receipt photo turned upright still gets a readable size on its sheet', async () => {
    const file = { refId: 'ref-1', rotation: 90 as const, fileId: 'f1', fileUrl: '/api/files/f1', mimeType: 'image/png', originalName: 'quer.png' };
    const { bytes, warnings } = await registerPdf({
      register: buildRegister([meal({ files: [file] })], SMALL_BUSINESS, 2025),
      workspaceLabel: 'Beispiel Studio',
      generatedAt,
      loadFile: async () => ({ bytes: PNG_1PX, mimeType: 'image/png' }),
    });
    expect(warnings).toEqual([]);
    expect((await PDFDocument.load(bytes)).getPageCount()).toBeGreaterThanOrEqual(2);
  });

  it('a receipt that cannot be loaded or is corrupt becomes a warning, never a crash', async () => {
    const file = { refId: 'ref-1', rotation: null, fileId: 'f1', fileUrl: '/api/files/f1', mimeType: 'image/jpeg', originalName: 'kaputt.jpg' };
    const one = [meal({ files: [file] })];
    const missing = await registerPdf({
      register: buildRegister(one, SMALL_BUSINESS, 2025),
      workspaceLabel: 'Beispiel Studio',
      generatedAt,
      loadFile: async () => null,
    });
    expect(missing.warnings).toEqual(['Nr. 1: Beleg "kaputt.jpg" konnte nicht geladen werden.']);
    const corrupt = await registerPdf({
      register: buildRegister(one, SMALL_BUSINESS, 2025),
      workspaceLabel: 'Beispiel Studio',
      generatedAt,
      loadFile: async () => ({ bytes: new Uint8Array([1, 2, 3]), mimeType: 'image/jpeg' }),
    });
    expect(corrupt.warnings).toEqual(['Nr. 1: Beleg "kaputt.jpg" konnte nicht in das Dokument übernommen werden.']);
    const throwing = await registerPdf({
      register: buildRegister(one, SMALL_BUSINESS, 2025),
      workspaceLabel: 'Beispiel Studio',
      generatedAt,
      loadFile: async () => {
        throw new Error('storage down');
      },
    });
    expect(throwing.warnings).toHaveLength(1);
  });

  it('survives characters outside the built-in font and says how many were simplified', async () => {
    const one = [
      meal({
        guests: [{ contactId: 'c', name: 'Łukasz Żółć 🍝', company: 'Przykład Sp. z o.o.' }],
        occasion: 'Abstimmung Übersetzung „Größe“ → Maße',
      }),
    ];
    const { bytes, warnings } = await registerPdf({
      register: buildRegister(one, SMALL_BUSINESS, 2025),
      workspaceLabel: 'Beispiel Studio',
      generatedAt,
      loadFile: async () => null,
    });
    expect((await PDFDocument.load(bytes)).getPageCount()).toBe(2);
    expect(warnings.some((w) => w.includes('vereinfacht dargestellt'))).toBe(true);
  });

  it('breaks a long year onto several summary pages and wraps long text', async () => {
    const many = Array.from({ length: 70 }, (_, i) =>
      meal({
        rowId: `r${String(i).padStart(2, '0')}`,
        date: '2025-05-05',
        occasion: 'Sehr ausführlicher Anlass '.repeat(6),
        guests: [GUEST_A, GUEST_B],
      }),
    );
    const { bytes } = await registerPdf({
      register: buildRegister(many, REGULAR_BUSINESS, 2025),
      workspaceLabel: 'Beispiel Studio',
      generatedAt,
      loadFile: async () => null,
    });
    const pages = (await PDFDocument.load(bytes)).getPageCount();
    expect(pages).toBeGreaterThan(70 + 3);
  });

  it('renders an empty year without failing', async () => {
    const { bytes } = await registerPdf({
      register: buildRegister([], SMALL_BUSINESS, 2024),
      workspaceLabel: 'Beispiel Studio',
      generatedAt,
      loadFile: async () => null,
    });
    expect((await PDFDocument.load(bytes)).getPageCount()).toBe(1);
  });
});
