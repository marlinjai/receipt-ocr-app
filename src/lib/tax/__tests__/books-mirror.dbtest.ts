import { afterAll, describe, expect, it } from 'vitest';
import { saveTaxSettings } from '@/lib/meals/service';
import type { BooksDocument } from '../books-mirror';
import { applyBooksDocuments } from '../books-mirror-service';
import { deleteInvoice, loadStatement, receiptForLink, saveInvoice, type TaxContext } from '../service';
import { createAccount, importPayments, linkPayment } from '../payments/service';
import { createWorkspace, db, type TestWorkspace } from '../../../../test/db-helpers';

/**
 * The mirror of the Books documents against a real database (migration
 * 0047): a pull lands whole, again changes nothing, attaches the register
 * rows of the same number, cancels on a credit note and moves the payments of
 * a corrected invoice to its replacement. Run with `pnpm test:db`.
 */

afterAll(async () => {
  await db.$disconnect();
});

async function workspace(): Promise<{ ws: TestWorkspace; ctx: TaxContext }> {
  const ws = await createWorkspace();
  const ctx = { workspaceId: ws.workspaceId, tenantId: ws.tenantId };
  await saveTaxSettings(db, ctx, { smallBusiness: true });
  return { ws, ctx };
}

const doc = (o: Partial<BooksDocument> = {}): BooksDocument => ({
  id: 'doc-62',
  docType: 'invoice',
  status: 'issued',
  number: '62',
  issueDate: '2026-09-01',
  dueDate: '2026-09-15',
  currencyCode: 'EUR',
  kleinunternehmer: true,
  reverseCharge: false,
  totalCents: 75_000,
  taxCents: 0,
  taxSummary: [{ rateBp: 0, netCents: 75_000, taxCents: 0 }],
  correctsDocumentId: null,
  replacesDocumentId: null,
  ...o,
});

const register = (o: Record<string, unknown> = {}) => ({
  number: '61',
  issueDate: '2026-08-01',
  grossCents: 50_000,
  vatCents: 0,
  treatment: 'small_business',
  declaredInYear: null,
  payments: [],
  ...o,
});

const HEADER = '"Booking Date","Value Date","Partner Name","Partner Iban",Type,"Payment Reference","Account Name","Amount (EUR)","Original Amount","Original Currency","Exchange Rate"';

async function linkBankPayment(ctx: TaxContext, ws: TestWorkspace, invoiceId: string, day: string, euros: number, reference: string) {
  const accountId = await createAccount(db, ctx, { label: 'Geschäftskonto', kind: 'bank' });
  await importPayments(db, ctx, accountId, [HEADER, `${day},${day},"Kunde Beispiel",,Credit Transfer,"${reference}",Hauptkonto,${euros},,,`].join('\n') + '\n');
  const view = await loadStatement(db, ws.workspaceId, 2026);
  const payment = view.payments.open.find((p) => p.amountCents === euros * 100);
  if (!payment) throw new Error('the imported payment is not open');
  await linkPayment(db, ctx, { paymentId: payment.id, invoiceId }, receiptForLink(db, ws.workspaceId));
}

