import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { saveTaxSettings } from '@/lib/meals/service';
import { acceptEstimateProposals, deleteDecisionsForRows, isWorkspaceReceipt, loadStatement, receiptForLink, saveInvoice, type TaxContext } from '../../service';
import {
  PaymentServiceError,
  createAccount,
  deleteImportBatch,
  findPayments,
  importPayments,
  linkPayment,
  loadPayments,
  setAccountPrivate,
  setCounterpartyTreatment,
  setPaymentKind,
  setPaymentTransfer,
  unlinkPayment,
} from '../service';
import { PaymentParseError } from '../types';
import { createWorkspace, db, type TestWorkspace } from '../../../../../test/db-helpers';

/** Payments against a real database (migration 0013). Run with `pnpm test:db`. Every name and amount is invented. */

let other: TestWorkspace;
let otherCtx: TaxContext;

async function workspace(): Promise<{ ws: TestWorkspace; ctx: TaxContext; accountId: string }> {
  const ws = await createWorkspace();
  const ctx = { workspaceId: ws.workspaceId, tenantId: ws.tenantId };
  await saveTaxSettings(db, ctx, { smallBusiness: true });
  const accountId = await createAccount(db, ctx, { label: 'Geschäftskonto', kind: 'bank' });
  return { ws, ctx, accountId };
}

const HEADER = '"Booking Date","Value Date","Partner Name","Partner Iban",Type,"Payment Reference","Account Name","Amount (EUR)","Original Amount","Original Currency","Exchange Rate"';
const line = (day: string, partner: string, reference: string, amount: string, type = 'Presentment') =>
  `${day},${day},"${partner}",,${type},"${reference}",Hauptkonto,${amount},,,`;
const file = (...lines: string[]) => [HEADER, ...lines].join('\n') + '\n';

const JANUARY = file(
  line('2026-01-05', 'Werkzeug Beispiel GmbH', 'Bestellung 4711', '-108.5'),
  line('2026-01-20', 'Kundin Beispiel', 'Rechnung R-2026-001', '1000', 'Credit Transfer'),
  line('2026-01-22', 'Vermieter Beispiel', 'Miete', '-650', 'Debit Transfer'),
);

const code = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    if (e instanceof PaymentServiceError) return e.code;
    if (e instanceof PaymentParseError) return `${e.code}:${e.row}`;
    throw e;
  }
  return 'no error';
};

const rowCheck = (ctx: TaxContext) => receiptForLink(db, ctx.workspaceId);

beforeAll(async () => {
  const o = await workspace();
  other = o.ws;
  otherCtx = o.ctx;
});

afterAll(async () => {
  await db.$disconnect();
});

describe('import: forward, repeat, overlap, undo', () => {
  it('imports a file once, links an incoming payment to its invoice by number, and refuses the same file again', async () => {
    const { ws, ctx, accountId } = await workspace();
    const invoiceId = await saveInvoice(db, ctx, null, { number: 'R-2026-001', issueDate: '2026-01-10', grossCents: 100_000, treatment: 'small_business', payments: [] });
    const result = await importPayments(db, ctx, accountId, JANUARY);
    expect(result).toMatchObject({ format: 'n26_csv', total: 3, added: 3, alreadyThere: 0, autoLinked: 1, firstDay: '2026-01-05', lastDay: '2026-01-22' });

    const view = await loadStatement(db, ws.workspaceId, 2026);
    // The invoice is paid by the bank payment: revenue on the booking day, nothing typed in.
    expect(view.revenue.invoices[0]).toMatchObject({ id: invoiceId, receivedCents: 100_000, outstandingCents: 0, payments: [{ date: '2026-01-20', cents: 100_000 }] });
    expect(view.lines.find((l) => l.key === 'euer.revenue_small_business')?.cents).toBe(100_000);
    expect(view.payments).toMatchObject({ yearCount: 3, linkedCount: 1 });
    expect(view.payments.accounts[0]).toMatchObject({ label: 'Geschäftskonto', paymentCount: 3, completeThrough: '2026-01-22' });
    expect(view.payments.links[0]).toMatchObject({ target: 'invoice', targetLabel: 'Rechnung R-2026-001', method: 'reference' });
    const stored = await db.taxPayment.findFirst({ where: { accountId } });
    expect(stored).toMatchObject({ authWorkspaceId: ws.workspaceId, authTenantId: ws.tenantId });

    expect(await code(importPayments(db, ctx, accountId, JANUARY))).toBe('file_already_imported');
    expect(await db.taxPayment.count({ where: { accountId } })).toBe(3);
  });

  it('an overlapping export adds only what is new', async () => {
    const { ctx, accountId } = await workspace();
    await importPayments(db, ctx, accountId, JANUARY);
    const overlap = file(
      line('2026-01-22', 'Vermieter Beispiel', 'Miete', '-650', 'Debit Transfer'),
      line('2026-02-03', 'Werkzeug Beispiel GmbH', 'Bestellung 4712', '-20'),
    );
    expect(await importPayments(db, ctx, accountId, overlap)).toMatchObject({ total: 2, added: 1, alreadyThere: 1 });
    expect(await db.taxPayment.count({ where: { accountId } })).toBe(4);
  });

  it('a file with an unreadable row or an unknown layout writes nothing', async () => {
    const { ctx, accountId } = await workspace();
    expect(await code(importPayments(db, ctx, accountId, JANUARY.replace('-650', 'viel')))).toBe('unreadable_row:4');
    expect(await code(importPayments(db, ctx, accountId, 'a,b\n1,2\n'))).toBe('unknown_layout:null');
    expect(await db.taxImportBatch.count({ where: { accountId } })).toBe(0);
    expect(await db.taxPayment.count({ where: { accountId } })).toBe(0);
  });

  it('undoing an import removes its payments and links, and the invoice is open again', async () => {
    const { ws, ctx, accountId } = await workspace();
    await saveInvoice(db, ctx, null, { number: 'R-2026-001', issueDate: '2026-01-10', grossCents: 100_000, treatment: 'small_business', payments: [] });
    const { batchId } = await importPayments(db, ctx, accountId, JANUARY);
    await deleteImportBatch(db, ctx, batchId);
    expect(await db.taxPayment.count({ where: { accountId } })).toBe(0);
    expect(await db.taxPaymentLink.count({ where: { authWorkspaceId: ws.workspaceId } })).toBe(0);
    expect((await loadStatement(db, ws.workspaceId, 2026)).revenue.invoices[0]).toMatchObject({ receivedCents: 0, outstandingCents: 100_000 });
    // After the undo the same file can be imported again.
    expect((await importPayments(db, ctx, accountId, JANUARY)).added).toBe(3);
  });

  it('an account needs a name and a kind, once', async () => {
    const { ctx } = await workspace();
    expect(await code(createAccount(db, ctx, { label: ' ', kind: 'bank' }))).toBe('account_label_required');
    expect(await code(createAccount(db, ctx, { label: 'Karte', kind: 'wallet' }))).toBe('invalid_account_kind');
    expect(await code(createAccount(db, ctx, { label: 'Geschäftskonto', kind: 'bank' }))).toBe('account_label_taken');
  });
});

describe('counterparties, open payments and links', () => {
  it('asks once per counterparty; business payments then wait for a document, private ones are left alone', async () => {
    const { ws, ctx, accountId } = await workspace();
    await importPayments(db, ctx, accountId, JANUARY);
    let view = await loadStatement(db, ws.workspaceId, 2026);
    expect(view.payments.unclassified.map((c) => [c.label, c.count, c.outCents, c.inCents])).toEqual([
      ['Kundin Beispiel', 1, 0, 100_000],
      ['Vermieter Beispiel', 1, 65_000, 0],
      ['Werkzeug Beispiel GmbH', 1, 10_850, 0],
    ]);
    // Nothing is asked about payment by payment before the counterparty is answered: money in neither
    // (it does not look like the payment of an invoice; see the tests on money in below).
    expect(view.payments.open).toEqual([]);
    await setCounterpartyTreatment(db, ctx, { counterparty: 'Kundin Beispiel', treatment: 'business' });

    await setCounterpartyTreatment(db, ctx, { counterparty: 'Werkzeug Beispiel GmbH', treatment: 'business' });
    await setCounterpartyTreatment(db, ctx, { counterparty: 'Vermieter Beispiel', treatment: 'private' });
    view = await loadStatement(db, ws.workspaceId, 2026);
    expect(view.payments.unclassified).toEqual([]);
    expect(view.payments.open.map((p) => [p.counterparty, p.check])).toEqual([
      ['Werkzeug Beispiel GmbH', 'payment_without_document'],
      ['Kundin Beispiel', 'income_without_invoice'],
    ]);
    // Taking an answer back asks again.
    await setCounterpartyTreatment(db, ctx, { counterparty: 'Vermieter Beispiel', treatment: null });
    expect((await loadStatement(db, ws.workspaceId, 2026)).payments.unclassified.map((c) => c.label)).toContain('Vermieter Beispiel');
  });

  it('a linked payment gives the receipt its payment day and the euro amount actually charged', async () => {
    const { ws, ctx, accountId } = await workspace();
    // A dollar receipt dated in December, estimated at a reference rate, charged in January.
    const rowId = await ws.addReceipt({ Name: 'Lizenz', Vendor: 'Werkzeug Beispiel GmbH', Gross: 120, Date: '2025-12-28', Category: 'Software & Lizenzen', Zuordnung: 'Geschäftlich', Currency: 'USD', 'FX Rate': 0.9 });
    await importPayments(db, ctx, accountId, JANUARY);
    await setCounterpartyTreatment(db, ctx, { counterparty: 'Werkzeug Beispiel GmbH', treatment: 'business' });
    const before2025 = await loadStatement(db, ws.workspaceId, 2025);
    expect(before2025.items.find((i) => i.rowId === rowId)).toMatchObject({ amountCents: 10_800, amountBasis: 'reference_rate' });

    const payment = (await loadStatement(db, ws.workspaceId, 2026)).payments.open.find((p) => p.check === 'payment_without_document')!;
    // No candidate is offered across the turn of the year by amount (10,800 against 10,850): a person links it.
    expect(payment.proposals).toEqual([]);
    const { linkId } = await linkPayment(db, ctx, { paymentId: payment.id, rowId }, rowCheck(ctx));

    // Cash basis: the receipt left 2025 and counts in 2026 with what the bank charged.
    expect((await loadStatement(db, ws.workspaceId, 2025)).items.find((i) => i.rowId === rowId)).toBeUndefined();
    const after = await loadStatement(db, ws.workspaceId, 2026);
    expect(after.items.find((i) => i.rowId === rowId)).toMatchObject({ date: '2026-01-05', amountCents: 10_850, amountBasis: 'payment', checks: [] });
    expect(after.payments.open.some((p) => p.id === payment.id)).toBe(false);
    expect(after.payments.links.find((l) => l.linkId === linkId)).toMatchObject({ target: 'receipt', targetLabel: 'Lizenz', method: 'manual' });

    // Unlinking restores the estimate exactly.
    await unlinkPayment(db, ctx, linkId);
    expect((await loadStatement(db, ws.workspaceId, 2025)).items.find((i) => i.rowId === rowId)).toMatchObject({ amountCents: 10_800, amountBasis: 'reference_rate' });
  });

  it('offers a receipt of the same amount near the payment as a candidate, never links it by itself', async () => {
    const { ws, ctx, accountId } = await workspace();
    const rowId = await ws.addReceipt({ Name: 'Werkzeugkauf', Vendor: 'Werkzeug Beispiel GmbH', Gross: 108.5, Date: '2026-01-03', Category: 'Bürobedarf', Zuordnung: 'Geschäftlich', Currency: 'EUR', 'FX Rate': 1 });
    const result = await importPayments(db, ctx, accountId, JANUARY);
    expect(result.autoLinked).toBe(0);
    await setCounterpartyTreatment(db, ctx, { counterparty: 'Werkzeug Beispiel GmbH', treatment: 'business' });
    const open = (await loadStatement(db, ws.workspaceId, 2026)).payments.open.find((p) => p.check === 'payment_without_document')!;
    // The payment names the receipt's vendor: a candidate of amount, date and vendor, still never linked by itself.
    expect(open.proposals).toEqual([{ target: 'receipt', targetId: rowId, label: 'Werkzeugkauf', strength: 'amount_date_vendor' }]);
  });

  it('a refund linked to the same receipt is taken off; a fully refunded purchase is no expense', async () => {
    const { ws, ctx, accountId } = await workspace();
    const rowId = await ws.addReceipt({ Name: 'Doppelt abgebucht', Vendor: 'Werkzeug Beispiel GmbH', Gross: 108.5, Date: '2026-01-03', Category: 'Bürobedarf', Zuordnung: 'Geschäftlich', Currency: 'EUR', 'FX Rate': 1 });
    await importPayments(db, ctx, accountId, file(
      line('2026-01-05', 'Werkzeug Beispiel GmbH', 'Bestellung 4711', '-108.5'),
      line('2026-01-09', 'Werkzeug Beispiel GmbH', 'Erstattung 4711', '108.5', 'Credit Transfer'),
    ));
    const payments = await db.taxPayment.findMany({ where: { accountId }, orderBy: { bookingDay: 'asc' } });
    await linkPayment(db, ctx, { paymentId: payments[0].id, rowId }, rowCheck(ctx));
    await setPaymentKind(db, ctx, payments[1].id, 'refund');
    await linkPayment(db, ctx, { paymentId: payments[1].id, rowId }, rowCheck(ctx));
    const view = await loadStatement(db, ws.workspaceId, 2026);
    expect(view.items.find((i) => i.rowId === rowId)).toMatchObject({ amountCents: 0, counted: true });
    expect(view.businessExpenseCents).toBe(0);
    expect(view.lines).toEqual([]);
  });

  it('one payment can be split over two receipts, but never beyond its amount', async () => {
    const { ws, ctx, accountId } = await workspace();
    const a = await ws.addReceipt({ Name: 'Teil A', Vendor: 'Werkzeug Beispiel GmbH', Gross: 60, Date: '2026-01-03', Category: 'Bürobedarf', Zuordnung: 'Geschäftlich', Currency: 'EUR', 'FX Rate': 1 });
    const b = await ws.addReceipt({ Name: 'Teil B', Vendor: 'Werkzeug Beispiel GmbH', Gross: 48.5, Date: '2026-01-03', Category: 'Bürobedarf', Zuordnung: 'Geschäftlich', Currency: 'EUR', 'FX Rate': 1 });
    await importPayments(db, ctx, accountId, JANUARY);
    const payment = (await db.taxPayment.findFirst({ where: { accountId, amountCents: -10_850 } }))!;
    await linkPayment(db, ctx, { paymentId: payment.id, rowId: a, cents: 6_000 }, rowCheck(ctx));
    expect(await code(linkPayment(db, ctx, { paymentId: payment.id, rowId: b, cents: 5_000 }, rowCheck(ctx)))).toBe('link_exceeds_payment');
    await linkPayment(db, ctx, { paymentId: payment.id, rowId: b }, rowCheck(ctx));
    const view = await loadStatement(db, ws.workspaceId, 2026);
    expect(view.items.find((i) => i.rowId === a)?.amountCents).toBe(6_000);
    expect(view.items.find((i) => i.rowId === b)?.amountCents).toBe(4_850);
    expect(await code(linkPayment(db, ctx, { paymentId: payment.id, rowId: a }, rowCheck(ctx)))).toBe('invalid_link');
  });

  it('deleting a receipt removes its links; the payment waits for a document again', async () => {
    const { ws, ctx, accountId } = await workspace();
    const rowId = await ws.addReceipt({ Name: 'Wird gelöscht', Vendor: 'Werkzeug Beispiel GmbH', Gross: 108.5, Date: '2026-01-03', Category: 'Bürobedarf', Zuordnung: 'Geschäftlich', Currency: 'EUR', 'FX Rate': 1 });
    await importPayments(db, ctx, accountId, JANUARY);
    await setCounterpartyTreatment(db, ctx, { counterparty: 'Werkzeug Beispiel GmbH', treatment: 'business' });
    const payment = (await db.taxPayment.findFirst({ where: { accountId, amountCents: -10_850 } }))!;
    await linkPayment(db, ctx, { paymentId: payment.id, rowId }, rowCheck(ctx));
    await ws.adapter.deleteRow(rowId);
    await deleteDecisionsForRows(db, [rowId]);
    expect(await db.taxPaymentLink.count({ where: { rowId } })).toBe(0);
    expect((await loadStatement(db, ws.workspaceId, 2026)).payments.open.map((p) => p.id)).toContain(payment.id);
  });

  it('rejects malformed links and kinds', async () => {
    const { ctx, accountId } = await workspace();
    await importPayments(db, ctx, accountId, JANUARY);
    const payment = (await db.taxPayment.findFirst({ where: { accountId } }))!;
    expect(await code(linkPayment(db, ctx, { paymentId: payment.id }, rowCheck(ctx)))).toBe('invalid_link');
    expect(await code(linkPayment(db, ctx, { paymentId: payment.id, rowId: 'x', invoiceId: 'y' }, rowCheck(ctx)))).toBe('invalid_link');
    expect(await code(linkPayment(db, ctx, { paymentId: payment.id, rowId: 'missing-row' }, rowCheck(ctx)))).toBe('target_not_found');
    expect(await code(linkPayment(db, ctx, { paymentId: payment.id, invoiceId: 'missing-invoice' }, rowCheck(ctx)))).toBe('target_not_found');
    expect(await code(setPaymentKind(db, ctx, payment.id, 'gift'))).toBe('invalid_kind');
    expect(await code(setCounterpartyTreatment(db, ctx, { counterparty: '', treatment: 'business' }))).toBe('invalid_treatment');
  });
});

