import { describe, expect, it } from 'vitest';
import { parsePaymentFile } from '../parse';
import { pdfText } from '../pdf-text';
import { PaymentParseError } from '../types';
import { statementPdf, statementText, type Statement } from './advanzia-fixture';

/** Statements of the Advanzia credit card. Every merchant, place and amount is invented; only the layout is the real one. */

const MARCH: Statement = {
  from: '04.03.2026',
  to: '03.04.2026',
  oldBalance: '1.423,22',
  rows: [
    { day: '05.03.2026', text: 'Lieferdienst Beispiel', place: 'Berlin', amount: '19,11' },
    { day: '11.03.2026', text: 'FLUG BEISPIEL 224QU81RS', place: 'SWORDS', amount: '45,37' },
    { day: '23.03.2026', text: 'SOFTWARE* BEISPIEL - USD 26,92 (KURS 1,1509)', place: 'SOUTH SAN FRA', amount: '23,39' },
    // A charge from months before, posted late: its own day stands, not the statement's.
    { day: '30.11.2025', text: 'ABO.NET* BEISPIEL - USD 23,80 (KURS 1,1553)', place: 'Lisboa', amount: '20,60' },
    { day: '26.03.2026', text: 'EINZAHLUNG', amount: '-2.000,00' },
    { day: '27.03.2026', text: 'ZAHLDIENST *LADENBEISPIEL', place: '0304241090', amount: '-30,40' },
    { day: '31.03.2026', text: 'ZAHLUNG AUFS GIROKONTO', amount: '250,00' },
    { day: '09.01.2026', text: 'Startguthaben', amount: '-75,00' },
    { day: '03.04.2026', text: 'SOLLZINSEN', amount: '5,61' },
  ],
};

const read = (s: Statement, indent = false) => parsePaymentFile(statementText(s, indent));

const code = (text: string, pdf = false) => {
  try {
    parsePaymentFile(text, { pdf });
  } catch (e) {
    return e instanceof PaymentParseError ? [e.code, e.row] : ['unexpected', String(e)];
  }
  return ['no error', null];
};

describe('the Advanzia card statement: rows', () => {
  it('reads every movement with the sign of every account (negative is money out) and what it is', () => {
    const file = read(MARCH);
    expect(file.format).toBe('advanzia_pdf');
    expect(file.payments.map((p) => [p.bookingDay, p.amountCents, p.counterparty, p.reference, p.kind])).toEqual([
      ['2026-03-05', -1911, 'Lieferdienst Beispiel', 'Berlin', 'spend'],
      ['2026-03-11', -4537, 'FLUG BEISPIEL 224QU81RS', 'SWORDS', 'spend'],
      ['2026-03-23', -2339, 'SOFTWARE* BEISPIEL', 'SOUTH SAN FRA', 'spend'],
      ['2025-11-30', -2060, 'ABO.NET* BEISPIEL', 'Lisboa', 'spend'],
      // Paying the card off from the own current account: money onto the card, between own accounts.
      ['2026-03-26', 200_000, 'EINZAHLUNG', '', 'own_transfer'],
      // A merchant's money back.
      ['2026-03-27', 3040, 'ZAHLDIENST *LADENBEISPIEL', '0304241090', 'refund'],
      // Cash from the card to the own current account.
      ['2026-03-31', -25_000, 'ZAHLUNG AUFS GIROKONTO', '', 'own_transfer'],
      // The bank's credit for opening the card: money in that undoes no purchase.
      ['2026-01-09', 7500, 'Startguthaben', '', 'income'],
      ['2026-04-03', -561, 'SOLLZINSEN', '', 'fee'],
    ]);
    expect(file.payments.every((p) => p.valueDay === null && p.entryReference === null)).toBe(true);
  });

  it('keeps the other currency of a purchase next to the euro amount it was charged, without it in the name', () => {
    const file = read(MARCH);
    expect(file.payments.filter((p) => p.original).map((p) => [p.counterparty, p.amountCents, p.original, p.estimated])).toEqual([
      ['SOFTWARE* BEISPIEL', -2339, { currency: 'USD', amountCents: -2692 }, undefined],
      ['ABO.NET* BEISPIEL', -2060, { currency: 'USD', amountCents: -2380 }, undefined],
    ]);
    expect(file.payments.filter((p) => !p.original)).toHaveLength(7);
  });

  it('counts the balances and the minimum payment as left out, and nothing of the summary below the table', () => {
    const file = read(MARCH);
    expect(file.skipped).toEqual({ statement_balance: 2, minimum_payment: 1 });
    expect(file.firstDay).toBe('2025-11-30');
    expect(file.lastDay).toBe('2026-04-03');
  });

  it('reads rows with and without a space before them alike', () => {
    expect(read(MARCH, true).payments).toEqual(read(MARCH).payments);
  });

  it('keeps two identical charges of one day as two movements, stably', () => {
    const twice: Statement = {
      ...MARCH,
      rows: [
        { day: '03.06.2026', text: 'FAHRKARTE BEISPIEL', place: 'Berlin', amount: '63,00' },
        { day: '03.06.2026', text: 'FAHRKARTE BEISPIEL', place: 'Berlin', amount: '63,00' },
      ],
    };
    const a = read(twice).payments;
    expect(a).toHaveLength(2);
    expect(a[0].sourceHash).not.toBe(a[1].sourceHash);
    expect(read(twice).payments.map((p) => p.sourceHash)).toEqual(a.map((p) => p.sourceHash));
  });

  it('gives a movement the same identity on a corrected or overlapping statement', () => {
    const first = read(MARCH);
    const corrected = read({ ...MARCH, oldBalance: '1.400,00', rows: [...MARCH.rows.slice(2), { day: '02.04.2026', text: 'Laden Beispiel', place: 'Hamburg', amount: '9,99' }] });
    const hashes = new Set(first.payments.map((p) => p.sourceHash));
    expect(corrected.payments.filter((p) => hashes.has(p.sourceHash))).toHaveLength(MARCH.rows.length - 2);
  });

  it('reads a statement that holds no movement: only its balances', () => {
    const quiet = read({ ...MARCH, rows: [] });
    expect(quiet.payments).toEqual([]);
    expect(quiet.skipped).toEqual({ statement_balance: 2, minimum_payment: 1 });
  });
});

