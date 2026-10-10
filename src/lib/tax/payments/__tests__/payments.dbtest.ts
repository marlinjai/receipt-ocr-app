import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { saveTaxSettings } from '@/lib/meals/service';
import { deleteDecisionsForRows, isWorkspaceReceipt, loadStatement, saveInvoice, type TaxContext } from '../../service';
import {
  PaymentServiceError,
  createAccount,
  deleteImportBatch,
  importPayments,
  linkPayment,
  setCounterpartyTreatment,
  setPaymentKind,
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

const rowCheck = (ctx: TaxContext) => (rowId: string) => isWorkspaceReceipt(db, ctx.workspaceId, rowId);

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
    // Money received is asked about right away; money out only once the counterparty is business.
    expect(view.payments.open.map((p) => [p.counterparty, p.check])).toEqual([['Kundin Beispiel', 'income_without_invoice']]);

    await setCounterpartyTreatment(db, ctx, { counterparty: 'Werkzeug Beispiel GmbH', treatment: 'business' });
    await setCounterpartyTreatment(db, ctx, { counterparty: 'Vermieter Beispiel', treatment: 'private' });
    view = await loadStatement(db, ws.workspaceId, 2026);
    expect(view.payments.unclassified.map((c) => c.label)).toEqual(['Kundin Beispiel']);
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
    const linkId = await linkPayment(db, ctx, { paymentId: payment.id, rowId }, rowCheck(ctx));

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
    expect(open.proposals).toEqual([{ target: 'receipt', targetId: rowId, label: 'Werkzeugkauf', strength: 'amount_and_date' }]);
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
    // The 300.00 that are left of the payment still wait for an answer.
    expect(view.payments.open.map((o) => o.freeCents)).toEqual([30_000]);
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

  it('an account stays with one source, so no movement is stored twice under two identities', async () => {
    const { ws, ctx, accountId } = await workspace();
    await importPayments(db, ctx, accountId, JANUARY);
    const tomorrow = 'account_type,booking_date,valuta_date,sender_or_recipient,iban,booking_type,description,category,amount,currency\nPersonal Account,2026-02-01,2026-02-01,Laden Beispiel,,Card Payment,Einkauf,shopping,"-12,00",EUR\n';
    expect(await code(importPayments(db, ctx, accountId, tomorrow))).toBe('format_mismatch');
    expect(await db.taxImportBatch.count({ where: { authWorkspaceId: ws.workspaceId } })).toBe(1);
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

describe('workspace isolation', () => {
  it('accounts, payments, rules and links of another workspace do not exist here', async () => {
    const { ws, ctx } = await workspace();
    const foreignAccount = await createAccount(db, otherCtx, { label: 'Fremdes Konto', kind: 'bank' });
    const { batchId } = await importPayments(db, otherCtx, foreignAccount, JANUARY);
    await setCounterpartyTreatment(db, otherCtx, { counterparty: 'Werkzeug Beispiel GmbH', treatment: 'business' });
    const foreignPayment = (await db.taxPayment.findFirst({ where: { accountId: foreignAccount } }))!;
    const foreignRow = await other.addReceipt({ Name: 'Fremd', Vendor: 'Werkzeug Beispiel GmbH', Gross: 108.5, Date: '2026-01-03', Currency: 'EUR', 'FX Rate': 1 });
    const foreignLink = await linkPayment(db, otherCtx, { paymentId: foreignPayment.id, rowId: foreignRow }, rowCheck(otherCtx));

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