describe('findings of the review on the first version', () => {
  const FEBRUARY = file(line('2026-01-22', 'Vermieter Beispiel', 'Miete', '-650', 'Debit Transfer'), line('2026-02-03', 'Werkzeug Beispiel GmbH', 'Bestellung 4712', '-20'));

  it('a link to an invoice never counts more than the invoice still has open', async () => {
    const { ws, ctx, accountId } = await workspace();
    // 300.00 of 500.00 were typed in by hand; the bank file then brings the full 500.00.
    const invoiceId = await saveInvoice(db, ctx, null, { number: 'R-2026-050', issueDate: '2026-01-10', grossCents: 50_000, treatment: 'small_business', payments: [{ date: '2026-01-12', cents: 30_000 }] });
    await importPayments(db, ctx, accountId, file(line('2026-01-20', 'Kundin Beispiel', 'Zahlung', '500', 'Credit Transfer')));
    const payment = (await db.taxPayment.findFirst({ where: { authWorkspaceId: ws.workspaceId } }))!;
    expect(await code(linkPayment(db, ctx, { paymentId: payment.id, invoiceId, cents: 50_000 }, rowCheck(ctx)))).toBe('link_exceeds_payment');
    await linkPayment(db, ctx, { paymentId: payment.id, invoiceId }, rowCheck(ctx));
    const view = await loadStatement(db, ws.workspaceId, 2026);
    expect(view.revenue.invoices[0]).toMatchObject({ receivedCents: 50_000, outstandingCents: 0 });
    // The 300.00 that are left of the payment still wait for an answer: the counterparty's, then the payment's.
    expect(view.payments.unclassified.map((c) => c.label)).toEqual(['Kundin Beispiel']);
    await setCounterpartyTreatment(db, ctx, { counterparty: 'Kundin Beispiel', treatment: 'business' });
    expect((await loadStatement(db, ws.workspaceId, 2026)).payments.open.map((o) => o.freeCents)).toEqual([30_000]);
    expect(await code(linkPayment(db, ctx, { paymentId: payment.id, invoiceId }, rowCheck(ctx)))).toBe('target_fully_paid');
  });

  it('money going out is never linked to an invoice', async () => {
    const { ws, ctx, accountId } = await workspace();
    const invoiceId = await saveInvoice(db, ctx, null, { number: 'R-2026-051', issueDate: '2026-01-10', grossCents: 65_000, treatment: 'small_business', payments: [] });
    await importPayments(db, ctx, accountId, JANUARY);
    const rent = (await db.taxPayment.findFirst({ where: { authWorkspaceId: ws.workspaceId, amountCents: -65_000 } }))!;
    expect(await code(linkPayment(db, ctx, { paymentId: rent.id, invoiceId }, rowCheck(ctx)))).toBe('invalid_link');
    expect(await db.taxPaymentLink.count({ where: { paymentId: rent.id } })).toBe(0);
  });

  it('two confirmations at the same moment cannot both use the same payment', async () => {
    const { ws, ctx, accountId } = await workspace();
    await importPayments(db, ctx, accountId, JANUARY);
    const payment = (await db.taxPayment.findFirst({ where: { authWorkspaceId: ws.workspaceId, amountCents: -10_850 } }))!;
    const a = await ws.addReceipt({ Name: 'A', Gross: 108.5, Date: '2026-01-05', Category: 'Bürobedarf', Currency: 'EUR', 'FX Rate': 1 });
    const b = await ws.addReceipt({ Name: 'B', Gross: 108.5, Date: '2026-01-05', Category: 'Bürobedarf', Currency: 'EUR', 'FX Rate': 1 });
    const results = await Promise.all([a, b].map((rowId) => code(linkPayment(db, ctx, { paymentId: payment.id, rowId }, rowCheck(ctx)))));
    expect(results.filter((r) => r === 'no error')).toHaveLength(1);
    expect((await db.taxPaymentLink.findMany({ where: { paymentId: payment.id } })).reduce((s, l) => s + l.cents, 0)).toBe(10_850);
  });

  it('an import is undone newest first: an older file a later one overlaps stays', async () => {
    const { ws, ctx, accountId } = await workspace();
    const first = await importPayments(db, ctx, accountId, JANUARY);
    const second = await importPayments(db, ctx, accountId, FEBRUARY);
    expect(second).toMatchObject({ added: 1, alreadyThere: 1 });
    expect(await code(deleteImportBatch(db, ctx, first.batchId))).toBe('batch_has_later_overlap');
    expect(await db.taxPayment.count({ where: { authWorkspaceId: ws.workspaceId } })).toBe(4);
    await deleteImportBatch(db, ctx, second.batchId);
    await deleteImportBatch(db, ctx, first.batchId);
    expect(await db.taxPayment.count({ where: { authWorkspaceId: ws.workspaceId } })).toBe(0);
  });

  it('an account continued from a second source stores no movement twice: a day belongs to the source that brought it first', async () => {
    const { ws, ctx, accountId } = await workspace();
    await importPayments(db, ctx, accountId, JANUARY);
    // The other source repeats 22 January (stored by the first under another identity) and continues on 1 February.
    const tomorrow = 'account_type,booking_date,valuta_date,sender_or_recipient,iban,booking_type,description,category,amount,currency\nPersonal Account,2026-01-22,2026-01-22,Vermieter Beispiel,,Debit Transfer,Miete,housing,"-650,00",EUR\nPersonal Account,2026-02-01,2026-02-01,Laden Beispiel,,Card Payment,Einkauf,shopping,"-12,00",EUR\n';
    expect(await importPayments(db, ctx, accountId, tomorrow)).toMatchObject({ format: 'tomorrow_csv', total: 1, added: 1, skipped: { covered_by_other_source: 1 }, firstDay: '2026-02-01', lastDay: '2026-02-01' });
    expect(await db.taxPayment.count({ where: { accountId } })).toBe(4);
    expect(await db.taxImportBatch.count({ where: { authWorkspaceId: ws.workspaceId } })).toBe(2);
  });

  it('an earlier unlinked payment naming the same invoice makes a new one ambiguous: no automatic link', async () => {
    const { ws, ctx, accountId } = await workspace();
    await importPayments(db, ctx, accountId, file(line('2026-01-15', 'Kundin Beispiel', 'Rechnung R-2026-060', '400', 'Credit Transfer')));
    await saveInvoice(db, ctx, null, { number: 'R-2026-060', issueDate: '2026-01-10', grossCents: 40_000, treatment: 'small_business', payments: [] });
    const later = await importPayments(db, ctx, accountId, file(line('2026-02-15', 'Kundin Beispiel', 'Rechnung R-2026-060', '400', 'Credit Transfer')));
    expect(later.autoLinked).toBe(0);
    expect(await db.taxPaymentLink.count({ where: { authWorkspaceId: ws.workspaceId } })).toBe(0);
  });

  it('two imports of overlapping files at the same moment store every payment once', async () => {
    const { ws, ctx, accountId } = await workspace();
    const results = await Promise.all([importPayments(db, ctx, accountId, JANUARY), importPayments(db, ctx, accountId, FEBRUARY)]);
    expect(results.reduce((s, r) => s + r.added, 0)).toBe(4);
    expect(await db.taxPayment.count({ where: { authWorkspaceId: ws.workspaceId } })).toBe(4);
  });

  it('a payment without a name is asked about on its own, can be marked private, and that can be put back', async () => {
    const { ws, ctx, accountId } = await workspace();
    await importPayments(db, ctx, accountId, file(line('2026-01-07', '', 'Kartenzahlung', '-12.3')));
    let view = await loadStatement(db, ws.workspaceId, 2026);
    expect(view.payments.open.map((o) => [o.check, o.freeCents])).toEqual([['payment_without_document', 1_230]]);
    await setPaymentKind(db, ctx, view.payments.open[0].id, 'private');
    view = await loadStatement(db, ws.workspaceId, 2026);
    expect(view.payments.open).toEqual([]);
    expect(view.payments.overridden.map((o) => [o.kind, o.amountCents])).toEqual([['private', -1_230]]);
    await setPaymentKind(db, ctx, view.payments.overridden[0].id, null);
    view = await loadStatement(db, ws.workspaceId, 2026);
    expect(view.payments.open).toHaveLength(1);
    expect(view.payments.overridden).toEqual([]);
  });

  it('a receipt of last year paid this year, and a different amount, can be linked by hand', async () => {
    const { ws, ctx, accountId } = await workspace();
    const rowId = await ws.addReceipt({ Name: 'Bestellung 4711', Vendor: 'Werkzeug Beispiel GmbH', Gross: 100, Date: '2025-12-28', Category: 'Bürobedarf', Currency: 'EUR', 'FX Rate': 1 });
    await importPayments(db, ctx, accountId, JANUARY);
    await setCounterpartyTreatment(db, ctx, { counterparty: 'Werkzeug Beispiel GmbH', treatment: 'business' });
    const view = await loadStatement(db, ws.workspaceId, 2026);
    const open = view.payments.open.find((o) => o.freeCents === 10_850)!;
    // No proposal (other year, other amount), but the receipt can be chosen.
    expect(open.proposals).toEqual([]);
    expect(view.payments.receiptTargets.map((t) => t.id)).toContain(rowId);
    await linkPayment(db, ctx, { paymentId: open.id, rowId }, rowCheck(ctx));
    const after = await loadStatement(db, ws.workspaceId, 2026);
    // Paid in January 2026: the expense belongs to 2026, with the amount actually charged.
    expect(after.items.find((i) => i.rowId === rowId)).toMatchObject({ amountCents: 10_850, date: '2026-01-05' });
  });
});

describe('findings of the review on the second version', () => {
  it('a refund linked to a receipt whose purchase is not linked is taken off the receipt, not put in its place', async () => {
    const { ws, ctx, accountId } = await workspace();
    // Paid in cash on the 3rd; 50.00 came back to the bank account on the 9th.
    const rowId = await ws.addReceipt({ Name: 'Barkauf', Vendor: 'Werkzeug Beispiel GmbH', Gross: 500, Date: '2026-01-03', Category: 'Bürobedarf', Zuordnung: 'Geschäftlich', Currency: 'EUR', 'FX Rate': 1 });
    await importPayments(db, ctx, accountId, file(line('2026-01-09', 'Werkzeug Beispiel GmbH', 'Erstattung', '50', 'Credit Transfer')));
    const refund = (await db.taxPayment.findFirst({ where: { accountId } }))!;
    await setPaymentKind(db, ctx, refund.id, 'refund');
    await linkPayment(db, ctx, { paymentId: refund.id, rowId }, rowCheck(ctx));
    const view = await loadStatement(db, ws.workspaceId, 2026);
    expect(view.items.find((i) => i.rowId === rowId)).toMatchObject({ amountCents: 45_000, date: '2026-01-03', amountBasis: 'document' });
    expect(view.businessExpenseCents).toBe(45_000);
  });

  it('money back is never linked to an invoice, whatever its sign', async () => {
    const { ws, ctx, accountId } = await workspace();
    const invoiceId = await saveInvoice(db, ctx, null, { number: 'R-2026-070', issueDate: '2026-01-10', grossCents: 5_000, treatment: 'small_business', payments: [] });
    await importPayments(db, ctx, accountId, file(line('2026-01-09', 'Werkzeug Beispiel GmbH', 'Erstattung', '50', 'Credit Transfer')));
    const refund = (await db.taxPayment.findFirst({ where: { accountId } }))!;
    await setPaymentKind(db, ctx, refund.id, 'refund');
    expect(await code(linkPayment(db, ctx, { paymentId: refund.id, invoiceId }, rowCheck(ctx)))).toBe('invalid_link');
    expect(await db.taxPaymentLink.count({ where: { authWorkspaceId: ws.workspaceId } })).toBe(0);
  });

  it('two payments confirmed for one invoice at the same moment cannot both use what it has open', async () => {
    const { ws, ctx, accountId } = await workspace();
    const invoiceId = await saveInvoice(db, ctx, null, { number: 'R-2026-071', issueDate: '2026-01-10', grossCents: 40_000, treatment: 'small_business', payments: [] });
    await importPayments(db, ctx, accountId, file(line('2026-01-15', 'Kundin Beispiel', 'Zahlung eins', '400', 'Credit Transfer'), line('2026-01-16', 'Kundin Beispiel', 'Zahlung zwei', '400', 'Credit Transfer')));
    const payments = await db.taxPayment.findMany({ where: { accountId } });
    const results = await Promise.all(payments.map((p) => code(linkPayment(db, ctx, { paymentId: p.id, invoiceId }, rowCheck(ctx)))));
    expect(results.sort()).toEqual(['no error', 'target_fully_paid']);
    expect((await loadStatement(db, ws.workspaceId, 2026)).revenue.invoices[0]).toMatchObject({ receivedCents: 40_000, outstandingCents: 0 });
  });
});

// The purchase list of the pay-later service and a PayPal export, with invented rows.
const LATER_HEADER = 'created_date,created_time,activated,settled,amount,currency,merchant,items,payment_method,status,payment_reference,statement_number,category,purchase_type,card,source,timezone';
const later = (day: string, merchant: string, amount: string, reference: string, status = 'Normal') =>
  [day, '09:30', `${day} 09:31`, '', amount, 'EUR', `"${merchant}"`, `"${merchant} Bestellung"`, 'Invoice', `"${status}"`, reference, reference ? `ORDER${reference}` : `WEB${day}`, '', '', '', 'beispiel-quelle', 'Europe/Berlin'].join(',');
const laterFile = (...lines: string[]) => [LATER_HEADER, ...lines].join('\n') + '\n';
const WALLET_HEADER =
  'Datum,Uhrzeit,Zeitzone,Name,Typ,Status,Währung,Brutto,Gebühr,Netto,Absender E-Mail-Adresse,Empfänger E-Mail-Adresse,Transaktionscode,Lieferadresse,Adress-Status,Artikelbezeichnung,Artikelnummer,Versand- und Bearbeitungsgebühr,Versicherungsbetrag,Umsatzsteuer,Option 1 Name,Option 1 Wert,Option 2 Name,Option 2 Wert,Zugehöriger Transaktionscode,Rechnungsnummer,Zollnummer,Anzahl,Empfangsnummer,Guthaben,Adresszeile 1,Adresszusatz,Ort,Bundesland,PLZ,Land,Telefon,Betreff,Hinweis,Ländervorwahl,Auswirkung auf Guthaben';
const walletFile = (...rows: Array<{ date: string; name: string; gross: string; code: string; type?: string }>) =>
  [
    WALLET_HEADER,
    ...rows.map((o) => {
      const cells = Array(41).fill('');
      Object.assign(cells, { 0: o.date, 3: o.name, 4: o.type ?? 'PayPal Express-Zahlung', 5: 'Abgeschlossen', 6: 'EUR', 7: o.gross, 12: o.code, 40: 'Soll' });
      return cells.map((c: string) => `"${c}"`).join(',');
    }),
  ].join('\n') + '\n';

const MARCH = laterFile(
  later('2025-03-03', 'EDITOR BEISPIEL, AI TOOLS', '20.75', '4000000000001'),
  later('2025-03-10', 'Schreibwaren Beispiel', '12.40', '4000000000002'),
);
/** The same list reaching to the end of the month: the days it covers decide what on the bank is a transfer. */
const MARCH_WHOLE = laterFile(
  later('2025-03-01', 'Kiosk Beispiel', '1.00', '4000000000000'),
  later('2025-03-03', 'EDITOR BEISPIEL, AI TOOLS', '20.75', '4000000000001'),
  later('2025-03-10', 'Schreibwaren Beispiel', '12.40', '4000000000002'),
  later('2025-03-31', 'Kiosk Beispiel', '2.00', '4000000000003'),
);
/** A wallet list of March 2025 with one purchase of 19.99 on the 11th, and 50.00 sent back to the bank on the 13th (a row without a merchant). */
const WALLET_MARCH = walletFile(
  { date: '01.03.2025', name: 'Kiosk Beispiel', gross: '-1,00', code: 'TXW0' },
  { date: '11.03.2025', name: 'Laden Beispiel', gross: '-19,99', code: 'TXW1' },
  { date: '13.03.2025', name: '', gross: '-50,00', code: 'TXW2', type: 'Rückbuchung von ACH-Gutschrift' },
  { date: '31.03.2025', name: 'Kiosk Beispiel', gross: '-2,00', code: 'TXW9' },
);
/** A dollar receipt of 2 March 2025: 22.00 at 0.91, an estimate of 20.02 euro. */
const dollarReceipt = (ws: TestWorkspace, overrides: Record<string, string | number> = {}) =>
  ws.addReceipt({ Name: 'Editor Beispiel März', Vendor: 'Editor Beispiel', Gross: 22, Date: '2025-03-02', Category: 'Software & Lizenzen', Zuordnung: 'Geschäftlich', Currency: 'USD', 'FX Rate': 0.91, ...overrides });
const proposalsOf = async (workspaceId: string) => (await loadStatement(db, workspaceId, 2025)).payments.estimateProposals;
const pairs = (list: Array<{ paymentId: string; rowId: string }>) => list.map((p) => ({ paymentId: p.paymentId, rowId: p.rowId }));
/** What the screen does for "Alle eindeutigen Vorschläge übernehmen": it sends the unambiguous pairs it shows. */
const acceptAllShown = async (ctx: TaxContext) => acceptEstimateProposals(db, ctx, 2025, pairs((await proposalsOf(ctx.workspaceId)).filter((p) => p.unambiguous)), true);

async function withLaterAccount() {
  const base = await workspace();
  const laterId = await createAccount(db, base.ctx, { label: 'Später zahlen', kind: 'payment_service' });
  return { ...base, laterId };
}

