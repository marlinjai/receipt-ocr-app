import { afterAll, describe, expect, it } from 'vitest';
import { saveTaxSettings } from '@/lib/meals/service';
import type { TaxContext } from '../../service';
import { PaymentServiceError, createAccount, deleteImportBatch, importPayments } from '../service';
import { pdfText } from '../pdf-text';
import { PaymentParseError } from '../types';
import { newBalanceOf, statementPdf, type Statement } from './advanzia-fixture';
import { createWorkspace, db } from '../../../../../test/db-helpers';

/**
 * Statements of the Advanzia credit card against a real database, read from
 * generated PDFs the way the upload reads them. Run with `pnpm test:db`. Every
 * merchant, place and amount is invented.
 */

async function card(): Promise<{ ctx: TaxContext; accountId: string }> {
  const ws = await createWorkspace();
  const ctx = { workspaceId: ws.workspaceId, tenantId: ws.tenantId };
  await saveTaxSettings(db, ctx, { smallBusiness: true });
  const accountId = await createAccount(db, ctx, { label: 'Kreditkarte', kind: 'card' });
  return { ctx, accountId };
}

const MARCH: Statement = {
  from: '04.03.2026',
  to: '03.04.2026',
  oldBalance: '1.423,22',
  rows: [
    { day: '05.03.2026', text: 'Lieferdienst Beispiel', place: 'Berlin', amount: '19,11' },
    { day: '23.03.2026', text: 'SOFTWARE* BEISPIEL - USD 26,92 (KURS 1,1509)', place: 'SOUTH SAN FRA', amount: '23,39' },
    { day: '26.03.2026', text: 'EINZAHLUNG', amount: '-2.000,00' },
    { day: '27.03.2026', text: 'ZAHLDIENST *LADENBEISPIEL', place: '0304241090', amount: '-30,40' },
    { day: '31.03.2026', text: 'ZAHLUNG AUFS GIROKONTO', amount: '250,00' },
    { day: '31.03.2026', text: 'FAHRKARTE BEISPIEL', place: 'Berlin', amount: '63,00' },
    { day: '31.03.2026', text: 'FAHRKARTE BEISPIEL', place: 'Berlin', amount: '63,00' },
    { day: '03.04.2026', text: 'SOLLZINSEN', amount: '5,61' },
  ],
};

/** The next month's statement: it starts where March ended. */
const APRIL: Statement = {
  from: '04.04.2026',
  to: '03.05.2026',
  oldBalance: newBalanceOf(MARCH),
  rows: [
    { day: '06.04.2026', text: 'Laden Beispiel', place: 'Hamburg', amount: '42,00' },
    // The same ticket as twice in March, on another day: another movement.
    { day: '07.04.2026', text: 'FAHRKARTE BEISPIEL', place: 'Berlin', amount: '63,00' },
    { day: '28.04.2026', text: 'EINZAHLUNG', amount: '-500,00' },
  ],
};

const text = async (s: Statement) => pdfText(await statementPdf(s, 6));
const importStatement = async (ctx: TaxContext, accountId: string, s: Statement) => importPayments(db, ctx, accountId, await text(s), { parse: { pdf: true } });

const stored = (accountId: string) =>
  db.taxPayment.findMany({
    where: { accountId },
    orderBy: [{ bookingDay: 'asc' }, { amountCents: 'asc' }],
    select: { bookingDay: true, amountCents: true, counterparty: true, reference: true, sourceKind: true, originalAmountCents: true, originalCurrency: true },
  });

const codeOf = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    if (e instanceof PaymentServiceError || e instanceof PaymentParseError) return e.code;
    throw e;
  }
  return 'no error';
};

const cents = (german: string) => Math.round(Number(german.replace(/\./g, '').replace(',', '.')) * 100);

afterAll(async () => {
  await db.$disconnect();
});