describe('the Books mirror: forward and re-entry', () => {
  it('creates the issued invoice with its due day, and the same pull again changes nothing', async () => {
    const { ws, ctx } = await workspace();
    const first = await applyBooksDocuments(db, ctx, [doc()]);
    expect(first).toMatchObject({ created: 1, attached: 0, updated: 0, unchanged: 0, conflicts: [], skipped: [] });
    const again = await applyBooksDocuments(db, ctx, [doc()]);
    expect(again).toMatchObject({ created: 0, updated: 0, unchanged: 1 });

    const view = await loadStatement(db, ws.workspaceId, 2026);
    expect(view.revenue.invoices).toHaveLength(1);
    expect(view.revenue.invoices[0]).toMatchObject({ number: '62', source: 'books', dueDate: '2026-09-15', cancelledOn: null, outstandingCents: 75_000 });
    // Due 2026-09-15 as the document states: overdue today.
    expect(view.revenue.overdue.map((o) => o.dueDate)).toEqual(['2026-09-15']);
  });

  it('two pulls at the same moment write the invoice once', async () => {
    const { ctx } = await workspace();
    const [a, b] = await Promise.all([applyBooksDocuments(db, ctx, [doc()]), applyBooksDocuments(db, ctx, [doc()])]);
    expect(a.created + b.created).toBe(1);
    expect(await db.taxIssuedInvoice.count({ where: { authWorkspaceId: ctx.workspaceId } })).toBe(1);
  });

  it('writes nothing of a pull that fails part way', async () => {
    const { ctx } = await workspace();
    // A body that is not a list of documents is refused before anything is written.
    await expect(applyBooksDocuments(db, ctx, { documents: [doc()] })).rejects.toThrow(/array/);
    expect(await db.taxIssuedInvoice.count({ where: { authWorkspaceId: ctx.workspaceId } })).toBe(0);
  });

  it('keeps each company to its own documents', async () => {
    const one = await workspace();
    const two = await workspace();
    await applyBooksDocuments(db, one.ctx, [doc()]);
    expect(await db.taxIssuedInvoice.count({ where: { authWorkspaceId: two.ctx.workspaceId } })).toBe(0);
    expect((await applyBooksDocuments(db, two.ctx, [doc()])).created).toBe(1);
  });
});

describe('the Books mirror: register rows of the same number', () => {
  it('attaches a register row with the same figures and keeps its payments', async () => {
    const { ws, ctx } = await workspace();
    const id = await saveInvoice(db, ctx, null, register({ payments: [{ date: '2026-08-10', cents: 20_000 }] }));
    const report = await applyBooksDocuments(db, ctx, [doc({ id: 'doc-61', number: '61', issueDate: '2026-08-01', totalCents: 50_000, dueDate: null })]);
    expect(report).toMatchObject({ created: 0, attached: 1, conflicts: [] });
    const row = await db.taxIssuedInvoice.findUniqueOrThrow({ where: { id }, include: { payments: true } });
    expect(row).toMatchObject({ source: 'books', booksDocumentId: 'doc-61' });
    expect(row.payments.map((p) => p.cents)).toEqual([20_000]);
    const view = await loadStatement(db, ws.workspaceId, 2026);
    expect(view.revenue.invoices[0]).toMatchObject({ outstandingCents: 30_000, receivedCents: 20_000 });
  });

  it('leaves a register row with other figures untouched and reports it', async () => {
    const { ctx } = await workspace();
    const id = await saveInvoice(db, ctx, null, register());
    const report = await applyBooksDocuments(db, ctx, [doc({ id: 'doc-61', number: '61', issueDate: '2026-08-01', totalCents: 51_000 })]);
    expect(report.conflicts).toEqual([{ number: '61', reason: 'register_differs' }]);
    expect(await db.taxIssuedInvoice.findUniqueOrThrow({ where: { id } })).toMatchObject({ source: 'register', booksDocumentId: null, grossCents: 50_000 });
  });

  it('a mirrored invoice keeps the figures of its document here; its payments are still entered here', async () => {
    const { ctx } = await workspace();
    await applyBooksDocuments(db, ctx, [doc()]);
    const id = (await db.taxIssuedInvoice.findFirstOrThrow({ where: { authWorkspaceId: ctx.workspaceId } })).id;
    const same = { number: '62', issueDate: '2026-09-01', grossCents: 75_000, vatCents: 0, treatment: 'small_business', declaredInYear: null };
    await expect(saveInvoice(db, ctx, id, { ...same, grossCents: 70_000, payments: [] })).rejects.toMatchObject({ code: 'invoice_from_books' });
    await expect(saveInvoice(db, ctx, id, { ...same, number: '99', payments: [] })).rejects.toMatchObject({ code: 'invoice_from_books' });
    await saveInvoice(db, ctx, id, { ...same, payments: [{ date: '2026-09-10', cents: 75_000 }] });
    expect(await db.taxInvoicePayment.count({ where: { invoiceId: id } })).toBe(1);
    await expect(deleteInvoice(db, ctx, id)).rejects.toMatchObject({ code: 'invoice_from_books' });
    expect(await db.taxIssuedInvoice.count({ where: { id } })).toBe(1);
  });
});