describe('the pay-later purchase list: forward, change an earlier input, resume, re-entry', () => {
  it('forward: the list is imported, the estimated receipt gets a proposal, and nothing is linked until it is accepted', async () => {
    const { ws, ctx, laterId } = await withLaterAccount();
    const rowId = await dollarReceipt(ws);
    const result = await importPayments(db, ctx, laterId, MARCH);
    expect(result).toMatchObject({ format: 'klarna_csv', total: 2, added: 2, alreadyThere: 0, skipped: {}, cancelledEarlier: 0, adopted: 0, firstDay: '2025-03-03', lastDay: '2025-03-10' });

    const before = await loadStatement(db, ws.workspaceId, 2025);
    // Proposed although nobody has said what the counterparty is: the vendor on the receipt is the evidence.
    expect(before.payments.unclassified.map((c) => c.label)).toContain('EDITOR BEISPIEL, AI TOOLS');
    expect(before.payments.estimateProposals).toEqual([
      expect.objectContaining({ rowId, receiptLabel: 'Editor Beispiel März', receiptDay: '2025-03-02', estimateCents: 2002, bookingDay: '2025-03-03', paidCents: 2075, accountLabel: 'Später zahlen', unambiguous: true }),
    ]);
    expect(before.payments.links).toEqual([]);
    expect(before.items.find((i) => i.rowId === rowId)).toMatchObject({ amountCents: 2002, amountBasis: 'reference_rate' });

    expect(await acceptAllShown(ctx)).toEqual({ linked: [{ paymentId: before.payments.estimateProposals[0].paymentId, rowId }], skipped: 0 });
    const after = await loadStatement(db, ws.workspaceId, 2025);
    // The receipt counts with what was paid, on the day it was paid.
    expect(after.items.find((i) => i.rowId === rowId)).toMatchObject({ date: '2025-03-03', amountCents: 2075, amountBasis: 'payment' });
    expect(after.payments.estimateProposals).toEqual([]);
    expect(after.payments.links).toEqual([expect.objectContaining({ target: 'receipt', targetLabel: 'Editor Beispiel März', cents: 2075, method: 'estimate', counts: true })]);
  });

  it('change an earlier input: undoing the import takes the payments and the accepted link with it, the estimate is back', async () => {
    const { ws, ctx, laterId } = await withLaterAccount();
    const rowId = await dollarReceipt(ws);
    const first = await importPayments(db, ctx, laterId, MARCH);
    expect((await acceptAllShown(ctx)).linked.length).toBe(1);

    await deleteImportBatch(db, ctx, first.batchId);
    const undone = await loadStatement(db, ws.workspaceId, 2025);
    // Everything derived from the file is gone: no payment, no link, no proposal, the receipt on its estimate.
    expect(await db.taxPayment.count({ where: { accountId: laterId } })).toBe(0);
    expect(await db.taxPaymentLink.count({ where: { authWorkspaceId: ws.workspaceId } })).toBe(0);
    expect(undone.payments.estimateProposals).toEqual([]);
    expect(undone.items.find((i) => i.rowId === rowId)).toMatchObject({ date: '2025-03-02', amountCents: 2002, amountBasis: 'reference_rate' });

    // A corrected file (another amount for the same purchase) is a new input: the proposal is built from it, not from the old one.
    await importPayments(db, ctx, laterId, MARCH.replace('20.75', '19.50'));
    expect(await proposalsOf(ws.workspaceId)).toEqual([expect.objectContaining({ rowId, paidCents: 1950, unambiguous: true })]);
  });

  it('change an earlier input, the counter-case: a longer file over the same days adds only what is new and keeps the accepted link', async () => {
    const { ws, ctx, laterId } = await withLaterAccount();
    const rowId = await dollarReceipt(ws);
    await importPayments(db, ctx, laterId, MARCH);
    expect((await acceptAllShown(ctx)).linked.length).toBe(1);
    const linkBefore = await db.taxPaymentLink.findFirstOrThrow({ where: { authWorkspaceId: ws.workspaceId } });

    // The same purchases under a corrected merchant name, plus one more: identity is the payment reference.
    const longer = laterFile(
      later('2025-03-03', 'Editor Beispiel Inc', '20.75', '4000000000001'),
      later('2025-03-10', 'Schreibwaren Beispiel', '12.40', '4000000000002'),
      later('2025-03-20', 'Hosting Beispiel', '5.00', '4000000000003'),
    );
    expect(await importPayments(db, ctx, laterId, longer)).toMatchObject({ total: 3, added: 1, alreadyThere: 2 });
    expect(await db.taxPayment.count({ where: { accountId: laterId } })).toBe(3);
    expect(await db.taxPaymentLink.findFirstOrThrow({ where: { authWorkspaceId: ws.workspaceId } })).toMatchObject({ id: linkBefore.id, rowId, cents: 2075 });
  });

  it('resume: the same file is refused and doubles nothing, and a fresh load shows the same proposal', async () => {
    const { ws, ctx, laterId } = await withLaterAccount();
    await dollarReceipt(ws);
    await importPayments(db, ctx, laterId, MARCH);
    const seen = await proposalsOf(ws.workspaceId);

    expect(await code(importPayments(db, ctx, laterId, MARCH))).toBe('file_already_imported');
    expect(await db.taxPayment.count({ where: { accountId: laterId } })).toBe(2);
    expect(await db.taxImportBatch.count({ where: { accountId: laterId } })).toBe(1);
    // Nothing lives in the page: what a reload shows is worked out from what is stored.
    expect(await proposalsOf(ws.workspaceId)).toEqual(seen);
  });

  it('re-entry after completion: accepting again links nothing twice, and a link taken back is proposed again', async () => {
    const { ws, ctx, laterId } = await withLaterAccount();
    const rowId = await dollarReceipt(ws);
    await importPayments(db, ctx, laterId, MARCH);
    const shown = pairs(await proposalsOf(ws.workspaceId));
    expect((await acceptEstimateProposals(db, ctx, 2025, shown, true)).linked.length).toBe(1);
    // The list an old page still shows: nothing of it is a proposal any more.
    expect(await acceptEstimateProposals(db, ctx, 2025, shown, true)).toEqual({ linked: [], skipped: 1 });
    expect(await db.taxPaymentLink.count({ where: { authWorkspaceId: ws.workspaceId } })).toBe(1);

    const link = (await loadStatement(db, ws.workspaceId, 2025)).payments.links[0];
    await unlinkPayment(db, ctx, link.linkId);
    const again = await loadStatement(db, ws.workspaceId, 2025);
    expect(again.payments.estimateProposals).toEqual([expect.objectContaining({ rowId, unambiguous: true })]);
    expect(again.items.find((i) => i.rowId === rowId)).toMatchObject({ amountCents: 2002, amountBasis: 'reference_rate' });
  });

  it('re-entry after failure: a refused file leaves nothing behind, and the next import starts clean', async () => {
    const { ctx, accountId, laterId } = await withLaterAccount();
    // One unreadable row rejects the whole file.
    expect(await code(importPayments(db, ctx, laterId, MARCH.replace('12.40', 'zwölf')))).toBe('unreadable_row:3');
    // A file of another kind is not a purchase list.
    expect(await code(importPayments(db, ctx, laterId, 'Datum;Betrag\n01.03.2025;5,00\n'))).toBe('unknown_layout:null');
    expect(await code(importPayments(db, ctx, laterId, LATER_HEADER + '\n'))).toBe('empty:null');
    expect(await db.taxImportBatch.count({ where: { accountId: laterId } })).toBe(0);
    expect(await db.taxPayment.count({ where: { accountId: laterId } })).toBe(0);

    expect(await importPayments(db, ctx, laterId, MARCH)).toMatchObject({ added: 2 });
    // A payment service's list holds other movements than a bank: a bank export into it is refused, and the list into a bank account.
    expect(await code(importPayments(db, ctx, laterId, JANUARY))).toBe('format_mismatch');
    await importPayments(db, ctx, accountId, JANUARY);
    expect(await code(importPayments(db, ctx, accountId, laterFile(later('2026-01-10', 'Laden Beispiel', '3.00', '4000000000009'))))).toBe('format_mismatch');
    expect(await db.taxPayment.count({ where: { accountId: laterId } })).toBe(2);
  });

  it('an ambiguous proposal is offered but never taken in bulk; taking one of them settles the other, and it is an accepted proposal', async () => {
    const { ws, ctx, laterId } = await withLaterAccount();
    const rowId = await dollarReceipt(ws);
    await importPayments(db, ctx, laterId, laterFile(later('2025-03-03', 'Editor Beispiel', '20.75', '6000000000001'), later('2025-03-05', 'Editor Beispiel', '19.90', '6000000000002')));
    const shown = await proposalsOf(ws.workspaceId);
    expect(shown.map((p) => [p.paidCents, p.unambiguous])).toEqual([[2075, false], [1990, false]]);
    // The bulk action links unambiguous ones only, whatever list it is sent.
    expect(await acceptEstimateProposals(db, ctx, 2025, pairs(shown), true)).toEqual({ linked: [], skipped: 2 });
    expect(await db.taxPaymentLink.count({ where: { authWorkspaceId: ws.workspaceId } })).toBe(0);

    // "Übernehmen" on one row: the same server path, for the one pair, recorded as an accepted proposal.
    expect((await acceptEstimateProposals(db, ctx, 2025, pairs([shown[0]]), false)).linked).toEqual([{ paymentId: shown[0].paymentId, rowId }]);
    const after = await loadStatement(db, ws.workspaceId, 2025);
    expect(after.payments.estimateProposals).toEqual([]);
    expect(after.payments.links[0]).toMatchObject({ method: 'estimate', cents: 2075 });
  });

  it('only what the person saw AND the server still proposes is linked: a made-up pair and a stale pair are left out and counted', async () => {
    const { ws, ctx, laterId } = await withLaterAccount();
    const rowId = await dollarReceipt(ws);
    const euroRow = await ws.addReceipt({ Name: 'Schreibwaren', Vendor: 'Schreibwaren Beispiel', Gross: 12.4, Date: '2025-03-10', Category: 'Bürobedarf', Zuordnung: 'Geschäftlich', Currency: 'EUR', 'FX Rate': 1 });
    await importPayments(db, ctx, laterId, MARCH);
    const [proposal] = await proposalsOf(ws.workspaceId);
    const stationery = await db.taxPayment.findFirstOrThrow({ where: { accountId: laterId, amountCents: -1240 } });
    // A pair the server never proposed (a euro receipt) cannot be pushed through the accept path.
    expect(await acceptEstimateProposals(db, ctx, 2025, [{ paymentId: stationery.id, rowId: euroRow }, { paymentId: proposal.paymentId, rowId }], false)).toEqual({
      linked: [{ paymentId: proposal.paymentId, rowId }],
      skipped: 1,
    });
    expect(await db.taxPaymentLink.count({ where: { authWorkspaceId: ws.workspaceId } })).toBe(1);
    // An empty or malformed list is an invalid request, not "everything".
    expect(await code(acceptEstimateProposals(db, ctx, 2025, [], true))).toBe('invalid_link');
    expect(await code(acceptEstimateProposals(db, ctx, 2025, 'alle', true))).toBe('invalid_link');
  });

  it('a second tab: the same proposal accepted twice at the same moment makes one link, and two payments for one receipt cannot both land', async () => {
    const { ws, ctx, laterId } = await withLaterAccount();
    const rowId = await dollarReceipt(ws);
    await importPayments(db, ctx, laterId, laterFile(later('2025-03-03', 'Editor Beispiel', '20.75', '6100000000001'), later('2025-03-05', 'Editor Beispiel', '19.90', '6100000000002')));
    const shown = await proposalsOf(ws.workspaceId);
    // Two tabs, each taking another of the two proposals for the one receipt.
    const results = await Promise.all(shown.map((p) => acceptEstimateProposals(db, ctx, 2025, pairs([p]), false)));
    expect(results.map((r) => r.linked.length).sort()).toEqual([0, 1]);
    expect(await db.taxPaymentLink.count({ where: { authWorkspaceId: ws.workspaceId, rowId } })).toBe(1);
    // And the write itself refuses a pair whose receipt was linked in between.
    const loser = shown.find((p) => !results.some((r) => r.linked.some((l) => l.paymentId === p.paymentId)))!;
    expect(await code(linkPayment(db, ctx, { paymentId: loser.paymentId, rowId }, rowCheck(ctx), 'estimate'))).toBe('proposal_gone');
  });

  it('a payment to a counterparty answered as private is not proposed, and a euro receipt gets no proposal', async () => {
    const { ws, ctx, laterId } = await withLaterAccount();
    await dollarReceipt(ws);
    await ws.addReceipt({ Name: 'Schreibwaren', Vendor: 'Schreibwaren Beispiel', Gross: 12.4, Date: '2025-03-10', Category: 'Bürobedarf', Zuordnung: 'Geschäftlich', Currency: 'EUR', 'FX Rate': 1 });
    await importPayments(db, ctx, laterId, MARCH);
    const shown = await proposalsOf(ws.workspaceId);
    expect(shown.length).toBe(1);
    await setCounterpartyTreatment(db, ctx, { counterparty: 'EDITOR BEISPIEL, AI TOOLS', treatment: 'private' });
    expect(await proposalsOf(ws.workspaceId)).toEqual([]);
    expect(await acceptEstimateProposals(db, ctx, 2025, pairs(shown), true)).toEqual({ linked: [], skipped: 1 });
  });
});

describe('what the production run showed', () => {
  it('a status wording nobody knows does not refuse the file: the row is read as a purchase and reported', async () => {
    const { ctx, laterId } = await withLaterAccount();
    const result = await importPayments(db, ctx, laterId, laterFile(later('2025-03-03', 'Laden Beispiel', '5.00', '4000000000008', 'Angefochten'), later('2025-03-04', 'Laden Beispiel', '6.00', '4000000000009', 'In 13 Tagen fällig')));
    expect(result).toMatchObject({ total: 2, added: 2, skipped: {}, notices: { unknown_status: 1 }, unknownStatuses: ['Angefochten'] });
  });

  it('accepting all in one go is one write: a second press at the same moment links nothing twice and both answers add up', async () => {
    const { ws, ctx, laterId } = await withLaterAccount();
    const rows = [await dollarReceipt(ws), await dollarReceipt(ws, { Name: 'Editor Beispiel April', Date: '2025-04-02' }), await dollarReceipt(ws, { Name: 'Editor Beispiel Mai', Date: '2025-05-02' })];
    await importPayments(db, ctx, laterId, laterFile(later('2025-03-03', 'Editor Beispiel', '20.75', '8000000000001'), later('2025-04-03', 'Editor Beispiel', '20.10', '8000000000002'), later('2025-05-03', 'Editor Beispiel', '19.80', '8000000000003')));
    const shown = pairs(await proposalsOf(ws.workspaceId));
    expect(shown.length).toBe(3);
    const [first, second] = await Promise.all([acceptEstimateProposals(db, ctx, 2025, shown, true), acceptEstimateProposals(db, ctx, 2025, shown, true)]);
    expect(first.linked.length + second.linked.length).toBe(3);
    expect(first.skipped + second.skipped).toBe(3);
    const links = await db.taxPaymentLink.findMany({ where: { authWorkspaceId: ws.workspaceId } });
    expect(links.map((l) => l.rowId).sort()).toEqual([...rows].sort());
    expect(new Set(links.map((l) => l.method))).toEqual(new Set(['estimate']));
    // And a third press, after the page was redrawn or not: nothing left to do.
    expect(await acceptEstimateProposals(db, ctx, 2025, shown, true)).toEqual({ linked: [], skipped: 3 });
  });

  it('one purchase that pays two receipts is offered for both as needing a hand, is never accepted in one click, and is split by hand', async () => {
    const { ws, ctx, laterId } = await withLaterAccount();
    // Two dollar invoices of one vendor, estimated at 10.01 and 9.10, charged together as 19.48.
    const a = await dollarReceipt(ws, { Name: 'Hosting Beispiel A', Vendor: 'Hosting Beispiel', Gross: 11 });
    const b = await dollarReceipt(ws, { Name: 'Hosting Beispiel B', Vendor: 'Hosting Beispiel', Gross: 10 });
    await importPayments(db, ctx, laterId, laterFile(later('2025-03-03', 'Hosting Beispiel', '19.48', '8100000000001')));
    const shown = await proposalsOf(ws.workspaceId);
    expect(shown.map((p) => [p.receiptLabel, p.unambiguous, p.severalReceipts]).sort()).toEqual([['Hosting Beispiel A', false, true], ['Hosting Beispiel B', false, true]]);
    // Neither the bulk action nor "Übernehmen" for one pair links it.
    expect(await acceptEstimateProposals(db, ctx, 2025, pairs(shown), true)).toEqual({ linked: [], skipped: 2 });
    expect(await acceptEstimateProposals(db, ctx, 2025, pairs([shown[0]]), false)).toEqual({ linked: [], skipped: 1 });
    // By hand, with a part of the amount for each.
    const paymentId = shown[0].paymentId;
    await linkPayment(db, ctx, { paymentId, rowId: a, cents: 1030 }, rowCheck(ctx));
    await linkPayment(db, ctx, { paymentId, rowId: b }, rowCheck(ctx));
    const view = await loadStatement(db, ws.workspaceId, 2025);
    expect(view.items.filter((i) => i.rowId === a || i.rowId === b).map((i) => i.amountCents).sort()).toEqual([1030, 918]);
    expect(view.payments.estimateProposals).toEqual([]);
  });

  it('a counterparty linked by hand to a vendor’s receipt stands for that vendor in later proposals, as long as the link exists', async () => {
    const { ws, ctx, laterId } = await withLaterAccount();
    // The invoice names the company, the list the product.
    const march = await dollarReceipt(ws, { Name: 'Rechnung März', Vendor: 'Beispiel Software Inc.' });
    const april = await dollarReceipt(ws, { Name: 'Rechnung April', Vendor: 'Beispiel Software Inc.', Date: '2025-04-02' });
    await importPayments(db, ctx, laterId, laterFile(later('2025-03-03', 'SCHREIBWERK', '20.75', '8200000000001'), later('2025-04-03', 'SCHREIBWERK', '20.10', '8200000000002')));
    expect(await proposalsOf(ws.workspaceId)).toEqual([]);

    const first = await db.taxPayment.findFirstOrThrow({ where: { accountId: laterId, amountCents: -2075 } });
    const { linkId } = await linkPayment(db, ctx, { paymentId: first.id, rowId: march }, rowCheck(ctx));
    // One link by hand, and the other invoice of that vendor is proposed.
    expect(await proposalsOf(ws.workspaceId)).toEqual([expect.objectContaining({ rowId: april, paidCents: 2010, counterparty: 'SCHREIBWERK', unambiguous: true })]);
    // Taking the link back takes the pairing back: nothing is stored beside the link.
    await unlinkPayment(db, ctx, linkId);
    expect(await proposalsOf(ws.workspaceId)).toEqual([]);
  });

  it('a bank debit without a counterparty whose text names the merchant of one wallet purchase is the bank’s part of it: a transfer, counted once', async () => {
    const { ws, ctx, accountId } = await workspace();
    // 19.99 bought through the wallet, 15.00 of it drawn from the bank; the bank names nobody, only the text does.
    await importPayments(db, ctx, accountId, file(line('2025-03-12', '', 'PP.4711.PP Laden Beispiel, Ihr Einkauf', '-15', 'Direct Debit')));
    const debit = await db.taxPayment.findFirstOrThrow({ where: { accountId } });
    const before = (await loadStatement(db, ws.workspaceId, 2025)).payments;
    // Without the wallet's list: a payment without a name, asked about on its own.
    expect(before.open.map((p) => p.id)).toEqual([debit.id]);
    const walletId = await createAccount(db, ctx, { label: 'Geldbörse', kind: 'payment_service' });
    await importPayments(db, ctx, walletId, WALLET_MARCH);
    const after = (await loadStatement(db, ws.workspaceId, 2025)).payments;
    expect(after.open.some((p) => p.id === debit.id)).toBe(false);
    expect(after.ruleTransfers.find((t) => t.id === debit.id)).toMatchObject({ amountCents: -1500, hasTwin: true });

    // Both ends linked to the receipt: the purchase counts, the bank's part of it does not count again.
    const rowId = await ws.addReceipt({ Name: 'Einkauf Laden', Vendor: 'Laden Beispiel', Gross: 19.99, Date: '2025-03-11', Category: 'Bürobedarf', Zuordnung: 'Geschäftlich', Currency: 'EUR', 'FX Rate': 1 });
    const purchase = await db.taxPayment.findFirstOrThrow({ where: { accountId: walletId, amountCents: -1999 } });
    await linkPayment(db, ctx, { paymentId: purchase.id, rowId }, rowCheck(ctx));
    await linkPayment(db, ctx, { paymentId: debit.id, rowId }, rowCheck(ctx));
    expect((await loadStatement(db, ws.workspaceId, 2025)).items.find((i) => i.rowId === rowId)).toMatchObject({ amountCents: 1999 });
  });
});