describe('the Advanzia card statement: unhappy paths', () => {
  it('refuses a statement whose rows do not lead from the old balance to the new one', () => {
    expect(code(statementText({ ...MARCH, newBalance: '122,60' }))).toEqual(['unbalanced_statement', null]);
    // A row the reader cannot see (its amount misprinted) makes the sum fall short: the statement is refused whole.
    const text = statementText(MARCH).replace(/^(.*Lieferdienst Beispiel.*)19,11$/m, '$119.11');
    expect(code(text)).toEqual(['unbalanced_statement', null]);
  });

  it('refuses a statement without its balances, and one with a balance twice', () => {
    const text = statementText(MARCH);
    expect(code(text.split('\n').filter((l) => !l.includes('ALTER SALDO')).join('\n'))).toEqual(['unbalanced_statement', null]);
    expect(code(text.split('\n').filter((l) => !l.includes('NEUER SALDO')).join('\n'))).toEqual(['unbalanced_statement', null]);
    const twice = text.replace(/^(.*NEUER SALDO.*)$/m, '$1\n$1');
    expect(code(twice)).toEqual(['unbalanced_statement', null]);
  });

  it('names a dated row whose day does not exist', () => {
    const text = statementText(MARCH).replace('05.03.2026', '35.03.2026');
    expect(code(text)).toEqual(['unreadable_row', 5]);
  });

  it('never reads the text of another PDF as a table, and says so', () => {
    expect(code('Rechnung Nr. 4711\nBetrag 19,99', true)).toEqual(['unknown_pdf', null]);
    expect(code('Booking Date,Partner Name,Amount (EUR),Payment Reference\n2026-01-05,Laden,-1,x\n', true)).toEqual(['unknown_pdf', null]);
    expect(code('   \n ', true)).toEqual(['pdf_without_text', null]);
    // Without the card's three markers together it is no statement of the card.
    expect(code(statementText(MARCH).replace('Kreditkartennummer', 'Kartennummer'), true)).toEqual(['unknown_pdf', null]);
  });
});

describe('the text of a statement PDF', () => {
  it('reads a statement over several pages, every row, with its columns apart', async () => {
    const many: Statement = {
      ...MARCH,
      rows: Array.from({ length: 70 }, (_, i) => ({ day: `${String((i % 28) + 1).padStart(2, '0')}.03.2026`, text: `Laden Beispiel ${i + 1}`, place: 'Köln', amount: `${i + 1},50` })),
    };
    const bytes = await statementPdf(many, 30);
    const text = await pdfText(bytes);
    expect(text).toMatch(/Laden Beispiel 1 {2,}Köln {2,}1,50/);
    const file = parsePaymentFile(text, { pdf: true });
    expect(file.format).toBe('advanzia_pdf');
    expect(file.payments).toHaveLength(70);
    expect(file.payments[69]).toMatchObject({ counterparty: 'Laden Beispiel 70', reference: 'Köln', amountCents: -7050, kind: 'spend' });
  });

  it('reads the PDF to the same movements as the printed text', async () => {
    const fromPdf = parsePaymentFile(await pdfText(await statementPdf(MARCH)), { pdf: true });
    expect(fromPdf.payments).toEqual(read(MARCH).payments);
  });

  it('refuses what is no PDF, a damaged one, and one without text', async () => {
    const codeOf = async (bytes: Uint8Array) => {
      try {
        await pdfText(bytes);
      } catch (e) {
        return e instanceof PaymentParseError ? e.code : String(e);
      }
      return 'no error';
    };
    expect(await codeOf(new TextEncoder().encode('Booking Date,Amount\n'))).toBe('unreadable_pdf');
    const whole = await statementPdf(MARCH);
    expect(await codeOf(whole.slice(0, 200))).toBe('unreadable_pdf');
    const { PDFDocument } = await import('pdf-lib');
    const blank = await PDFDocument.create();
    blank.addPage();
    expect(await codeOf(await blank.save())).toBe('pdf_without_text');
    expect(await codeOf(new Uint8Array(8 * 1024 * 1024 + 1))).toBe('too_large');
  });
});