describe('the Books mirror: cancellations and corrections', () => {
  it('a credit note in a later pull ends the claim and the reminder', async () => {
    const { ws, ctx } = await workspace();
    await applyBooksDocuments(db, ctx, [doc()]);
    const report = await applyBooksDocuments(db, ctx, [doc({ id: 'cn-1', docType: 'credit_note', number: 'G-1', issueDate: '2026-10-02', correctsDocumentId: 'doc-62' })]);
    expect(report).toMatchObject({ updated: 1, conflicts: [] });
    const view = await loadStatement(db, ws.workspaceId, 2026);
    expect(view.revenue.invoices[0]).toMatchObject({ cancelledOn: '2026-10-02', outstandingCents: 0 });
    expect(view.revenue.overdue).toEqual([]);
  });

  it('a corrected invoice takes over the bank payment and the typed-in payment of the one it replaces; income stays', async () => {
    const { ws, ctx } = await workspace();
    await applyBooksDocuments(db, ctx, [doc()]);
    const oldId = (await db.taxIssuedInvoice.findFirstOrThrow({ where: { authWorkspaceId: ctx.workspaceId, number: '62' } })).id;
    await linkBankPayment(ctx, ws, oldId, '2026-09-10', 500, 'Rechnung 62');
    await saveInvoice(db, ctx, oldId, { number: '62', issueDate: '2026-09-01', grossCents: 75_000, vatCents: 0, treatment: 'small_business', declaredInYear: null, payments: [{ date: '2026-09-12', cents: 25_000 }] });
    const before = await loadStatement(db, ws.workspaceId, 2026);
    expect(before.revenue.receivedCents).toBe(75_000);

    const correction = [
      doc({ status: 'cancelled' }),
      doc({ id: 'cn-1', docType: 'credit_note', number: 'G-1', issueDate: '2026-10-02', correctsDocumentId: 'doc-62' }),
      doc({ id: 'doc-63', number: '63', issueDate: '2026-10-02', dueDate: '2026-10-16', replacesDocumentId: 'doc-62' }),
    ];
    const report = await applyBooksDocuments(db, ctx, correction);
    expect(report).toMatchObject({ created: 1, updated: 1, paymentsMoved: 2, conflicts: [] });

    const view = await loadStatement(db, ws.workspaceId, 2026);
    const byNumber = new Map(view.revenue.invoices.map((i) => [i.number, i]));
    expect(byNumber.get('62')).toMatchObject({ cancelledOn: '2026-10-02', outstandingCents: 0, receivedCents: 0, payments: [], checks: [] });
    expect(byNumber.get('63')).toMatchObject({ replacesNumber: '62', receivedCents: 75_000, outstandingCents: 0 });
    expect(view.revenue.receivedCents).toBe(75_000);

    // The same pull again moves nothing back and forth.
    const again = await applyBooksDocuments(db, ctx, correction);
    expect(again).toMatchObject({ created: 0, updated: 0, paymentsMoved: 0, unchanged: 2 });
  });

  it('a replacement whose replaced invoice the app never saw is reported, not guessed', async () => {
    const { ctx } = await workspace();
    const report = await applyBooksDocuments(db, ctx, [doc({ id: 'doc-63', number: '63', replacesDocumentId: 'doc-unknown' })]);
    expect(report.created).toBe(1);
    expect(report.conflicts).toEqual([{ number: '63', reason: 'replaced_invoice_unknown' }]);
  });
});