describe('the day a pay-later purchase counts on', () => {
  it('is its purchase day, whatever the service collects later and however it was paid: the method the 2025 return was filed on', async () => {
    const { ws, ctx, accountId, laterId } = await withLaterAccount();
    await importPayments(
      db,
      ctx,
      laterId,
      laterFile(
        later('2025-12-10', 'Laden Beispiel', '40.00', '6000000000001'),
        // A later purchase, so the list covers the day of the collection and the bank debit is a transfer.
        later('2026-02-03', 'Kiosk Beispiel', '3.00', '6000000000002'),
      ),
    );
    // The service collects the December purchase on 8 January.
    await importPayments(db, ctx, accountId, file(line('2026-01-08', 'Klarna Bank AB (publ)', 'Lastschrift', '-40', 'Direct Debit')));
    const rowId = await ws.addReceipt({ Name: 'Lampe', Vendor: 'Laden Beispiel', Gross: 40, Date: '2025-12-10', Category: 'Software & Lizenzen', Zuordnung: 'Geschäftlich', Currency: 'EUR', 'FX Rate': 1 });
    const purchase = await db.taxPayment.findFirstOrThrow({ where: { accountId: laterId, amountCents: -4_000 } });
    await linkPayment(db, ctx, { paymentId: purchase.id, rowId }, rowCheck(ctx));
    expect((await loadStatement(db, ws.workspaceId, 2025)).items.find((i) => i.rowId === rowId)).toMatchObject({ date: '2025-12-10', amountCents: 4_000 });
    expect((await loadStatement(db, ws.workspaceId, 2026)).items.find((i) => i.rowId === rowId)).toBeUndefined();
  });
});

describe('a purchase cancelled or refunded after it was imported', () => {
  const CANCELLED = laterFile(
    later('2025-03-03', 'EDITOR BEISPIEL, AI TOOLS', '20.75', '4000000000001', 'Storniert'),
    later('2025-03-10', 'Schreibwaren Beispiel', '12.40', '4000000000002'),
    later('2025-03-12', 'Hosting Beispiel', '5.00', '4000000000005'),
  );

  it('stops counting, its link is released with the receipt named, and the purchase is kept for the record', async () => {
    const { ws, ctx, laterId } = await withLaterAccount();
    const rowId = await dollarReceipt(ws);
    await importPayments(db, ctx, laterId, MARCH);
    await acceptAllShown(ctx);
    expect((await loadStatement(db, ws.workspaceId, 2025)).items.find((i) => i.rowId === rowId)).toMatchObject({ amountCents: 2075, amountBasis: 'payment' });

    const second = await importPayments(db, ctx, laterId, CANCELLED);
    expect(second).toMatchObject({ total: 2, added: 1, alreadyThere: 1, skipped: { cancelled: 1 }, cancelledEarlier: 1, releasedLinks: 1 });
    const view = await loadStatement(db, ws.workspaceId, 2025);
    // The receipt is back on its own estimate, nothing of the purchase counts, and the screen says which receipt lost its payment.
    expect(view.items.find((i) => i.rowId === rowId)).toMatchObject({ date: '2025-03-02', amountCents: 2002, amountBasis: 'reference_rate' });
    expect(view.payments.cancelled).toEqual([expect.objectContaining({ bookingDay: '2025-03-03', amountCents: -2075, accountLabel: 'Später zahlen', releasedFrom: ['Editor Beispiel März'] })]);
    expect(view.payments.links).toEqual([]);
    expect(view.payments.yearCount).toBe(2);
    expect(view.payments.unclassified.map((c) => c.label)).not.toContain('EDITOR BEISPIEL, AI TOOLS');
    // A cancelled purchase is no candidate for the receipt and cannot be linked.
    expect(view.payments.estimateProposals).toEqual([]);
    const cancelled = await db.taxPayment.findFirstOrThrow({ where: { accountId: laterId, amountCents: -2075 } });
    expect(await code(linkPayment(db, ctx, { paymentId: cancelled.id, rowId }, rowCheck(ctx)))).toBe('invalid_link');
    // Kept: the row and its link are still stored.
    expect(await db.taxPaymentLink.count({ where: { paymentId: cancelled.id } })).toBe(1);
  });

  it('undoing the import that reported the cancellation restores the purchase and its link', async () => {
    const { ws, ctx, laterId } = await withLaterAccount();
    const rowId = await dollarReceipt(ws);
    await importPayments(db, ctx, laterId, MARCH);
    await acceptAllShown(ctx);
    const second = await importPayments(db, ctx, laterId, CANCELLED);
    await deleteImportBatch(db, ctx, second.batchId);
    const view = await loadStatement(db, ws.workspaceId, 2025);
    expect(view.payments.cancelled).toEqual([]);
    expect(view.items.find((i) => i.rowId === rowId)).toMatchObject({ date: '2025-03-03', amountCents: 2075, amountBasis: 'payment' });
    expect(view.payments.links).toEqual([expect.objectContaining({ targetLabel: 'Editor Beispiel März', method: 'estimate' })]);
    // Re-entry: the same report again cancels it again, once.
    expect(await importPayments(db, ctx, laterId, CANCELLED)).toMatchObject({ cancelledEarlier: 1 });
    expect(await importPayments(db, ctx, laterId, CANCELLED + '\n')).toMatchObject({ cancelledEarlier: 0 });
  });

  it('a cancellation of a purchase that was never imported cancels nothing', async () => {
    const { ctx, laterId } = await withLaterAccount();
    expect(await importPayments(db, ctx, laterId, CANCELLED)).toMatchObject({ total: 2, added: 2, cancelledEarlier: 0, releasedLinks: 0 });
  });
});

describe('a purchase first listed without the service’s number', () => {
  const WEB = laterFile(later('2025-03-03', 'EDITOR BEISPIEL, AI TOOLS', '20.75', ''), later('2025-03-10', 'Schreibwaren Beispiel', '12.40', '4000000000002'));

  it('is recognized when a later file gives it one: stored once, its link kept', async () => {
    const { ws, ctx, laterId } = await withLaterAccount();
    const rowId = await dollarReceipt(ws);
    await importPayments(db, ctx, laterId, WEB);
    await acceptAllShown(ctx);
    const before = await db.taxPayment.findFirstOrThrow({ where: { accountId: laterId, amountCents: -2075 } });

    expect(await importPayments(db, ctx, laterId, MARCH)).toMatchObject({ total: 2, added: 0, alreadyThere: 2, adopted: 1 });
    const after = await db.taxPayment.findMany({ where: { accountId: laterId, amountCents: -2075 } });
    expect(after.map((p) => [p.id, p.entryReference])).toEqual([[before.id, '4000000000001']]);
    expect((await loadStatement(db, ws.workspaceId, 2025)).items.find((i) => i.rowId === rowId)).toMatchObject({ amountCents: 2075, amountBasis: 'payment' });
    // From now on it is known by its number: the file again changes nothing.
    expect(await importPayments(db, ctx, laterId, MARCH + '\n')).toMatchObject({ added: 0, adopted: 0 });
  });

  it('money back is never taken for the same movement: two refunds of one day, amount and merchant both stay', async () => {
    const { ctx, laterId } = await withLaterAccount();
    await importPayments(db, ctx, laterId, laterFile(later('2025-03-03', 'Laden Beispiel', '-5.00', '4100000000001')));
    expect(await importPayments(db, ctx, laterId, laterFile(later('2025-03-03', 'Laden Beispiel', '-5.00', '4100000000002')))).toMatchObject({ added: 1, adopted: 0 });
    const stored = await db.taxPayment.findMany({ where: { accountId: laterId }, orderBy: { entryReference: 'asc' } });
    expect(stored.map((p) => [p.entryReference, p.amountCents, p.sourceKind])).toEqual([['4100000000001', 500, 'refund'], ['4100000000002', 500, 'refund']]);
  });

  it('two stored purchases that both fit are not guessed at: the numbered one is added', async () => {
    const { ctx, laterId } = await withLaterAccount();
    await importPayments(db, ctx, laterId, laterFile(later('2025-03-03', 'Kiosk Beispiel', '2.00', ''), later('2025-03-03', 'Kiosk Beispiel', '2.00', '')));
    expect(await importPayments(db, ctx, laterId, laterFile(later('2025-03-03', 'Kiosk Beispiel', '2.00', '4000000000007')))).toMatchObject({ added: 1, adopted: 0 });
    expect(await db.taxPayment.count({ where: { accountId: laterId } })).toBe(3);
  });
});

describe('money that only funds another payment account', () => {
  const BANK = file(
    line('2024-11-12', 'PayPal Europe S.a.r.l. et Cie S.C.A', 'Ihr Einkauf bei Altladen Beispiel', '-30', 'Direct Debit'),
    line('2025-03-12', 'PayPal Europe S.a.r.l. et Cie S.C.A', 'Ihr Einkauf bei Laden Beispiel', '-19.99', 'Direct Debit'),
    line('2025-03-14', 'PayPal Europe S.a.r.l. et Cie S.C.A', 'Auszahlung', '50', 'Credit Transfer'),
    line('2025-03-18', 'PayPal Europe S.a.r.l. et Cie S.C.A', 'Gutschrift', '7.49', 'Credit Transfer'),
    line('2025-03-15', 'Werkzeug Beispiel GmbH', 'Bestellung 4712', '-40', 'Presentment'),
    line('2025-03-20', 'Klarna Bank AB (publ)', 'Erstattung Schreibwaren', '12.40', 'Credit Transfer'),
    line('2025-03-28', 'Klarna Bank AB (publ)', 'Sammelabrechnung März', '-36.15', 'Direct Debit'),
    line('2025-04-28', 'Klarna Bank AB (publ)', 'Sammelabrechnung April', '-9', 'Direct Debit'),
  );

  async function bankAskedAbout() {
    const base = await workspace();
    await importPayments(db, base.ctx, base.accountId, BANK);
    // The state the defect left behind: both services answered as business, so their debits wait for a document.
    for (const counterparty of ['Klarna Bank AB (publ)', 'PayPal Europe S.a.r.l. et Cie S.C.A', 'Werkzeug Beispiel GmbH']) {
      await setCounterpartyTreatment(db, base.ctx, { counterparty, treatment: 'business' });
    }
    return base;
  }
  const openNames = async (workspaceId: string, year = 2025) => (await loadStatement(db, workspaceId, year)).payments.open.map((p) => `${p.counterparty.split(' ')[0]} ${p.amountCents}`).sort();
  async function bothLists() {
    const base = await bankAskedAbout();
    const laterId = await createAccount(db, base.ctx, { label: 'Später zahlen', kind: 'payment_service' });
    const walletId = await createAccount(db, base.ctx, { label: 'Geldbörse', kind: 'payment_service' });
    await importPayments(db, base.ctx, laterId, MARCH_WHOLE);
    await importPayments(db, base.ctx, walletId, WALLET_MARCH);
    return { ...base, laterId, walletId };
  }

  it('before the service’s own list is imported its debit on the bank is the only record and keeps asking', async () => {
    const { ws } = await bankAskedAbout();
    expect(await openNames(ws.workspaceId)).toEqual(['Klarna -3615', 'Klarna -900', 'Klarna 1240', 'PayPal -1999', 'PayPal 5000', 'PayPal 749', 'Werkzeug -4000']);
    const view = await loadStatement(db, ws.workspaceId, 2025);
    expect(view.payments).toMatchObject({ transferCount: 0, ruleTransfers: [], reconciliations: [] });
  });

  it('the rule holds only on days the list covers: a debit before or after them stays a payment that asks', async () => {
    const { ws } = await bothLists();
    // Both lists cover 1 to 31 March 2025. The PayPal debit of November 2024 and the collection of April 2025 are the only record of that money.
    expect(await openNames(ws.workspaceId, 2024)).toEqual(['PayPal -3000']);
    expect(await openNames(ws.workspaceId)).toEqual(['Klarna -900', 'Klarna 1240', 'PayPal 749', 'Werkzeug -4000']);
    const view = await loadStatement(db, ws.workspaceId, 2025);
    expect(view.payments.ruleTransfers.map((t) => [t.bookingDay, t.amountCents, t.accountLabel, t.hasTwin])).toEqual([
      ['2025-03-28', -3615, 'Geschäftskonto', false],
      ['2025-03-14', 5000, 'Geschäftskonto', false],
      // The wallet's own row for the same 50.00: the other end of that transfer, not a purchase without a name.
      ['2025-03-13', -5000, 'Geldbörse', false],
      ['2025-03-12', -1999, 'Geschäftskonto', true],
    ]);
    expect(view.payments.ruleTransferCents).toBe(3615 + 1999 - 5000 + 5000);
    expect((await loadStatement(db, ws.workspaceId, 2024)).payments.ruleTransfers).toEqual([]);
    // Never an expense: nothing counts for the year without a receipt.
    expect(view.businessExpenseCents).toBe(0);
  });

  it('money coming in: from the wallet a transfer only when its list shows that money leaving; from the pay-later service money back that asks for its receipt', async () => {
    const { ws, ctx, accountId } = await bothLists();
    const view = await loadStatement(db, ws.workspaceId, 2025);
    const back = view.payments.open.find((p) => p.amountCents === 1240)!;
    expect(back).toMatchObject({ counterparty: 'Klarna Bank AB (publ)', kind: 'refund', check: 'refund_without_receipt' });
    expect(view.payments.open.some((p) => p.amountCents === 5000)).toBe(false);
    // 7.49 from the wallet with nothing in its list to explain it: not assumed to be a payout, asked about as money received.
    expect(view.payments.open.find((p) => p.amountCents === 749)).toMatchObject({ kind: 'income', check: 'income_without_invoice' });

    // It asks even when nobody ever said what the service is; the counterparty question then counts only the
    // collection of April, which lies outside the covered days.
    await setCounterpartyTreatment(db, ctx, { counterparty: 'Klarna Bank AB (publ)', treatment: null });
    const unanswered = await loadStatement(db, ws.workspaceId, 2025);
    expect(unanswered.payments.open.some((p) => p.id === back.id)).toBe(true);
    expect(unanswered.payments.unclassified.find((c) => c.label === 'Klarna Bank AB (publ)')).toMatchObject({ count: 1, outCents: 900, inCents: 0 });

    // Linked to the receipt of the purchase it refunds, it is taken off what the receipt cost.
    const rowId = await ws.addReceipt({ Name: 'Schreibwaren', Vendor: 'Schreibwaren Beispiel', Gross: 12.4, Date: '2025-03-10', Category: 'Bürobedarf', Zuordnung: 'Geschäftlich', Currency: 'EUR', 'FX Rate': 1 });
    const purchase = await db.taxPayment.findFirstOrThrow({ where: { authWorkspaceId: ws.workspaceId, amountCents: -1240 } });
    await linkPayment(db, ctx, { paymentId: purchase.id, rowId }, rowCheck(ctx));
    await linkPayment(db, ctx, { paymentId: back.id, rowId }, rowCheck(ctx));
    expect((await loadStatement(db, ws.workspaceId, 2025)).items.find((i) => i.rowId === rowId)).toMatchObject({ amountCents: 0 });
    expect(await db.taxPayment.count({ where: { accountId } })).toBe(8);
  });

  it('through the screen: a transfer the rule made can be turned into a payment of its own and back, and the reverse', async () => {
    const { ws, ctx } = await bothLists();
    const view = await loadStatement(db, ws.workspaceId, 2025);
    const debit = view.payments.ruleTransfers.find((t) => t.amountCents === -3615)!;

    // "Kein Übertrag, eine eigene Zahlung": the id comes from the list the screen shows.
    await setPaymentTransfer(db, ctx, debit.id, false);
    const purchase = await loadStatement(db, ws.workspaceId, 2025);
    expect(purchase.payments.ruleTransfers.some((t) => t.id === debit.id)).toBe(false);
    expect(purchase.payments.open.find((p) => p.id === debit.id)).toMatchObject({ kind: 'spend', check: 'payment_without_document', namesService: true });
    expect(purchase.payments.overridden).toEqual([expect.objectContaining({ id: debit.id, kind: 'spend' })]);

    // "Zurücksetzen" in the list of re-labelled payments: the rule applies again.
    await setPaymentKind(db, ctx, debit.id, null);
    expect((await loadStatement(db, ws.workspaceId, 2025)).payments.ruleTransfers.some((t) => t.id === debit.id)).toBe(true);

    // The reverse: the collection of April lies outside the covered days and asks; "Übertrag zwischen eigenen Konten" on the open payment settles it.
    const april = purchase.payments.open.find((p) => p.amountCents === -900)!;
    expect(april.namesService).toBe(true);
    await setPaymentTransfer(db, ctx, april.id, true);
    const settled = await loadStatement(db, ws.workspaceId, 2025);
    expect(settled.payments.open.some((p) => p.id === april.id)).toBe(false);
    expect(settled.payments.overridden).toEqual([expect.objectContaining({ id: april.id, kind: 'own_transfer' })]);
    // A payment that names no service is not offered that button.
    expect(settled.payments.open.find((p) => p.counterparty.startsWith('Werkzeug'))?.namesService).toBe(false);
    expect(await code(setPaymentTransfer(db, ctx, april.id, 'ja'))).toBe('invalid_kind');
    expect(await code(setPaymentTransfer(db, otherCtx, april.id, true))).toBe('payment_not_found');
  });

  it('what the rule hides is set against the service’s own list, month by month, and a difference is called out', async () => {
    const { ws, ctx, accountId } = await bothLists();
    const view = await loadStatement(db, ws.workspaceId, 2025);
    const later = view.payments.reconciliations.find((r) => r.service === 'klarna')!;
    // Listed in March: 1.00 + 20.75 + 12.40 + 2.00 = 36.15, and 36.15 was collected.
    expect(later).toMatchObject({ serviceKind: 'pay_later', accountLabels: ['Später zahlen'], collectedCents: 3615, listedCents: 3615, differenceCents: 0, reconciles: true });
    expect(later.months).toEqual([{ month: '2025-03', collectedCents: 3615, listedCents: 3615, differenceCents: 0, runningCents: 0 }]);
    // The wallet: 22.99 listed, 19.99 collected from the bank. Three euro were paid from balance or a card, which is
    // shown and is no alarm: for a wallet only MORE collected than listed is money the rule hides without an explanation.
    expect(view.payments.reconciliations.find((r) => r.service === 'paypal')).toMatchObject({ collectedCents: 1999, listedCents: 2299, differenceCents: -300, reconciles: true, toleranceCents: 100 });
    await importPayments(db, ctx, accountId, file(line('2025-03-20', 'PayPal Europe S.a.r.l. et Cie S.C.A', 'Ihr Einkauf bei Gastshop Beispiel', '-45', 'Direct Debit')));
    expect((await loadStatement(db, ws.workspaceId, 2025)).payments.reconciliations.find((r) => r.service === 'paypal')).toMatchObject({ collectedCents: 6499, listedCents: 2299, differenceCents: 4200, reconciles: false });

    // A late fee debited on its own within the covered days is hidden by the rule, and shows up as money the list does not explain.
    await importPayments(db, ctx, accountId, file(line('2025-03-29', 'Klarna Bank AB (publ)', 'Mahngebühr', '-4.50', 'Direct Debit')));
    const withFee = (await loadStatement(db, ws.workspaceId, 2025)).payments;
    expect(withFee.reconciliations.find((r) => r.service === 'klarna')).toMatchObject({ collectedCents: 4065, listedCents: 3615, differenceCents: 450, reconciles: false });
    // The person says which debit it is; the rest then reconciles again.
    const fee = withFee.ruleTransfers.find((t) => t.amountCents === -450)!;
    await setPaymentTransfer(db, ctx, fee.id, false);
    expect((await loadStatement(db, ws.workspaceId, 2025)).payments.reconciliations.find((r) => r.service === 'klarna')).toMatchObject({ differenceCents: 0, reconciles: true });
  });

  it('a pay-later collection in January that pays December purchases is carried over, not reported as a gap', async () => {
    const { ws, ctx, accountId } = await workspace();
    const laterId = await createAccount(db, ctx, { label: 'Später zahlen', kind: 'payment_service' });
    await importPayments(db, ctx, laterId, laterFile(
      later('2025-11-20', 'Kiosk Beispiel', '10.00', '5000000000001'),
      later('2025-12-18', 'Schreibwaren Beispiel', '30.00', '5000000000002'),
      later('2025-12-28', 'Werkstatt Beispiel', '70.00', '5000000000003'),
      later('2026-01-05', 'Kiosk Beispiel', '20.00', '5000000000004'),
      later('2026-01-30', 'Kiosk Beispiel', '5.00', '5000000000005'),
    ));
    await importPayments(db, ctx, accountId, file(
      line('2025-11-25', 'Klarna Bank AB (publ)', 'Sammelzahlung', '-10', 'Direct Debit'),
      // December's purchases are collected in January, together with January's own.
      line('2026-01-10', 'Klarna Bank AB (publ)', 'Sammelzahlung', '-120', 'Direct Debit'),
      line('2026-01-30', 'Klarna Bank AB (publ)', 'Sammelzahlung', '-5', 'Direct Debit'),
    ));
    const year2026 = (await loadStatement(db, ws.workspaceId, 2026)).payments.reconciliations.find((r) => r.service === 'klarna')!;
    expect(year2026).toMatchObject({ collectedCents: 12_500, listedCents: 2500, carriedCents: 10_000, differenceCents: 0, reconciles: true });
    expect(year2026.months).toEqual([{ month: '2026-01', collectedCents: 12_500, listedCents: 2500, differenceCents: 10_000, runningCents: 0 }]);
    // The year before collected less, by purchases of its last days the next year collects: no gap there either.
    expect((await loadStatement(db, ws.workspaceId, 2025)).payments.reconciliations.find((r) => r.service === 'klarna')).toMatchObject({ collectedCents: 1000, listedCents: 11_000, carriedCents: 0, notDueCents: 11_000, differenceCents: -10_000, reconciles: true });
    // The newest purchases of the list are not due yet: collected less by up to them is no gap.
    await importPayments(db, ctx, laterId, laterFile(later('2026-02-10', 'Werkstatt Beispiel', '40.00', '5000000000006')));
    expect((await loadStatement(db, ws.workspaceId, 2026)).payments.reconciliations.find((r) => r.service === 'klarna')).toMatchObject({ listedCents: 6500, notDueCents: 16_500, differenceCents: -4000, reconciles: true });

    // A fee within the covered days counts as collected ...
    await importPayments(db, ctx, accountId, file(line('2026-01-20', 'Klarna Bank AB (publ)', 'Mahngebühr', '-25', 'Direct Debit')));
    expect((await loadStatement(db, ws.workspaceId, 2026)).payments.reconciliations.find((r) => r.service === 'klarna')).toMatchObject({ carriedCents: 10_000, differenceCents: -1500, reconciles: true });
    // ... but more collected than the earlier years and the list explain is still called out.
    await importPayments(db, ctx, accountId, file(line('2026-01-21', 'Klarna Bank AB (publ)', 'Mahngebühr', '-80', 'Direct Debit')));
    expect((await loadStatement(db, ws.workspaceId, 2026)).payments.reconciliations.find((r) => r.service === 'klarna')).toMatchObject({ carriedCents: 10_000, differenceCents: 6500, reconciles: false });
  });

  it('carries over only purchases of the last 60 days of earlier years: one never collected stays a question in its own year', async () => {
    const { ws, ctx, accountId } = await workspace();
    const laterId = await createAccount(db, ctx, { label: 'Später zahlen', kind: 'payment_service' });
    await importPayments(db, ctx, laterId, laterFile(
      // Returned before it was collected, say: the list keeps it, the bank never collects it.
      later('2025-08-05', 'Kiosk Beispiel', '40.00', '5100000000001'),
      later('2025-12-20', 'Schreibwaren Beispiel', '30.00', '5100000000002'),
      later('2026-01-05', 'Kiosk Beispiel', '20.00', '5100000000003'),
    ));
    await importPayments(db, ctx, accountId, file(
      line('2025-08-20', 'Klarna Bank AB (publ)', 'Sammelzahlung', '-10', 'Direct Debit'),
      line('2026-01-04', 'Klarna Bank AB (publ)', 'Sammelzahlung', '-50', 'Direct Debit'),
    ));
    const year2026 = (await loadStatement(db, ws.workspaceId, 2026)).payments.reconciliations.find((r) => r.service === 'klarna')!;
    expect(year2026).toMatchObject({ collectedCents: 5000, listedCents: 2000, carriedCents: 3000, differenceCents: 0, reconciles: true });
  });

  it('leaves a collection that waits for the next list out of what was collected, and names it', async () => {
    const { ws, ctx, accountId } = await workspace();
    const laterId = await createAccount(db, ctx, { label: 'Später zahlen', kind: 'payment_service' });
    await importPayments(db, ctx, laterId, laterFile(later('2026-09-01', 'Kiosk Beispiel', '20.00', '5200000000001'), later('2026-09-28', 'Laden Beispiel', '30.00', '5200000000002')));
    await importPayments(db, ctx, accountId, file(
      line('2026-09-28', 'Klarna Bank AB (publ)', 'Sammelzahlung', '-50', 'Direct Debit'),
      // After the end of the list, and beyond what it still holds open: it waits.
      line('2026-10-23', 'Klarna Bank AB (publ)', 'Sammelzahlung', '-1261.69', 'Direct Debit'),
    ));
    const view = (await loadStatement(db, ws.workspaceId, 2026)).payments;
    expect(view.reconciliations.find((r) => r.service === 'klarna')).toMatchObject({ collectedCents: 5000, listedCents: 5000, awaitingCents: 126_169, differenceCents: 0, reconciles: true });
    expect(view.ruleTransfers.find((t) => t.amountCents === -126_169)).toMatchObject({ awaitingList: true });
  });

  it('a wallet purchase on the pay-later card is a transfer only when the wallet’s list holds that purchase', async () => {
    const { ws, ctx } = await workspace();
    const laterId = await createAccount(db, ctx, { label: 'Später zahlen', kind: 'payment_service' });
    const walletId = await createAccount(db, ctx, { label: 'Geldbörse', kind: 'payment_service' });
    await importPayments(db, ctx, laterId, laterFile(
      later('2025-03-11', 'PAYPAL *LADENBEISPIEL', '19.99', '7000000000001'),
      // A guest checkout: the wallet's list does not hold it.
      later('2025-03-12', 'PAYPAL *GASTSHOP', '45.00', '7000000000002'),
      // The same amount as a listed purchase, but a month away from it.
      later('2025-03-30', 'PAYPAL *KIOSK', '1.00', '7000000000003'),
    ));
    // Without the wallet's own list every row is the only record of its purchase.
    expect((await loadStatement(db, ws.workspaceId, 2025)).payments.transferCount).toBe(0);
    await importPayments(db, ctx, walletId, WALLET_MARCH);
    const view = await loadStatement(db, ws.workspaceId, 2025);
    expect(view.payments.ruleTransfers.map((t) => [t.counterparty, t.hasTwin])).toEqual([['PAYPAL *LADENBEISPIEL', true]]);
    expect(view.payments.unclassified.map((c) => c.label)).toEqual(expect.arrayContaining(['PAYPAL *GASTSHOP', 'PAYPAL *KIOSK']));
  });

  it('a wallet purchase on the pay-later card still counts as a purchase the pay-later service collects from the bank', async () => {
    const base = await bankAskedAbout();
    const laterId = await createAccount(db, base.ctx, { label: 'Später zahlen', kind: 'payment_service' });
    const walletId = await createAccount(db, base.ctx, { label: 'Geldbörse', kind: 'payment_service' });
    // Same 36.15 the bank collected, but one purchase (19.99) was a wallet purchase charged to the pay-later card.
    await importPayments(db, base.ctx, laterId, laterFile(
      later('2025-03-01', 'Kiosk Beispiel', '1.00', '4000000000000'),
      later('2025-03-10', 'Schreibwaren Beispiel', '13.16', '4000000000002'),
      later('2025-03-11', 'PAYPAL *LADENBEISPIEL', '19.99', '7000000000001'),
      later('2025-03-31', 'Kiosk Beispiel', '2.00', '4000000000003'),
    ));
    await importPayments(db, base.ctx, walletId, WALLET_MARCH);
    const view = await loadStatement(db, base.ws.workspaceId, 2025);
    expect(view.payments.ruleTransfers.map((t) => t.counterparty)).toContain('PAYPAL *LADENBEISPIEL');
    expect(view.payments.reconciliations.find((r) => r.service === 'klarna')).toMatchObject({ collectedCents: 3615, listedCents: 3615, differenceCents: 0, reconciles: true });
  });

  it('change an earlier input: undoing the list’s import makes the bank debit ask again', async () => {
    const { ws, ctx } = await bankAskedAbout();
    const laterId = await createAccount(db, ctx, { label: 'Später zahlen', kind: 'payment_service' });
    const batch = await importPayments(db, ctx, laterId, MARCH_WHOLE);
    expect(await openNames(ws.workspaceId)).not.toContain('Klarna -3615');
    await deleteImportBatch(db, ctx, batch.batchId);
    expect(await openNames(ws.workspaceId)).toContain('Klarna -3615');
  });

  it('what a person said about one payment stands above the rule', async () => {
    const { ws, ctx } = await bothLists();
    const debit = (await loadStatement(db, ws.workspaceId, 2025)).payments.ruleTransfers.find((t) => t.amountCents === -3615)!;
    await setPaymentKind(db, ctx, debit.id, 'private');
    const view = await loadStatement(db, ws.workspaceId, 2025);
    expect(view.payments.overridden).toEqual([expect.objectContaining({ id: debit.id, kind: 'private' })]);
    expect(view.payments.ruleTransfers.some((t) => t.id === debit.id)).toBe(false);
  });
});