describe('Advanzia statements: forward', () => {
  it('stores every movement of a statement over two pages with its kind, its sign and its other currency', async () => {
    const { ctx, accountId } = await card();
    const result = await importStatement(ctx, accountId, MARCH);
    expect(result).toMatchObject({ format: 'advanzia_pdf', total: 8, added: 8, alreadyThere: 0, skipped: { statement_balance: 2, minimum_payment: 1 }, firstDay: '2026-03-05', lastDay: '2026-04-03' });
    expect((await stored(accountId)).map((p) => [p.bookingDay, p.amountCents, p.counterparty, p.sourceKind, p.originalAmountCents, p.originalCurrency])).toEqual([
      ['2026-03-05', -1911, 'Lieferdienst Beispiel', 'spend', null, null],
      ['2026-03-23', -2339, 'SOFTWARE* BEISPIEL', 'spend', -2692, 'USD'],
      ['2026-03-26', 200_000, 'EINZAHLUNG', 'own_transfer', null, null],
      ['2026-03-27', 3040, 'ZAHLDIENST *LADENBEISPIEL', 'refund', null, null],
      ['2026-03-31', -25_000, 'ZAHLUNG AUFS GIROKONTO', 'own_transfer', null, null],
      // Two identical tickets on one day: both kept.
      ['2026-03-31', -6300, 'FAHRKARTE BEISPIEL', 'spend', null, null],
      ['2026-03-31', -6300, 'FAHRKARTE BEISPIEL', 'spend', null, null],
      ['2026-04-03', -561, 'SOLLZINSEN', 'fee', null, null],
    ]);
  });
});

describe('Advanzia statements: backtrack and revise', () => {
  it('a corrected statement of the same period adds only the movement it adds, nothing twice', async () => {
    const { ctx, accountId } = await card();
    await importStatement(ctx, accountId, MARCH);
    const corrected: Statement = { ...MARCH, rows: [...MARCH.rows, { day: '02.04.2026', text: 'Nachbuchung Beispiel', place: 'Berlin', amount: '12,00' }] };
    const result = await importStatement(ctx, accountId, corrected);
    expect(result).toMatchObject({ total: 9, added: 1, alreadyThere: 8 });
    const rows = await stored(accountId);
    expect(rows).toHaveLength(9);
    expect(rows.filter((p) => p.counterparty === 'FAHRKARTE BEISPIEL')).toHaveLength(2);
  });

  it('an overlapping statement brings only the days it adds', async () => {
    const { ctx, accountId } = await card();
    await importStatement(ctx, accountId, MARCH);
    const overlap: Statement = { from: '20.03.2026', to: '10.04.2026', oldBalance: '0,00', rows: [...MARCH.rows.slice(1), APRIL.rows[0]] };
    expect(await importStatement(ctx, accountId, overlap)).toMatchObject({ total: 8, added: 1, alreadyThere: 7 });
    expect(await stored(accountId)).toHaveLength(9);
  });
});

describe('Advanzia statements: resume', () => {
  it('the next month continues the account: the stored movements lead from the first old balance to the last new one', async () => {
    const { ctx, accountId } = await card();
    await importStatement(ctx, accountId, MARCH);
    const result = await importStatement(ctx, accountId, APRIL);
    expect(result).toMatchObject({ total: 3, added: 3, alreadyThere: 0, firstDay: '2026-04-06', lastDay: '2026-04-28' });
    const rows = await stored(accountId);
    expect(rows).toHaveLength(11);
    // The card's balance is what is owed: money out on the account raises it.
    const owed = cents(MARCH.oldBalance) - rows.reduce((sum, p) => sum + p.amountCents, 0);
    expect(owed).toBe(cents(newBalanceOf(APRIL)));
    expect(rows.filter((p) => p.counterparty === 'FAHRKARTE BEISPIEL')).toHaveLength(3);
  });
});

describe('Advanzia statements: re-entry', () => {
  it('the same statement again is refused and stores nothing; after undoing its import it reads again', async () => {
    const { ctx, accountId } = await card();
    const first = await importStatement(ctx, accountId, MARCH);
    expect(await codeOf(importStatement(ctx, accountId, MARCH))).toBe('file_already_imported');
    expect(await stored(accountId)).toHaveLength(8);
    await deleteImportBatch(db, ctx, first.batchId);
    expect(await stored(accountId)).toHaveLength(0);
    expect(await importStatement(ctx, accountId, MARCH)).toMatchObject({ added: 8 });
  });

  it('a refused upload leaves nothing behind, and the right statement reads after it', async () => {
    const { ctx, accountId } = await card();
    // A statement whose rows do not add up, a PDF that is no statement, and bytes that are no PDF.
    expect(await codeOf(importStatement(ctx, accountId, { ...MARCH, newBalance: '1,00' }))).toBe('unbalanced_statement');
    expect(await codeOf(importPayments(db, ctx, accountId, 'Rechnung Nr. 4711\nBetrag  19,99', { parse: { pdf: true } }))).toBe('unknown_pdf');
    expect(await codeOf(pdfText(new TextEncoder().encode('kein PDF')))).toBe('unreadable_pdf');
    expect(await db.taxImportBatch.count({ where: { accountId } })).toBe(0);
    expect(await importStatement(ctx, accountId, MARCH)).toMatchObject({ added: 8 });
  });
});