describe('a private account and the funding rule', () => {
  it('a transfer stays a transfer on an account said to be private, and so does a counterparty answered own account', async () => {
    const { ws, ctx, accountId } = await workspace();
    const laterId = await createAccount(db, ctx, { label: 'Später zahlen', kind: 'payment_service' });
    await importPayments(db, ctx, accountId, file(
      line('2025-03-28', 'Klarna Bank AB (publ)', 'Sammelabrechnung März', '-36.15', 'Direct Debit'),
      line('2025-03-29', 'Tagesgeld Beispiel', 'Übertrag', '-500', 'Debit Transfer'),
      line('2025-03-30', 'Laden Beispiel', 'Einkauf', '-12', 'Presentment'),
    ));
    await importPayments(db, ctx, laterId, MARCH_WHOLE);
    await setCounterpartyTreatment(db, ctx, { counterparty: 'Tagesgeld Beispiel', treatment: 'own_account' });
    await setAccountPrivate(db, ctx, accountId, true);
    const own = (await loadPayments(db, ws.workspaceId)).payments.filter((p) => p.accountId === accountId);
    const kindOf = (counterparty: string) => own.find((p) => p.counterparty.startsWith(counterparty));
    expect(kindOf('Klarna')).toMatchObject({ kind: 'own_transfer', byRule: true, byPrivateAccount: false });
    expect(kindOf('Tagesgeld')).toMatchObject({ kind: 'own_transfer', byPrivateAccount: false });
    expect(kindOf('Laden')).toMatchObject({ kind: 'private', byPrivateAccount: true });
  });
});

describe('the same money never counts twice on a receipt', () => {
  const BANK = file(line('2025-03-12', 'PayPal Europe S.a.r.l. et Cie S.C.A', 'Ihr Einkauf bei Laden Beispiel', '-19.99', 'Direct Debit'), line('2025-03-15', 'Werkzeug Beispiel GmbH', 'Bestellung 4712', '-40', 'Presentment'));
  async function linkedOnTheBankSide() {
    const base = await workspace();
    await importPayments(db, base.ctx, base.accountId, BANK);
    const rowId = await base.ws.addReceipt({ Name: 'Einkauf Laden', Vendor: 'Laden Beispiel', Gross: 19.99, Date: '2025-03-11', Category: 'Bürobedarf', Zuordnung: 'Geschäftlich', Currency: 'EUR', 'FX Rate': 1 });
    const debit = await db.taxPayment.findFirstOrThrow({ where: { accountId: base.accountId, amountCents: -1999 } });
    // Linked by hand on the bank side, as on production before the wallet's list counted.
    const { linkId } = await linkPayment(db, base.ctx, { paymentId: debit.id, rowId }, rowCheck(base.ctx));
    const stored = await db.taxPayment.findMany({ where: { accountId: base.accountId }, orderBy: { sourceHash: 'asc' } });
    const walletId = await createAccount(db, base.ctx, { label: 'Geldbörse', kind: 'payment_service' });
    await importPayments(db, base.ctx, walletId, WALLET_MARCH);
    const purchase = await db.taxPayment.findFirstOrThrow({ where: { accountId: walletId, amountCents: -1999 } });
    return { ...base, rowId, debit, linkId, stored, purchase };
  }

  it('nothing stored is rewritten: a link made by hand on a debit that is now a transfer stays and keeps counting', async () => {
    const { ws, ctx, accountId, rowId, linkId, stored } = await linkedOnTheBankSide();
    expect(await db.taxPayment.findMany({ where: { accountId }, orderBy: { sourceHash: 'asc' } })).toEqual(stored);
    const view = await loadStatement(db, ws.workspaceId, 2025);
    expect(view.payments.links.find((l) => l.linkId === linkId)).toMatchObject({ targetLabel: 'Einkauf Laden', cents: 1999, method: 'manual', counts: true });
    // A linked payment is in no other list, so the list of transfers says what this one is linked to.
    expect(view.payments.ruleTransfers.find((t) => t.amountCents === -1999)).toMatchObject({ hasTwin: true, linkedTo: ['Einkauf Laden'] });
    expect(view.items.find((i) => i.rowId === rowId)).toMatchObject({ date: '2025-03-12', amountCents: 1999, amountBasis: 'payment' });
    // The picker for linking by hand says the receipt already carries a payment.
    expect(view.payments.receiptTargets.find((r) => r.id === rowId)).toMatchObject({ linkedCents: 1999 });
    await unlinkPayment(db, ctx, linkId);
    expect((await loadStatement(db, ws.workspaceId, 2025)).payments.links).toEqual([]);
  });

  it('linking the purchase itself moves the link over from the debit that funds it, and says so', async () => {
    const { ws, ctx, rowId, debit, purchase } = await linkedOnTheBankSide();
    const result = await linkPayment(db, ctx, { paymentId: purchase.id, rowId }, rowCheck(ctx));
    expect(result.movedFromPaymentId).toBe(debit.id);
    const view = await loadStatement(db, ws.workspaceId, 2025);
    expect(view.payments.links.map((l) => [l.paymentId, l.cents, l.counts])).toEqual([[purchase.id, 1999, true]]);
    expect(view.items.find((i) => i.rowId === rowId)).toMatchObject({ date: '2025-03-11', amountCents: 1999, amountBasis: 'payment' });
  });

  it('both sides linked to one receipt count once: the debit’s link is shown as not counting', async () => {
    const { ws, ctx, rowId, debit, purchase, linkId } = await linkedOnTheBankSide();
    // Another payment sits on the receipt as well, so the debit's link is not simply moved.
    const tool = await db.taxPayment.findFirstOrThrow({ where: { authWorkspaceId: ws.workspaceId, amountCents: -4000 } });
    expect(await code(linkPayment(db, ctx, { paymentId: tool.id, rowId, cents: 500 }, rowCheck(ctx)))).toBe('receipt_already_paid');
    await linkPayment(db, ctx, { paymentId: tool.id, rowId, cents: 500, confirmed: true }, rowCheck(ctx));
    // The purchase the debit funds: the same money, so it adds nothing and is not asked about.
    expect((await linkPayment(db, ctx, { paymentId: purchase.id, rowId }, rowCheck(ctx))).movedFromPaymentId).toBeNull();
    const view = await loadStatement(db, ws.workspaceId, 2025);
    expect(view.payments.links.find((l) => l.linkId === linkId)).toMatchObject({ paymentId: debit.id, counts: false });
    expect(view.items.find((i) => i.rowId === rowId)).toMatchObject({ amountCents: 1999 + 500 });
    expect(view.payments.receiptTargets.find((r) => r.id === rowId)).toMatchObject({ linkedCents: 2499 });
  });

  it('a second payment that takes a receipt beyond its own amount is asked about, with what is already on it, and lands on a yes', async () => {
    const { ws, ctx, rowId } = await linkedOnTheBankSide();
    const tool = await db.taxPayment.findFirstOrThrow({ where: { authWorkspaceId: ws.workspaceId, amountCents: -4000 } });
    const refused = await linkPayment(db, ctx, { paymentId: tool.id, rowId }, rowCheck(ctx)).catch((e) => e);
    expect(refused).toMatchObject({ code: 'receipt_already_paid', detail: '1999:1999' });
    expect(await db.taxPaymentLink.count({ where: { authWorkspaceId: ws.workspaceId, rowId } })).toBe(1);
    await linkPayment(db, ctx, { paymentId: tool.id, rowId, confirmed: true }, rowCheck(ctx));
    expect((await loadStatement(db, ws.workspaceId, 2025)).items.find((i) => i.rowId === rowId)).toMatchObject({ amountCents: 5999 });
  });

  it('several payments that stay within the receipt’s amount are not asked about: a bill paid in parts', async () => {
    const { ws, ctx, accountId } = await workspace();
    await importPayments(db, ctx, accountId, file(line('2025-05-02', 'Vermieter Beispiel', 'Rate 1', '-50', 'Debit Transfer'), line('2025-06-02', 'Vermieter Beispiel', 'Rate 2', '-50', 'Debit Transfer'), line('2025-07-02', 'Vermieter Beispiel', 'Rate 3', '-9', 'Debit Transfer')));
    const rowId = await ws.addReceipt({ Name: 'Gerät auf Raten', Vendor: 'Vermieter Beispiel', Gross: 100, Date: '2025-05-01', Category: 'Bürobedarf', Zuordnung: 'Geschäftlich', Currency: 'EUR', 'FX Rate': 1 });
    const parts = await db.taxPayment.findMany({ where: { accountId }, orderBy: { bookingDay: 'asc' } });
    await linkPayment(db, ctx, { paymentId: parts[0].id, rowId }, rowCheck(ctx));
    await linkPayment(db, ctx, { paymentId: parts[1].id, rowId }, rowCheck(ctx));
    // 109 of 100: beyond the tolerance of 8 percent, so this one is asked about.
    expect(await code(linkPayment(db, ctx, { paymentId: parts[2].id, rowId }, rowCheck(ctx)))).toBe('receipt_already_paid');
    expect((await loadStatement(db, ws.workspaceId, 2025)).items.find((i) => i.rowId === rowId)).toMatchObject({ amountCents: 10_000 });
  });
});

describe('a receipt is looked up in its own workspace’s table', () => {
  it('finds the workspace’s receipt, and neither another workspace’s row nor a row that does not exist', async () => {
    const { ws } = await workspace();
    const rowId = await dollarReceipt(ws);
    const foreign = await dollarReceipt(other);
    expect(await isWorkspaceReceipt(db, ws.workspaceId, rowId)).toBe(true);
    expect(await isWorkspaceReceipt(db, ws.workspaceId, foreign)).toBe(false);
    expect(await isWorkspaceReceipt(db, ws.workspaceId, '00000000-0000-4000-8000-000000000000')).toBe(false);
  });
});

describe('workspace isolation', () => {
  it('accounts, payments, rules and links of another workspace do not exist here', async () => {
    const { ws, ctx } = await workspace();
    const foreignAccount = await createAccount(db, otherCtx, { label: 'Fremdes Konto', kind: 'bank' });
    const { batchId } = await importPayments(db, otherCtx, foreignAccount, JANUARY);
    await setCounterpartyTreatment(db, otherCtx, { counterparty: 'Werkzeug Beispiel GmbH', treatment: 'business' });
    const foreignPayment = (await db.taxPayment.findFirst({ where: { accountId: foreignAccount, amountCents: -10_850 } }))!;
    const foreignRow = await other.addReceipt({ Name: 'Fremd', Vendor: 'Werkzeug Beispiel GmbH', Gross: 108.5, Date: '2026-01-03', Currency: 'EUR', 'FX Rate': 1 });
    const { linkId: foreignLink } = await linkPayment(db, otherCtx, { paymentId: foreignPayment.id, rowId: foreignRow }, rowCheck(otherCtx));

    const mine = await loadStatement(db, ws.workspaceId, 2026);
    expect(mine.payments).toMatchObject({ yearCount: 0, unclassified: [], open: [], links: [], treatments: [] });
    expect(mine.payments.accounts.map((a) => a.label)).toEqual(['Geschäftskonto']);

    expect(await code(importPayments(db, ctx, foreignAccount, JANUARY))).toBe('account_not_found');
    expect(await code(deleteImportBatch(db, ctx, batchId))).toBe('batch_not_found');
    expect(await code(setPaymentKind(db, ctx, foreignPayment.id, 'refund'))).toBe('payment_not_found');
    expect(await code(unlinkPayment(db, ctx, foreignLink))).toBe('link_not_found');
    const ownRow = await ws.addReceipt({ Name: 'Eigen', Vendor: 'x', Gross: 1, Date: '2026-01-03', Currency: 'EUR', 'FX Rate': 1 });
    expect(await code(linkPayment(db, ctx, { paymentId: foreignPayment.id, rowId: ownRow }, rowCheck(ctx)))).toBe('payment_not_found');
    // A payment of this workspace cannot be linked to another workspace's receipt.
    const ownAccount = (await db.taxAccount.findFirst({ where: { authWorkspaceId: ws.workspaceId } }))!;
    await importPayments(db, ctx, ownAccount.id, JANUARY);
    const ownPayment = (await db.taxPayment.findFirst({ where: { accountId: ownAccount.id } }))!;
    expect(await code(linkPayment(db, ctx, { paymentId: ownPayment.id, rowId: foreignRow }, rowCheck(ctx)))).toBe('target_not_found');
    // The same label may exist in two workspaces.
    await createAccount(db, otherCtx, { label: 'Geschäftskonto 2', kind: 'bank' });
  });
});

describe('the tab asks less after a real import: money in, a private account, a mixed counterparty, linking without an answer', () => {
  const openOf = async (workspaceId: string) => (await loadStatement(db, workspaceId, 2026)).payments.open.map((o) => `${o.counterparty} ${o.check}`).sort();
  const unanswered = async (workspaceId: string) => (await loadStatement(db, workspaceId, 2026)).payments.unclassified.map((c) => `${c.label} ${c.count}`).sort();

  it('money in from an unanswered counterparty is asked about once, in the counterparty question, unless it names an invoice', async () => {
    const { ws, ctx, accountId } = await workspace();
    await importPayments(db, ctx, accountId, file(
      line('2026-02-02', 'Freundin Beispiel', 'Pizza', '12', 'Credit Transfer'),
      line('2026-02-03', 'Kunde Beispiel', 'Rechnung R-2026-007 Teilzahlung', '400', 'Credit Transfer'),
    ));
    // No invoice yet: both are only in the counterparty question.
    expect(await openOf(ws.workspaceId)).toEqual([]);
    expect(await unanswered(ws.workspaceId)).toEqual(['Freundin Beispiel 1', 'Kunde Beispiel 1']);
    // An invoice whose number is in the text: that payment is offered for it right away, the other still waits for the answer.
    const invoiceId = await saveInvoice(db, ctx, null, { number: 'R-2026-007', issueDate: '2026-01-20', grossCents: 100_000, treatment: 'small_business', payments: [] });
    const view = await loadStatement(db, ws.workspaceId, 2026);
    expect(view.payments.open.map((o) => [o.counterparty, o.proposals.map((x) => [x.targetId, x.strength])])).toEqual([['Kunde Beispiel', [[invoiceId, 'reference_amount_differs']]]]);
    // Answered private: never asked, even with an invoice number in the text.
    await setCounterpartyTreatment(db, ctx, { counterparty: 'Kunde Beispiel', treatment: 'private' });
    expect(await openOf(ws.workspaceId)).toEqual([]);
    // Answered business: asked about, as before.
    await setCounterpartyTreatment(db, ctx, { counterparty: 'Freundin Beispiel', treatment: 'business' });
    expect(await openOf(ws.workspaceId)).toEqual(['Freundin Beispiel income_without_invoice']);
  });

  describe('a whole account said to be private', () => {
    const PRIVATE_FILE = file(
      line('2026-02-02', 'Supermarkt Beispiel', 'Einkauf', '-45.1'),
      line('2026-02-05', 'Arbeitgeber Beispiel', 'Gehalt', '2500', 'Credit Transfer'),
      line('2026-02-09', '', 'Kartenzahlung', '-9.99'),
    );

    it('forward: none of its payments is asked about, money in included; the payments stay and say why they are private', async () => {
      const { ws, ctx, accountId } = await workspace();
      const privateAccount = await createAccount(db, ctx, { label: 'Privatkonto', kind: 'bank' });
      await importPayments(db, ctx, accountId, JANUARY);
      await importPayments(db, ctx, privateAccount, PRIVATE_FILE);
      expect(await unanswered(ws.workspaceId)).toEqual(['Arbeitgeber Beispiel 1', 'Kundin Beispiel 1', 'Supermarkt Beispiel 1', 'Vermieter Beispiel 1', 'Werkzeug Beispiel GmbH 1']);
      expect(await openOf(ws.workspaceId)).toEqual([' payment_without_document']);

      await setAccountPrivate(db, ctx, privateAccount, true);
      const view = await loadStatement(db, ws.workspaceId, 2026);
      // The business account's questions are untouched.
      expect(view.payments.unclassified.map((c) => c.label).sort()).toEqual(['Kundin Beispiel', 'Vermieter Beispiel', 'Werkzeug Beispiel GmbH']);
      expect(view.payments.open).toEqual([]);
      expect(view.payments.accounts.find((a) => a.id === privateAccount)).toMatchObject({ isPrivate: true, paymentCount: 3 });
      expect(view.payments.yearCount).toBe(6);
      // The read interface says private, and why.
      const loaded = await loadPayments(db, ws.workspaceId);
      const own = loaded.payments.filter((p) => p.accountId === privateAccount);
      expect(own.map((p) => [p.kind, p.byPrivateAccount, p.sourceKind]).sort()).toEqual([
        ['private', true, 'income'],
        ['private', true, 'spend'],
        ['private', true, 'spend'],
      ]);
    });

    it('change an earlier input: taking it back asks everything again exactly as before; saying it again hides it again', async () => {
      const { ws, ctx } = await workspace();
      const privateAccount = await createAccount(db, ctx, { label: 'Privatkonto', kind: 'bank' });
      await importPayments(db, ctx, privateAccount, PRIVATE_FILE);
      const before = [await unanswered(ws.workspaceId), await openOf(ws.workspaceId)];
      await setAccountPrivate(db, ctx, privateAccount, true);
      expect(await unanswered(ws.workspaceId)).toEqual([]);
      await setAccountPrivate(db, ctx, privateAccount, false);
      expect([await unanswered(ws.workspaceId), await openOf(ws.workspaceId)]).toEqual(before);
      // Saying the same twice changes nothing.
      await setAccountPrivate(db, ctx, privateAccount, true);
      await setAccountPrivate(db, ctx, privateAccount, true);
      expect(await unanswered(ws.workspaceId)).toEqual([]);
    });

    it('resume and re-entry: a fresh load shows the same, and a later import into the account is private too', async () => {
      const { ws, ctx } = await workspace();
      const privateAccount = await createAccount(db, ctx, { label: 'Privatkonto', kind: 'bank' });
      await setAccountPrivate(db, ctx, privateAccount, true);
      const { batchId } = await importPayments(db, ctx, privateAccount, PRIVATE_FILE);
      expect(await unanswered(ws.workspaceId)).toEqual([]);
      expect((await db.taxAccount.findUnique({ where: { id: privateAccount } }))?.isPrivate).toBe(true);
      // Undoing and repeating the import keeps the account's answer.
      await deleteImportBatch(db, ctx, batchId);
      await importPayments(db, ctx, privateAccount, PRIVATE_FILE);
      expect(await openOf(ws.workspaceId)).toEqual([]);
      expect((await loadPayments(db, ws.workspaceId)).payments.every((p) => p.kind === 'private')).toBe(true);
    });

    it('a business expense paid from it is found and linked by hand and counts for its receipt; a person’s word on one payment stands above the account', async () => {
      const { ws, ctx } = await workspace();
      const privateAccount = await createAccount(db, ctx, { label: 'Privatkonto', kind: 'bank' });
      await importPayments(db, ctx, privateAccount, PRIVATE_FILE);
      await setAccountPrivate(db, ctx, privateAccount, true);
      const rowId = await ws.addReceipt({ Name: 'Druckerpapier', Vendor: 'Supermarkt Beispiel', Gross: 45.1, Date: '2026-02-02', Category: 'Bürobedarf', Zuordnung: 'Geschäftlich', Currency: 'EUR', 'FX Rate': 1 });
      const { payments, total } = await findPayments(db, ws.workspaceId, { year: 2026, text: '45,10' });
      expect(total).toBe(1);
      expect(payments[0]).toMatchObject({ counterparty: 'Supermarkt Beispiel', kind: 'private', target: 'receipt', freeCents: 4_510, accountLabel: 'Privatkonto' });
      await linkPayment(db, ctx, { paymentId: payments[0].id, rowId }, rowCheck(ctx));
      const view = await loadStatement(db, ws.workspaceId, 2026);
      expect(view.items.find((i) => i.rowId === rowId)).toMatchObject({ amountCents: 4_510, amountBasis: 'payment', date: '2026-02-02' });
      // Linked in full: no longer found.
      expect((await findPayments(db, ws.workspaceId, { year: 2026, text: '45,10' })).total).toBe(0);
      // Money in on the account still goes to an invoice when it is one.
      expect((await findPayments(db, ws.workspaceId, { year: 2026, text: 'Gehalt' })).payments[0]).toMatchObject({ target: 'invoice', kind: 'private' });
      // A single payment re-labelled by a person is that, whatever the account says.
      const card = (await findPayments(db, ws.workspaceId, { year: 2026, text: 'Kartenzahlung' })).payments[0];
      await setPaymentKind(db, ctx, card.id, 'spend');
      expect((await loadPayments(db, ws.workspaceId)).payments.find((p) => p.id === card.id)).toMatchObject({ kind: 'spend', byPrivateAccount: false });
      expect(await openOf(ws.workspaceId)).toEqual([' payment_without_document']);
    });

    it('a counterparty answered business stands above the private account: a business expense paid privately is asked about and proposed', async () => {
      const { ws, ctx } = await workspace();
      const privateAccount = await createAccount(db, ctx, { label: 'Privatkonto', kind: 'bank' });
      await importPayments(db, ctx, privateAccount, PRIVATE_FILE);
      await setAccountPrivate(db, ctx, privateAccount, true);
      const rowId = await ws.addReceipt({ Name: 'Druckerpapier', Vendor: 'Supermarkt Beispiel', Gross: 45.1, Date: '2026-02-01', Category: 'Bürobedarf', Zuordnung: 'Geschäftlich', Currency: 'EUR', 'FX Rate': 1 });
      expect(await openOf(ws.workspaceId)).toEqual([]);
      await setCounterpartyTreatment(db, ctx, { counterparty: 'Supermarkt Beispiel', treatment: 'business' });
      const open = (await loadStatement(db, ws.workspaceId, 2026)).payments.open;
      expect(open.map((o) => [o.counterparty, o.check, o.proposals.map((x) => x.targetId)])).toEqual([['Supermarkt Beispiel', 'payment_without_document', [rowId]]]);
      // The other payments of the account stay private.
      expect((await loadPayments(db, ws.workspaceId)).payments.filter((p) => p.kind === 'private').length).toBe(2);
    });

    it('a fee or a transfer the file names on it is not found for linking; its money in that the file calls income goes to an invoice', async () => {
      const { ws, ctx } = await workspace();
      const privateAccount = await createAccount(db, ctx, { label: 'Privatkonto', kind: 'bank' });
      await importPayments(db, ctx, privateAccount, PRIVATE_FILE);
      await setAccountPrivate(db, ctx, privateAccount, true);
      const card = (await findPayments(db, ws.workspaceId, { year: 2026, text: 'Kartenzahlung' })).payments[0];
      await setPaymentKind(db, ctx, card.id, 'fee');
      expect((await findPayments(db, ws.workspaceId, { year: 2026, text: 'Kartenzahlung' })).total).toBe(0);
      await setPaymentKind(db, ctx, card.id, 'own_transfer');
      expect((await findPayments(db, ws.workspaceId, { year: 2026, text: 'Kartenzahlung' })).total).toBe(0);
      // Decided: money in on a private account that its file calls income can still pay an invoice.
      expect((await findPayments(db, ws.workspaceId, { year: 2026, text: 'Gehalt' })).payments[0]).toMatchObject({ target: 'invoice' });
    });

    it('is refused for another workspace’s account and for anything but yes or no', async () => {
      const { ctx, accountId } = await workspace();
      const foreign = await createAccount(db, otherCtx, { label: `Fremd ${Date.now()}`, kind: 'bank' });
      expect(await code(setAccountPrivate(db, ctx, foreign, true))).toBe('account_not_found');
      expect(await code(setAccountPrivate(db, ctx, accountId, 'yes'))).toBe('invalid_private');
      expect((await db.taxAccount.findUnique({ where: { id: foreign } }))?.isPrivate).toBe(false);
    });
  });

  describe('a counterparty that is partly business and partly private (mixed)', () => {
    const SHOP_FILE = file(
      line('2026-03-02', 'Versand Beispiel', 'Bestellung A', '-49.99'),
      line('2026-03-09', 'Versand Beispiel', 'Bestellung B', '-19.5'),
      line('2026-03-15', 'Versand Beispiel', 'Bestellung C', '-7'),
    );

    it('forward: answered mixed nothing is asked; one payment linked by hand is business, the others stay unasked', async () => {
      const { ws, ctx, accountId } = await workspace();
      await importPayments(db, ctx, accountId, SHOP_FILE);
      expect(await unanswered(ws.workspaceId)).toEqual(['Versand Beispiel 3']);
      await setCounterpartyTreatment(db, ctx, { counterparty: 'Versand Beispiel', treatment: 'mixed' });
      expect(await unanswered(ws.workspaceId)).toEqual([]);
      expect(await openOf(ws.workspaceId)).toEqual([]);
      const rowId = await ws.addReceipt({ Name: 'Monitorkabel', Vendor: 'Versand Beispiel', Gross: 19.5, Date: '2026-03-08', Category: 'Bürobedarf', Zuordnung: 'Geschäftlich', Currency: 'EUR', 'FX Rate': 1 });
      const key = (await loadPayments(db, ws.workspaceId)).payments[0].counterpartyKey;
      const found = await findPayments(db, ws.workspaceId, { year: 2026, counterpartyKey: key });
      expect(found.payments.map((p) => p.reference)).toEqual(['Bestellung A', 'Bestellung B', 'Bestellung C']);
      await linkPayment(db, ctx, { paymentId: found.payments[1].id, rowId }, rowCheck(ctx));
      const view = await loadStatement(db, ws.workspaceId, 2026);
      expect(view.items.find((i) => i.rowId === rowId)).toMatchObject({ amountBasis: 'payment', date: '2026-03-09' });
      expect(view.payments.open).toEqual([]);
      expect((await findPayments(db, ws.workspaceId, { year: 2026, counterpartyKey: key })).payments.map((p) => p.reference)).toEqual(['Bestellung A', 'Bestellung C']);
    });

    it('linking a payment of an unanswered counterparty answers nothing: the others keep their single question', async () => {
      const { ws, ctx, accountId } = await workspace();
      await importPayments(db, ctx, accountId, SHOP_FILE);
      const rowId = await ws.addReceipt({ Name: 'Monitorkabel', Vendor: 'Versand Beispiel', Gross: 19.5, Date: '2026-03-08', Category: 'Bürobedarf', Zuordnung: 'Geschäftlich', Currency: 'EUR', 'FX Rate': 1 });
      const key = (await loadPayments(db, ws.workspaceId)).payments[0].counterpartyKey;
      const b = (await findPayments(db, ws.workspaceId, { year: 2026, counterpartyKey: key })).payments[1];
      await linkPayment(db, ctx, { paymentId: b.id, rowId }, rowCheck(ctx));
      expect(await unanswered(ws.workspaceId)).toEqual(['Versand Beispiel 2']);
      expect(await openOf(ws.workspaceId)).toEqual([]);
      expect(await db.taxCounterpartyRule.count({ where: { authWorkspaceId: ws.workspaceId } })).toBe(0);
    });

    it('resume and re-entry: a fresh load shows the same, and a later import of the counterparty asks nothing either', async () => {
      const { ws, ctx, accountId } = await workspace();
      await importPayments(db, ctx, accountId, SHOP_FILE);
      await setCounterpartyTreatment(db, ctx, { counterparty: 'Versand Beispiel', treatment: 'mixed' });
      expect((await loadStatement(db, ws.workspaceId, 2026)).payments.treatments.map((t) => t.treatment)).toEqual(['mixed']);
      await importPayments(db, ctx, accountId, file(line('2026-04-01', 'Versand Beispiel', 'Bestellung D', '-15')));
      expect(await unanswered(ws.workspaceId)).toEqual([]);
      expect(await openOf(ws.workspaceId)).toEqual([]);
      expect((await findPayments(db, ws.workspaceId, { year: 2026, text: 'Versand' })).total).toBe(4);
    });

    it('money in from a mixed counterparty that pays an invoice is still offered for that invoice', async () => {
      const { ws, ctx, accountId } = await workspace();
      const invoiceId = await saveInvoice(db, ctx, null, { number: 'R-2026-031', issueDate: '2026-03-01', grossCents: 8_000, treatment: 'small_business', payments: [] });
      await importPayments(db, ctx, accountId, file(
        line('2026-03-10', 'Versand Beispiel', 'Auszahlung Rechnung R-2026-031', '76.5', 'Credit Transfer'),
        line('2026-03-11', 'Versand Beispiel', 'Gutschrift Rücksendung', '15', 'Credit Transfer'),
      ));
      // The marketplace kept a fee, so it is no exact match and was not linked on import.
      await setCounterpartyTreatment(db, ctx, { counterparty: 'Versand Beispiel', treatment: 'mixed' });
      const open = (await loadStatement(db, ws.workspaceId, 2026)).payments.open;
      expect(open.map((o) => [o.reference, o.proposals.map((x) => [x.targetId, x.strength])])).toEqual([['Auszahlung Rechnung R-2026-031', [[invoiceId, 'reference_amount_differs']]]]);
    });

    it('change an earlier input: taking the mixed answer back asks once again for what is not linked; answering business asks per payment', async () => {
      const { ws, ctx, accountId } = await workspace();
      await importPayments(db, ctx, accountId, SHOP_FILE);
      await setCounterpartyTreatment(db, ctx, { counterparty: 'Versand Beispiel', treatment: 'mixed' });
      const rowId = await ws.addReceipt({ Name: 'Monitorkabel', Vendor: 'Versand Beispiel', Gross: 19.5, Date: '2026-03-08', Category: 'Bürobedarf', Zuordnung: 'Geschäftlich', Currency: 'EUR', 'FX Rate': 1 });
      const b = (await findPayments(db, ws.workspaceId, { year: 2026, text: 'Bestellung B' })).payments[0];
      await linkPayment(db, ctx, { paymentId: b.id, rowId }, rowCheck(ctx));
      await setCounterpartyTreatment(db, ctx, { counterparty: 'Versand Beispiel', treatment: null });
      expect(await unanswered(ws.workspaceId)).toEqual(['Versand Beispiel 2']);
      await setCounterpartyTreatment(db, ctx, { counterparty: 'Versand Beispiel', treatment: 'business' });
      expect(await openOf(ws.workspaceId)).toEqual(['Versand Beispiel payment_without_document', 'Versand Beispiel payment_without_document']);
      // The link made under "mixed" stays through every answer.
      expect((await loadStatement(db, ws.workspaceId, 2026)).payments.links.map((l) => l.rowId)).toEqual([rowId]);
    });
  });

  it('finding payments: only this workspace and this year, only what still has something to link, and a search needs two characters', async () => {
    const { ws, ctx, accountId } = await workspace();
    await importPayments(db, ctx, accountId, file(
      line('2025-12-30', 'Werkzeug Beispiel GmbH', 'Bestellung 4700', '-108.5'),
      line('2026-01-05', 'Werkzeug Beispiel GmbH', 'Bestellung 4711', '-108.5'),
    ));
    const foreign = await createAccount(db, otherCtx, { label: `Fremd ${Date.now()}`, kind: 'bank' });
    await importPayments(db, otherCtx, foreign, JANUARY);
    expect((await findPayments(db, ws.workspaceId, { year: 2026, text: 'werkzeug' })).payments.map((p) => p.reference)).toEqual(['Bestellung 4711']);
    expect((await findPayments(db, ws.workspaceId, { year: 2025, text: '108,50' })).payments.map((p) => p.reference)).toEqual(['Bestellung 4700']);
    expect(await findPayments(db, ws.workspaceId, { year: 2026, text: 'w' })).toEqual({ payments: [], total: 0 });
    expect((await findPayments(db, ws.workspaceId, { year: 2026, text: 'Miete' })).total).toBe(0);
    expect(await code(findPayments(db, ws.workspaceId, { text: 'werkzeug' }))).toBe('invalid_query');
    // An empty counterparty is no search for every payment without a name.
    expect(await findPayments(db, ws.workspaceId, { year: 2026, counterpartyKey: '' })).toEqual({ payments: [], total: 0 });
    // Partly linked: what is left is found, with what is left.
    const rowId = await ws.addReceipt({ Name: 'Teil', Vendor: 'Werkzeug Beispiel GmbH', Gross: 50, Date: '2026-01-03', Category: 'Bürobedarf', Currency: 'EUR', 'FX Rate': 1 });
    const payment = (await findPayments(db, ws.workspaceId, { year: 2026, text: '4711' })).payments[0];
    await linkPayment(db, ctx, { paymentId: payment.id, rowId, cents: 5_000 }, rowCheck(ctx));
    expect((await findPayments(db, ws.workspaceId, { year: 2026, text: '4711' })).payments[0]).toMatchObject({ freeCents: 5_850 });
  });

  it('finding payments: an amount is found however it is written, and fees, transfers and money in that is no income are left out', async () => {
    const { ws, ctx, accountId } = await workspace();
    await importPayments(db, ctx, accountId, file(
      line('2026-05-02', 'Möbel Beispiel', 'Schreibtisch', '-1234.56'),
      line('2026-05-03', 'Tagesgeld Beispiel', 'Übertrag', '-500', 'Debit Transfer'),
      line('2026-05-04', 'Tagesgeld Beispiel', 'Rückübertrag', '200', 'Credit Transfer'),
      line('2026-05-05', 'Kundin Beispiel', 'Zahlung', '45.1', 'Credit Transfer'),
    ));
    for (const q of ['1.234,56', '1234,56', '1234.56', '1,234.56', '1 234,56 €']) {
      expect((await findPayments(db, ws.workspaceId, { year: 2026, text: q })).payments.map((p) => p.counterparty), q).toEqual(['Möbel Beispiel']);
    }
    expect((await findPayments(db, ws.workspaceId, { year: 2026, text: '45.10' })).payments.map((p) => [p.counterparty, p.target])).toEqual([['Kundin Beispiel', 'invoice']]);
    await setCounterpartyTreatment(db, ctx, { counterparty: 'Tagesgeld Beispiel', treatment: 'own_account' });
    expect((await findPayments(db, ws.workspaceId, { year: 2026, text: 'Tagesgeld' })).total).toBe(0);
    // Money in re-labelled private is no income and no money back: nothing to link it to.
    const customer = (await findPayments(db, ws.workspaceId, { year: 2026, text: 'Kundin' })).payments[0];
    await setPaymentKind(db, ctx, customer.id, 'private');
    expect((await findPayments(db, ws.workspaceId, { year: 2026, text: 'Kundin' })).total).toBe(0);
    // Re-labelled as money back it goes on a receipt.
    await setPaymentKind(db, ctx, customer.id, 'refund');
    expect((await findPayments(db, ws.workspaceId, { year: 2026, text: 'Kundin' })).payments[0]).toMatchObject({ target: 'receipt' });
    // A fee is never found.
    const desk = (await findPayments(db, ws.workspaceId, { year: 2026, text: 'Schreibtisch' })).payments[0];
    await setPaymentKind(db, ctx, desk.id, 'fee');
    expect((await findPayments(db, ws.workspaceId, { year: 2026, text: 'Schreibtisch' })).total).toBe(0);
  });
});

describe('an import limited to a year, and an account continued from a second source: forward, change an earlier input, resume, re-entry', () => {
  // A bank export of the first half of 2025, and the bank interface's list that runs from late 2024 into 2026.
  const EXPORT = file(
    line('2025-01-10', 'Werkzeug Beispiel GmbH', 'Bestellung 1', '-10'),
    line('2025-06-30', 'Werkzeug Beispiel GmbH', 'Bestellung 2', '-20'),
  );
  const interfaceList = (rows: Array<[string, string, string]>) =>
    JSON.stringify({
      transactions: rows.map(([day, name, amount], i) => ({
        entry_reference: `e-${day}-${i}`,
        booking_date: day,
        value_date: day,
        transaction_amount: { amount: amount.replace('-', ''), currency: 'EUR' },
        credit_debit_indicator: amount.startsWith('-') ? 'DBIT' : 'CRDT',
        status: 'BOOK',
        creditor: amount.startsWith('-') ? { name } : null,
        debtor: amount.startsWith('-') ? null : { name },
        remittance_information: [`Zahlung ${i}`],
      })),
    });
  const LIST = interfaceList([
    ['2024-12-20', 'Werkzeug Beispiel GmbH', '-5'],
    ['2025-06-30', 'Werkzeug Beispiel GmbH', '-20'],
    ['2025-07-02', 'Werkzeug Beispiel GmbH', '-30'],
    ['2025-12-31', 'Werkzeug Beispiel GmbH', '-40'],
    ['2026-01-02', 'Werkzeug Beispiel GmbH', '-50'],
  ]);
  const days = async (accountId: string) => (await db.taxPayment.findMany({ where: { accountId }, orderBy: { bookingDay: 'asc' } })).map((p) => `${p.bookingDay} ${p.amountCents}`);

  it('forward: limited to 2025, the list continues the export from its last day on and leaves the other years out, all counted', async () => {
    const { ctx, accountId } = await workspace();
    await importPayments(db, ctx, accountId, EXPORT);
    const result = await importPayments(db, ctx, accountId, LIST, { onlyYear: 2025 });
    expect(result).toMatchObject({ format: 'enable_banking_json', onlyYear: 2025, total: 2, added: 2, skipped: { other_year: 2, covered_by_other_source: 1 }, firstDay: '2025-07-02', lastDay: '2025-12-31' });
    expect(await days(accountId)).toEqual(['2025-01-10 -1000', '2025-06-30 -2000', '2025-07-02 -3000', '2025-12-31 -4000']);
  });

  it('change an earlier input: the whole list after the year-limited one adds only the other years; undoing it takes only those back', async () => {
    const { ctx, accountId } = await workspace();
    await importPayments(db, ctx, accountId, EXPORT);
    await importPayments(db, ctx, accountId, LIST, { onlyYear: 2025 });
    const whole = await importPayments(db, ctx, accountId, LIST);
    // 2025 is there already from the same source; 30 June is still the export's day.
    expect(whole).toMatchObject({ onlyYear: null, added: 2, alreadyThere: 2, skipped: { covered_by_other_source: 1 } });
    expect(await days(accountId)).toEqual(['2024-12-20 -500', '2025-01-10 -1000', '2025-06-30 -2000', '2025-07-02 -3000', '2025-12-31 -4000', '2026-01-02 -5000']);
    await deleteImportBatch(db, ctx, whole.batchId);
    expect(await days(accountId)).toEqual(['2025-01-10 -1000', '2025-06-30 -2000', '2025-07-02 -3000', '2025-12-31 -4000']);
  });

  it('change an earlier input: the export cannot be undone while the list that continued it is there; undone in order, the list fills the freed days', async () => {
    const { ctx, accountId } = await workspace();
    const exported = await importPayments(db, ctx, accountId, EXPORT);
    const listed = await importPayments(db, ctx, accountId, LIST, { onlyYear: 2025 });
    // The list left out the export's days: undoing the export alone would leave them empty.
    expect(await code(deleteImportBatch(db, ctx, exported.batchId))).toBe('batch_has_later_source');
    await deleteImportBatch(db, ctx, listed.batchId);
    await deleteImportBatch(db, ctx, exported.batchId);
    expect(await importPayments(db, ctx, accountId, LIST, { onlyYear: 2025 })).toMatchObject({ added: 3, skipped: { other_year: 2 } });
    expect(await days(accountId)).toEqual(['2025-06-30 -2000', '2025-07-02 -3000', '2025-12-31 -4000']);
  });

  it('a later export of the first source fills its own days, also those the other source’s range spans', async () => {
    const { ctx, accountId } = await workspace();
    await importPayments(db, ctx, accountId, EXPORT);
    // The whole list keeps late 2024 and the second half of 2025: its range spans the export's days but does not hold them.
    await importPayments(db, ctx, accountId, LIST);
    const more = file(line('2025-03-03', 'Werkzeug Beispiel GmbH', 'Bestellung 3', '-15'), line('2025-08-01', 'Werkzeug Beispiel GmbH', 'Bestellung 4', '-99'));
    expect(await importPayments(db, ctx, accountId, more)).toMatchObject({ added: 1, skipped: { covered_by_other_source: 1 } });
    expect(await days(accountId)).toContain('2025-03-03 -1500');
    expect(await days(accountId)).not.toContain('2025-08-01 -9900');
  });

  it('two sources imported into one account at the same moment store every day once', async () => {
    const { ctx, accountId } = await workspace();
    const results = await Promise.allSettled([importPayments(db, ctx, accountId, EXPORT), importPayments(db, ctx, accountId, LIST, { onlyYear: 2025 })]);
    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
    // 30 June is in both files; whichever came first holds it, and it is stored once.
    expect((await days(accountId)).filter((d) => d.startsWith('2025-06-30'))).toEqual(['2025-06-30 -2000']);
    expect(await db.taxPayment.count({ where: { accountId } })).toBe(4);
  });

  it('resume: the same file for the same year is refused, for another year it is a new import; nothing is doubled', async () => {
    const { ctx, accountId } = await workspace();
    await importPayments(db, ctx, accountId, LIST, { onlyYear: 2025 });
    expect(await code(importPayments(db, ctx, accountId, LIST, { onlyYear: 2025 }))).toBe('file_already_imported');
    expect(await importPayments(db, ctx, accountId, LIST, { onlyYear: 2026 })).toMatchObject({ added: 1, skipped: { other_year: 4 } });
    expect(await db.taxPayment.count({ where: { accountId } })).toBe(4);
  });

  it('re-entry after failure: a year with nothing in it and a year that makes no sense write nothing, and the next import starts clean', async () => {
    const { ctx, accountId } = await workspace();
    expect(await code(importPayments(db, ctx, accountId, LIST, { onlyYear: 2023 }))).toBe('nothing_in_year');
    expect(await code(importPayments(db, ctx, accountId, LIST, { onlyYear: 25 }))).toBe('invalid_import_year');
    expect(await code(importPayments(db, ctx, accountId, LIST, { onlyYear: 2025.5 }))).toBe('invalid_import_year');
    expect(await db.taxImportBatch.count({ where: { accountId } })).toBe(0);
    // A file wholly on days another source covers is refused the same way.
    await importPayments(db, ctx, accountId, EXPORT);
    expect(await code(importPayments(db, ctx, accountId, interfaceList([['2025-03-01', 'Laden Beispiel', '-3']])))).toBe('nothing_uncovered');
    expect(await importPayments(db, ctx, accountId, LIST)).toMatchObject({ added: 4 });
    // A year of a file already read whole brings nothing new: refused, no empty import.
    expect(await code(importPayments(db, ctx, accountId, LIST, { onlyYear: 2026 }))).toBe('nothing_new');
    expect(await db.taxImportBatch.count({ where: { accountId } })).toBe(2);
  });

  it('a pay-later list limited to a year still applies its cancellations of other years, and the import that made them is not undone under a later one', async () => {
    const { ctx, laterId } = await withLaterAccount();
    await importPayments(db, ctx, laterId, laterFile(later('2024-12-10', 'Laden Beispiel', '30.00', '4000000000101'), later('2025-02-01', 'Kiosk Beispiel', '2.00', '4000000000102')));
    // The 2025 part of the next list: one purchase of 2025 and the 2024 one now cancelled.
    const next = laterFile(later('2024-12-10', 'Laden Beispiel', '30.00', '4000000000101', 'Storniert'), later('2025-03-01', 'Kiosk Beispiel', '4.00', '4000000000103'));
    const year = await importPayments(db, ctx, laterId, next, { onlyYear: 2025 });
    expect(year).toMatchObject({ added: 1, cancelledEarlier: 1 });
    // Only cancellations, nothing in the year: still read, so the cancellation applies.
    const onlyCancel = laterFile(later('2025-02-01', 'Kiosk Beispiel', '2.00', '4000000000102', 'Storniert'));
    expect(await importPayments(db, ctx, laterId, onlyCancel, { onlyYear: 2026 })).toMatchObject({ added: 0, cancelledEarlier: 1 });
    // The year import holds a cancellation and a later import of the list exists: it is not undone first.
    expect(await code(deleteImportBatch(db, ctx, year.batchId))).toBe('batch_has_later_cancellation');
  });

  it('an import whose purchase a later list cancelled is not undone first, even on other days', async () => {
    const { ctx, laterId } = await withLaterAccount();
    const first = await importPayments(db, ctx, laterId, laterFile(later('2024-12-10', 'Laden Beispiel', '30.00', '4000000000201')));
    await importPayments(db, ctx, laterId, laterFile(later('2024-12-10', 'Laden Beispiel', '30.00', '4000000000201', 'Storniert'), later('2025-03-01', 'Kiosk Beispiel', '4.00', '4000000000202')), { onlyYear: 2025 });
    expect(await code(deleteImportBatch(db, ctx, first.batchId))).toBe('batch_has_later_cancellation');
  });

  it('a day the first source exported only in part is filled by the second: what is beyond the stored movements is added', async () => {
    const { ctx, accountId } = await workspace();
    // The export was taken at noon on 30 June: it has the morning's 20.00, not the afternoon's 7.00.
    await importPayments(db, ctx, accountId, EXPORT);
    const list = interfaceList([
      ['2025-06-30', 'Werkzeug Beispiel GmbH', '-20'],
      ['2025-06-30', 'Laden Beispiel', '-7'],
      ['2025-07-02', 'Werkzeug Beispiel GmbH', '-30'],
    ]);
    expect(await importPayments(db, ctx, accountId, list)).toMatchObject({ added: 2, skipped: { covered_by_other_source: 1 } });
    expect((await days(accountId)).sort()).toEqual(['2025-01-10 -1000', '2025-06-30 -2000', '2025-06-30 -700', '2025-07-02 -3000']);
    // Read again: nothing doubled.
    expect(await importPayments(db, ctx, accountId, list + ' ')).toMatchObject({ added: 0 });
    expect(await db.taxPayment.count({ where: { accountId } })).toBe(4);
  });

  it('a fuller export of a day the other source completed stores nothing twice', async () => {
    const { ctx, accountId } = await workspace();
    await importPayments(db, ctx, accountId, EXPORT);
    await importPayments(db, ctx, accountId, interfaceList([['2025-06-30', 'Werkzeug Beispiel GmbH', '-20'], ['2025-06-30', 'Laden Beispiel', '-7']]));
    // The bank's own export, taken later, has the whole of 30 June.
    const fuller = file(line('2025-06-30', 'Werkzeug Beispiel GmbH', 'Bestellung 2', '-20'), line('2025-06-30', 'Laden Beispiel', 'Einkauf', '-7'), line('2025-07-01', 'Laden Beispiel', 'Einkauf', '-1'));
    expect(await importPayments(db, ctx, accountId, fuller)).toMatchObject({ added: 1, skipped: { covered_by_other_source: 1 } });
    expect((await days(accountId)).sort()).toEqual(['2025-01-10 -1000', '2025-06-30 -2000', '2025-06-30 -700', '2025-07-01 -100']);
  });

  it('limited to a year whose rows another source holds: the refusal says so, not that the year is empty', async () => {
    const { ctx, accountId } = await workspace();
    await importPayments(db, ctx, accountId, EXPORT);
    const list = interfaceList([['2025-01-10', 'Werkzeug Beispiel GmbH', '-10'], ['2026-02-01', 'Laden Beispiel', '-3']]);
    expect(await code(importPayments(db, ctx, accountId, list, { onlyYear: 2025 }))).toBe('nothing_uncovered');
    expect(await code(importPayments(db, ctx, accountId, list, { onlyYear: 2024 }))).toBe('nothing_in_year');
  });

  it('an import of one source and the undo of another at the same moment leave no day empty', async () => {
    const { ctx, accountId } = await workspace();
    const exported = await importPayments(db, ctx, accountId, EXPORT);
    const results = await Promise.allSettled([importPayments(db, ctx, accountId, LIST, { onlyYear: 2025 }), deleteImportBatch(db, ctx, exported.batchId)]);
    const undone = results[1].status === 'fulfilled';
    if (undone) {
      // The undo went first: the list then holds every day of 2025 itself.
      expect(await days(accountId)).toEqual(['2025-06-30 -2000', '2025-07-02 -3000', '2025-12-31 -4000']);
    } else {
      // The import went first: the export stays, and so do its days.
      expect((results[1] as PromiseRejectedResult).reason).toMatchObject({ code: 'batch_has_later_source' });
      expect(await days(accountId)).toEqual(['2025-01-10 -1000', '2025-06-30 -2000', '2025-07-02 -3000', '2025-12-31 -4000']);
    }
  });
});

describe('an invoice whose remainder is booked out as never to be paid', () => {
  const base = { number: 'R-2026-090', issueDate: '2026-02-01', grossCents: 50_000, treatment: 'small_business', payments: [] };
  const links = async (invoiceId: string) => (await db.taxPaymentLink.findMany({ where: { invoiceId }, orderBy: { cents: 'desc' } })).map((l) => l.cents);

  it('forward, write-off saved before the import: the transfer of the invoice less the kept fee is the exact rest and links on its number; nothing more is offered', async () => {
    const { ws, ctx, accountId } = await workspace();
    const invoiceId = await saveInvoice(db, ctx, null, { ...base, writtenOffCents: 2_000, writtenOffOn: '2026-02-20' });
    expect((await importPayments(db, ctx, accountId, file(line('2026-02-15', 'Kunde Beispiel', 'Rechnung R-2026-090', '480', 'Credit Transfer')))).autoLinked).toBe(1);
    expect(await links(invoiceId)).toEqual([48_000]);
    await importPayments(db, ctx, accountId, file(line('2026-02-25', 'Kunde Beispiel', 'Nachzahlung', '20', 'Credit Transfer')));
    const late = (await db.taxPayment.findFirst({ where: { accountId, amountCents: 2_000 } }))!;
    expect(await code(linkPayment(db, ctx, { paymentId: late.id, invoiceId }, rowCheck(ctx)))).toBe('target_written_off');
    expect((await loadStatement(db, ws.workspaceId, 2026)).payments.invoiceTargets).toEqual([]);

    // Change an earlier input: taking the write-off back opens the 20.00 again everywhere, and the late payment links.
    await saveInvoice(db, ctx, invoiceId, { ...base, writtenOffCents: 0, writtenOffOn: null });
    expect((await loadStatement(db, ws.workspaceId, 2026)).payments.invoiceTargets).toEqual([{ id: invoiceId, label: 'Rechnung R-2026-090', openCents: 2_000 }]);
    await linkPayment(db, ctx, { paymentId: late.id, invoiceId }, rowCheck(ctx));
    expect(await links(invoiceId)).toEqual([48_000, 2_000]);
    // Paid in full now, a write-off cannot be put back on top.
    await expect(saveInvoice(db, ctx, invoiceId, { ...base, writtenOffCents: 2_000, writtenOffOn: '2026-02-26' })).rejects.toMatchObject({ code: 'invalid_write_off' });
  });

  it('the usual order, payment first and write-off after: the link by hand is capped at the payment, the rest stays booked out', async () => {
    const { ctx, accountId } = await workspace();
    const invoiceId = await saveInvoice(db, ctx, null, base);
    // 480 against 500 open: the amount differs, so nothing links by itself.
    expect((await importPayments(db, ctx, accountId, file(line('2026-02-15', 'Kunde Beispiel', 'Rechnung R-2026-090', '480', 'Credit Transfer')))).autoLinked).toBe(0);
    await saveInvoice(db, ctx, invoiceId, { ...base, writtenOffCents: 2_000, writtenOffOn: '2026-02-20' });
    const payment = (await db.taxPayment.findFirst({ where: { accountId } }))!;
    await linkPayment(db, ctx, { paymentId: payment.id, invoiceId }, rowCheck(ctx));
    expect(await links(invoiceId)).toEqual([48_000]);
  });
});

describe('a refunded purchase: money back is proposed for the purchase’s receipt and nets it out', () => {
  const ORDER = file(
    line('2026-03-02', 'Versand Beispiel', 'Bestellung 302-1234567-7654321', '-49.99'),
    line('2026-03-20', 'Versand Beispiel', 'Erstattung 302-1234567-7654321', '49.99', 'Credit Transfer'),
  );
  async function refundedOrder() {
    const base = await workspace();
    const rowId = await base.ws.addReceipt({ Name: 'Tastatur', Vendor: 'Versand Beispiel', Gross: 49.99, Date: '2026-03-01', Category: 'Bürobedarf', Zuordnung: 'Geschäftlich', Currency: 'EUR', 'FX Rate': 1 });
    await importPayments(db, base.ctx, base.accountId, ORDER);
    await setCounterpartyTreatment(db, base.ctx, { counterparty: 'Versand Beispiel', treatment: 'business' });
    const purchase = (await db.taxPayment.findFirst({ where: { accountId: base.accountId, amountCents: { lt: 0 } } }))!;
    const back = (await db.taxPayment.findFirst({ where: { accountId: base.accountId, amountCents: { gt: 0 } } }))!;
    await setPaymentKind(db, base.ctx, back.id, 'refund');
    await linkPayment(db, base.ctx, { paymentId: purchase.id, rowId }, rowCheck(base.ctx));
    return { ...base, rowId, purchase, back };
  }
  const refundOpen = async (workspaceId: string) => (await loadStatement(db, workspaceId, 2026)).payments.open.filter((o) => o.check === 'refund_without_receipt');

  it('forward: the refund names the receipt of its purchase, and once linked the receipt costs nothing', async () => {
    const { ws, ctx, rowId, back } = await refundedOrder();
    const [open] = await refundOpen(ws.workspaceId);
    expect(open.proposals).toEqual([{ target: 'receipt', targetId: rowId, label: 'Tastatur', strength: 'refund_reference' }]);
    await linkPayment(db, ctx, { paymentId: back.id, rowId: open.proposals[0].targetId }, rowCheck(ctx));
    const view = await loadStatement(db, ws.workspaceId, 2026);
    expect(view.items.find((i) => i.rowId === rowId)).toMatchObject({ amountCents: 0 });
    expect(await refundOpen(ws.workspaceId)).toEqual([]);
  });

  it('change an earlier input: taking the purchase’s link back takes the proposal with it, linking it again brings it back', async () => {
    const { ws, ctx, rowId, purchase } = await refundedOrder();
    const link = (await db.taxPaymentLink.findFirst({ where: { paymentId: purchase.id } }))!;
    await unlinkPayment(db, ctx, link.id);
    // Without the purchase the receipt is still proposed by its vendor, as a refund of the whole receipt.
    expect((await refundOpen(ws.workspaceId))[0].proposals).toEqual([{ target: 'receipt', targetId: rowId, label: 'Tastatur', strength: 'refund_full' }]);
    await linkPayment(db, ctx, { paymentId: purchase.id, rowId }, rowCheck(ctx));
    expect((await refundOpen(ws.workspaceId))[0].proposals.map((p) => p.strength)).toEqual(['refund_reference']);
  });

  it('resume: a fresh load shows the same proposal, nothing is linked by loading', async () => {
    const { ws, rowId } = await refundedOrder();
    const first = (await refundOpen(ws.workspaceId))[0].proposals;
    const again = (await refundOpen(ws.workspaceId))[0].proposals;
    expect(again).toEqual(first);
    expect(first.map((p) => p.targetId)).toEqual([rowId]);
    expect(await db.taxPaymentLink.count({ where: { rowId } })).toBe(1);
  });

  it('re-entry: a link taken back is proposed again; a part refund leaves the rest, and money back beyond the rest is refused', async () => {
    const { ws, ctx, rowId, back, accountId } = await refundedOrder();
    const { linkId } = await linkPayment(db, ctx, { paymentId: back.id, rowId }, rowCheck(ctx));
    await unlinkPayment(db, ctx, linkId);
    expect((await refundOpen(ws.workspaceId))[0].proposals.map((p) => p.targetId)).toEqual([rowId]);
    await importPayments(db, ctx, accountId, file(line('2026-03-25', 'Versand Beispiel', 'Teilerstattung', '10', 'Credit Transfer')));
    const part = (await db.taxPayment.findFirst({ where: { accountId, amountCents: 1_000 } }))!;
    await setPaymentKind(db, ctx, part.id, 'refund');
    await linkPayment(db, ctx, { paymentId: part.id, rowId }, rowCheck(ctx));
    expect((await loadStatement(db, ws.workspaceId, 2026)).items.find((i) => i.rowId === rowId)).toMatchObject({ amountCents: 3_999 });
    // The full refund no longer fits what is left: not proposed, and refused by hand with what is left.
    expect((await refundOpen(ws.workspaceId))[0].proposals).toEqual([]);
    expect(await code(linkPayment(db, ctx, { paymentId: back.id, rowId }, rowCheck(ctx)))).toBe('refund_exceeds_receipt');
    // Confirmed, what is left is linked and the rest of the payment stays open.
    await linkPayment(db, ctx, { paymentId: back.id, rowId, confirmed: true }, rowCheck(ctx));
    expect((await loadStatement(db, ws.workspaceId, 2026)).items.find((i) => i.rowId === rowId)).toMatchObject({ amountCents: 0 });
    expect((await refundOpen(ws.workspaceId)).find((o) => o.id === back.id)).toMatchObject({ freeCents: 1_000 });
    // Nothing left: refused even confirmed.
    expect(await code(linkPayment(db, ctx, { paymentId: back.id, rowId, confirmed: true }, rowCheck(ctx)))).toBe('refund_exceeds_receipt');
  });

  it('a counterparty answered mixed is asked about its money back when a purchase of its is on a receipt; one answered own account is not', async () => {
    const { ws, ctx } = await refundedOrder();
    await setCounterpartyTreatment(db, ctx, { counterparty: 'Versand Beispiel', treatment: 'mixed' });
    expect((await refundOpen(ws.workspaceId)).length).toBe(1);
    // Not counted in the counterparty question as well.
    expect((await loadStatement(db, ws.workspaceId, 2026)).payments.unclassified).toEqual([]);
    await setCounterpartyTreatment(db, ctx, { counterparty: 'Versand Beispiel', treatment: 'own_account' });
    expect(await refundOpen(ws.workspaceId)).toEqual([]);
  });

  it('a refund a few cents above what is left (exchange rates): confirmed, what is left is linked and the cents stay open', async () => {
    const { ws, ctx, accountId, rowId } = await refundedOrder();
    await importPayments(db, ctx, accountId, file(line('2026-03-27', 'Versand Beispiel', 'Erstattung Kurs', '50.10', 'Credit Transfer')));
    const above = (await db.taxPayment.findFirst({ where: { accountId, amountCents: 5_010 } }))!;
    await setPaymentKind(db, ctx, above.id, 'refund');
    expect(await code(linkPayment(db, ctx, { paymentId: above.id, rowId }, rowCheck(ctx)))).toBe('refund_exceeds_receipt');
    await linkPayment(db, ctx, { paymentId: above.id, rowId, confirmed: true }, rowCheck(ctx));
    expect((await db.taxPaymentLink.findFirst({ where: { paymentId: above.id } }))?.cents).toBe(4_999);
    expect((await loadStatement(db, ws.workspaceId, 2026)).items.find((i) => i.rowId === rowId)).toMatchObject({ amountCents: 0 });
    expect((await refundOpen(ws.workspaceId)).find((o) => o.id === above.id)).toMatchObject({ freeCents: 11 });
  });

  it('a number every purchase of the counterparty carries, linked or not, proposes nothing as an order number', async () => {
    const { ws, ctx, accountId } = await workspace();
    const rowId = await ws.addReceipt({ Name: 'Kabel', Vendor: 'Laden Beispiel', Gross: 40, Date: '2026-05-01', Category: 'Bürobedarf', Zuordnung: 'Geschäftlich', Currency: 'EUR', 'FX Rate': 1 });
    await importPayments(db, ctx, accountId, file(
      line('2026-05-01', 'Laden Beispiel', 'Kunde 88123456 Einkauf', '-40'),
      line('2026-05-03', 'Laden Beispiel', 'Kunde 88123456 Einkauf', '-15'),
      line('2026-05-09', 'Laden Beispiel', 'Gutschrift Kunde 88123456', '10', 'Credit Transfer'),
    ));
    await setCounterpartyTreatment(db, ctx, { counterparty: 'Laden Beispiel', treatment: 'business' });
    const purchase = (await db.taxPayment.findFirst({ where: { accountId, amountCents: -4_000 } }))!;
    await linkPayment(db, ctx, { paymentId: purchase.id, rowId }, rowCheck(ctx));
    const back = (await db.taxPayment.findFirst({ where: { accountId, amountCents: 1_000 } }))!;
    await setPaymentKind(db, ctx, back.id, 'refund');
    const open = (await loadStatement(db, ws.workspaceId, 2026)).payments.open.find((o) => o.id === back.id)!;
    expect(open.proposals.map((p) => p.strength)).toEqual(['refund_part']);
  });

  it('money back in January for a December purchase is not proposed for last year’s receipt', async () => {
    const { ws, ctx, accountId } = await workspace();
    const rowId = await ws.addReceipt({ Name: 'Lampe', Vendor: 'Laden Beispiel', Gross: 30, Date: '2025-12-20', Category: 'Bürobedarf', Zuordnung: 'Geschäftlich', Currency: 'EUR', 'FX Rate': 1 });
    await importPayments(db, ctx, accountId, file(line('2025-12-20', 'Laden Beispiel', 'Kartenzahlung', '-30'), line('2026-01-05', 'Laden Beispiel', 'Rückerstattung', '30', 'Credit Transfer')));
    await setCounterpartyTreatment(db, ctx, { counterparty: 'Laden Beispiel', treatment: 'business' });
    const purchase = (await db.taxPayment.findFirst({ where: { accountId, amountCents: -3_000 } }))!;
    await linkPayment(db, ctx, { paymentId: purchase.id, rowId }, rowCheck(ctx));
    const open = (await loadStatement(db, ws.workspaceId, 2026)).payments.open.find((o) => o.amountCents === 3_000)!;
    expect(open.proposals.filter((p) => p.target === 'receipt')).toEqual([]);
  });

  it('money in that the file calls income is offered for the purchase it refunds too, and a counterparty never asked about is', async () => {
    const { ws, ctx, accountId } = await workspace();
    const rowId = await ws.addReceipt({ Name: 'Kabel', Vendor: 'Laden Beispiel', Gross: 12, Date: '2026-04-01', Category: 'Bürobedarf', Zuordnung: 'Geschäftlich', Currency: 'EUR', 'FX Rate': 1 });
    await importPayments(db, ctx, accountId, file(
      line('2026-04-01', 'Laden Beispiel', 'Kartenzahlung', '-12'),
      line('2026-04-09', 'Laden Beispiel', 'Gutschrift', '12', 'Credit Transfer'),
    ));
    const purchase = (await db.taxPayment.findFirst({ where: { accountId, amountCents: -1_200 } }))!;
    await linkPayment(db, ctx, { paymentId: purchase.id, rowId }, rowCheck(ctx));
    const open = (await loadStatement(db, ws.workspaceId, 2026)).payments.open.find((o) => o.amountCents === 1_200)!;
    expect(open.proposals).toEqual([{ target: 'receipt', targetId: rowId, label: 'Kabel', strength: 'refund_full' }]);
    // Linked to the receipt it is money back, not revenue; nothing is stored for that, and taking the link back makes it income again.
    const invoiceId = await saveInvoice(db, ctx, null, { number: 'R-2026-400', issueDate: '2026-04-01', grossCents: 1_200, treatment: 'small_business', payments: [] });
    const { linkId } = await linkPayment(db, ctx, { paymentId: open.id, rowId }, rowCheck(ctx));
    expect((await loadPayments(db, ws.workspaceId)).payments.find((p) => p.id === open.id)).toMatchObject({ kind: 'refund', kindOverridden: false });
    expect((await loadStatement(db, ws.workspaceId, 2026)).payments.overridden).toEqual([]);
    // On a receipt it does not also pay an invoice.
    expect(await code(linkPayment(db, ctx, { paymentId: open.id, invoiceId }, rowCheck(ctx)))).toBe('invalid_link');
    await unlinkPayment(db, ctx, linkId);
    expect((await loadPayments(db, ws.workspaceId)).payments.find((p) => p.id === open.id)).toMatchObject({ kind: 'income' });
    // On an invoice it does not also go on a receipt.
    const { linkId: onInvoice } = await linkPayment(db, ctx, { paymentId: open.id, invoiceId }, rowCheck(ctx));
    expect(await code(linkPayment(db, ctx, { paymentId: open.id, rowId }, rowCheck(ctx)))).toBe('invalid_link');
    await unlinkPayment(db, ctx, onInvoice);
    // Answered private: nothing is proposed or asked.
    await setCounterpartyTreatment(db, ctx, { counterparty: 'Laden Beispiel', treatment: 'private' });
    expect((await loadStatement(db, ws.workspaceId, 2026)).payments.open.find((o) => o.amountCents === 1_200)).toBeUndefined();
  });

  it('a credit note entered as a receipt with a negative amount nets its invoice out in the year', async () => {
    const { ws } = await workspace();
    await ws.addReceipt({ Name: 'Rechnung Monitor', Vendor: 'Versand Beispiel', Gross: 199, Date: '2026-05-02', Category: 'Bürobedarf', Zuordnung: 'Geschäftlich', Currency: 'EUR', 'FX Rate': 1 });
    await ws.addReceipt({ Name: 'Gutschrift Monitor', Vendor: 'Versand Beispiel', Gross: -199, Date: '2026-05-20', Category: 'Bürobedarf', Zuordnung: 'Geschäftlich', Currency: 'EUR', 'FX Rate': 1 });
    const view = await loadStatement(db, ws.workspaceId, 2026);
    const items = view.items.filter((i) => i.vendor === 'Versand Beispiel');
    expect(items.map((i) => i.amountCents).sort()).toEqual([-19_900, 19_900]);
    expect(items.reduce((sum, i) => sum + (i.amountCents ?? 0), 0)).toBe(0);
  });
});
