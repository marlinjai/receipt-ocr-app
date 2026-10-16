import { Prisma } from '@prisma/client';
import { afterAll, describe, expect, it } from 'vitest';
import { saveTaxSettings } from '@/lib/meals/service';
import { loadStatement, receiptForLink, saveYearBoundaryAnswer, type TaxContext } from '../../service';
import { PaymentServiceError, createAccount, deleteImportBatch, importPayments, linkPayment, loadPayments, setPaymentKind, setPaymentMethod, setPaymentTransfer } from '../service';
import { createWorkspace, db, type TestWorkspace } from '../../../../../test/db-helpers';

/**
 * The day a pay-later purchase counts on, against a real database (migration
 * 0030). Run with `pnpm test:db`. Every name, number and amount is invented.
 */

afterAll(async () => {
  await db.$disconnect();
});

const LATER_HEADER = 'created_date,created_time,activated,settled,amount,currency,merchant,items,payment_method,status,payment_reference,statement_number,category,purchase_type,card,source,timezone';
const later = (o: { day: string; merchant: string; amount: string; reference: string; statement: string; method?: string; card?: string; activated?: string }) =>
  [o.day, '09:30', o.activated ?? `${o.day} 09:31`, '', o.amount, 'EUR', `"${o.merchant}"`, `"${o.merchant} Bestellung"`, `"${o.method ?? 'Invoice'}"`, '"Normal"', o.reference, o.statement, '', '', o.card ?? '', 'beispiel-quelle', 'Europe/Berlin'].join(',');
const laterFile = (...lines: string[]) => [LATER_HEADER, ...lines].join('\n') + '\n';

/** December 2025: a lamp bought at a shop's checkout on invoice, a coffee with the service's card, on one statement. February 2026 on another. */
const CHECKOUT = { day: '2025-12-10', merchant: 'Laden Beispiel', amount: '40.00', reference: '5000000000001', statement: '7ABCDEFG' };
const CARD = { day: '2025-12-12', merchant: 'Café Beispiel', amount: '25.00', reference: '5000000000002', statement: '7ABCDEFG', card: '•••• 0000' };
const FEBRUARY = { day: '2026-02-03', merchant: 'Kiosk Beispiel', amount: '3.00', reference: '5000000000003', statement: '8BCDEFGH' };
const LIST = laterFile(later(CHECKOUT), later(CARD), later(FEBRUARY));

const BANK_HEADER = '"Booking Date","Value Date","Partner Name","Partner Iban",Type,"Payment Reference","Account Name","Amount (EUR)","Original Amount","Original Currency","Exchange Rate"';
const bankLine = (day: string, partner: string, reference: string, amount: string) => `${day},${day},"${partner}",,Direct Debit,"${reference}",Hauptkonto,${amount},,,`;
const bankFile = (...lines: string[]) => [BANK_HEADER, ...lines].join('\n') + '\n';
/** The service collects the December statement (40.00 + 25.00) on 8 January 2026, inside the ten days after the turn of the year. */
const COLLECTION = bankFile(bankLine('2026-01-08', 'Klarna Bank AB (publ)', 'Lastschrift Abrechnung', '-65'));

const rowCheck = (ctx: TaxContext) => receiptForLink(db, ctx.workspaceId);
const receipt = (ws: TestWorkspace, o: { Name: string; Vendor: string; Gross: number; Date: string }) =>
  ws.addReceipt({ ...o, Category: 'Software & Lizenzen', Zuordnung: 'Geschäftlich', Currency: 'EUR', 'FX Rate': 1 });

async function setUp(options: { bank?: string | null } = {}) {
  const ws = await createWorkspace();
  const ctx: TaxContext = { workspaceId: ws.workspaceId, tenantId: ws.tenantId };
  await saveTaxSettings(db, ctx, { smallBusiness: true });
  const bankId = await createAccount(db, ctx, { label: 'Geschäftskonto', kind: 'bank' });
  const laterId = await createAccount(db, ctx, { label: 'Später zahlen', kind: 'payment_service' });
  const listImport = await importPayments(db, ctx, laterId, LIST);
  const bankImport = options.bank === null ? null : await importPayments(db, ctx, bankId, options.bank ?? COLLECTION);
  const purchaseId = async (amountCents: number) => (await db.taxPayment.findFirstOrThrow({ where: { accountId: laterId, amountCents } })).id;
  const lampRow = await receipt(ws, { Name: 'Lampe', Vendor: 'Laden Beispiel', Gross: 40, Date: '2025-12-10' });
  const coffeeRow = await receipt(ws, { Name: 'Kaffee', Vendor: 'Café Beispiel', Gross: 25, Date: '2025-12-12' });
  const checkoutId = await purchaseId(-4_000);
  const cardId = await purchaseId(-2_500);
  await linkPayment(db, ctx, { paymentId: checkoutId, rowId: lampRow }, rowCheck(ctx));
  await linkPayment(db, ctx, { paymentId: cardId, rowId: coffeeRow }, rowCheck(ctx));
  return { ws, ctx, bankId, laterId, listImport, bankImport, lampRow, coffeeRow, checkoutId, cardId };
}

const item = async (workspaceId: string, year: number, rowId: string) => (await loadStatement(db, workspaceId, year)).items.find((i) => i.rowId === rowId);
const code = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    if (e instanceof PaymentServiceError) return e.code;
    if (e instanceof Error && 'code' in e) return String((e as { code: unknown }).code);
    throw e;
  }
  return 'no error';
};

describe('the day a pay-later purchase counts on: forward, change an earlier input, resume, re-entry', () => {
  it('forward: a checkout purchase counts in the year the service collects it, a card purchase of the same statement in the year it was bought', async () => {
    const { ws, lampRow, coffeeRow, checkoutId, cardId } = await setUp();
    const loaded = await loadPayments(db, ws.workspaceId);
    expect(loaded.payments.find((p) => p.id === checkoutId)).toMatchObject({ bookingDay: '2025-12-10', taxDay: '2026-01-08', payLater: { method: 'checkout', matchedBy: 'amount', dayUnknown: false } });
    expect(loaded.payments.find((p) => p.id === cardId)).toMatchObject({ bookingDay: '2025-12-12', taxDay: '2025-12-12', payLater: { method: 'card' } });

    // The lamp left 2025: nothing was paid for it before 8 January 2026.
    expect(await item(ws.workspaceId, 2025, lampRow)).toBeUndefined();
    expect(await item(ws.workspaceId, 2026, lampRow)).toMatchObject({ date: '2026-01-08', amountCents: 4_000, amountBasis: 'payment' });
    expect(await item(ws.workspaceId, 2025, coffeeRow)).toMatchObject({ date: '2025-12-12', amountCents: 2_500 });

    // Listed for a look in both years it touches; the proposals and lists keep the purchase day.
    const view2025 = await loadStatement(db, ws.workspaceId, 2025);
    expect(view2025.payments.payLaterDays).toEqual({
      moved: [expect.objectContaining({ id: checkoutId, bookingDay: '2025-12-10', taxDay: '2026-01-08', method: 'checkout', byPerson: false, linkedTo: ['Lampe'] })],
      unknown: [],
      relabelled: [],
      withoutDetail: 0,
    });
    expect((await loadStatement(db, ws.workspaceId, 2026)).payments.payLaterDays.moved.map((m) => m.id)).toEqual([checkoutId]);
    expect(view2025.payments.links.find((l) => l.paymentId === checkoutId)?.bookingDay).toBe('2025-12-10');
    // The collection stays a transfer; the reconciliation compares money as before.
    expect((await loadStatement(db, ws.workspaceId, 2026)).payments.ruleTransfers.map((t) => t.amountCents)).toEqual([-6_500]);
  });

  it('forward: the ten-day rule reads the collection day, and an answer given for it holds', async () => {
    const { ws, ctx, lampRow } = await setUp();
    const view2026 = await loadStatement(db, ws.workspaceId, 2026);
    expect(view2026.yearBoundary.find((e) => e.subjectId === lampRow)).toMatchObject({ kind: 'receipt', cashDay: '2026-01-08', dayBasis: 'payment', otherYear: 2025 });
    // The server works the day out again: it must be the same collection day the screen showed.
    await saveYearBoundaryAnswer(db, ctx, { kind: 'receipt', subjectId: lampRow, cashDay: '2026-01-08', belongsToOtherYear: true });
    expect(await item(ws.workspaceId, 2025, lampRow)).toBeDefined();
  });

  it('change an earlier input: a person says the checkout purchase was paid by card, and takes it back', async () => {
    const { ws, ctx, lampRow, checkoutId } = await setUp();
    await setPaymentMethod(db, ctx, checkoutId, 'card');
    expect(await item(ws.workspaceId, 2025, lampRow)).toMatchObject({ date: '2025-12-10' });
    let days = (await loadStatement(db, ws.workspaceId, 2025)).payments.payLaterDays;
    expect(days.moved).toEqual([]);
    expect(days.relabelled).toEqual([expect.objectContaining({ id: checkoutId, method: 'card', byPerson: true, taxDay: '2025-12-10' })]);

    await setPaymentMethod(db, ctx, checkoutId, null);
    expect(await item(ws.workspaceId, 2025, lampRow)).toBeUndefined();
    days = (await loadStatement(db, ws.workspaceId, 2025)).payments.payLaterDays;
    expect(days.relabelled).toEqual([]);
    expect(days.moved.map((m) => m.id)).toEqual([checkoutId]);
  });

  it('change an earlier input, the counter-case: a card purchase said to be on invoice moves to the collection day', async () => {
    const { ws, ctx, coffeeRow, cardId } = await setUp();
    await setPaymentMethod(db, ctx, cardId, 'checkout');
    expect(await item(ws.workspaceId, 2025, coffeeRow)).toBeUndefined();
    expect(await item(ws.workspaceId, 2026, coffeeRow)).toMatchObject({ date: '2026-01-08' });
  });

  it('change an earlier input: without the collection the purchase stays on its purchase day and is listed as day unknown', async () => {
    const { ws, ctx, bankImport, lampRow, checkoutId } = await setUp();
    await deleteImportBatch(db, ctx, (bankImport as { batchId: string }).batchId);
    expect(await item(ws.workspaceId, 2025, lampRow)).toMatchObject({ date: '2025-12-10' });
    const days = (await loadStatement(db, ws.workspaceId, 2025)).payments.payLaterDays;
    expect(days.moved).toEqual([]);
    expect(days.unknown).toEqual([expect.objectContaining({ id: checkoutId, taxDay: '2025-12-10', linkedTo: ['Lampe'] })]);
    // The bank import comes back: so does the collection day.
    await importPayments(db, ctx, (await db.taxAccount.findFirstOrThrow({ where: { authWorkspaceId: ws.workspaceId, kind: 'bank' } })).id, COLLECTION);
    expect(await item(ws.workspaceId, 2026, lampRow)).toMatchObject({ date: '2026-01-08' });
  });

  it('change an earlier input: a collection a person said is a payment of its own settles nothing; marked a transfer again, it does', async () => {
    const { ws, ctx, lampRow } = await setUp();
    const collection = await db.taxPayment.findFirstOrThrow({ where: { authWorkspaceId: ws.workspaceId, amountCents: -6_500 } });
    await setPaymentTransfer(db, ctx, collection.id, false);
    expect(await item(ws.workspaceId, 2025, lampRow)).toMatchObject({ date: '2025-12-10' });
    await setPaymentTransfer(db, ctx, collection.id, true);
    expect(await item(ws.workspaceId, 2026, lampRow)).toMatchObject({ date: '2026-01-08' });
  });

  it('a collection after the last day the list covers counts once a person marked it a transfer', async () => {
    // The list ends in December; the funding rule does not reach January, so the debit asks.
    const ws = await createWorkspace();
    const ctx: TaxContext = { workspaceId: ws.workspaceId, tenantId: ws.tenantId };
    await saveTaxSettings(db, ctx, { smallBusiness: true });
    const bankId = await createAccount(db, ctx, { label: 'Geschäftskonto', kind: 'bank' });
    const laterId = await createAccount(db, ctx, { label: 'Später zahlen', kind: 'payment_service' });
    await importPayments(db, ctx, laterId, laterFile(later(CHECKOUT), later(CARD)));
    await importPayments(db, ctx, bankId, COLLECTION);
    const purchase = await db.taxPayment.findFirstOrThrow({ where: { accountId: laterId, amountCents: -4_000 } });
    expect((await loadPayments(db, ws.workspaceId)).payments.find((p) => p.id === purchase.id)?.payLater).toMatchObject({ dayUnknown: true });
    const debit = await db.taxPayment.findFirstOrThrow({ where: { accountId: bankId } });
    await setPaymentTransfer(db, ctx, debit.id, true);
    expect((await loadPayments(db, ws.workspaceId)).payments.find((p) => p.id === purchase.id)).toMatchObject({ taxDay: '2026-01-08', payLater: { dayUnknown: false } });
    // Taken back: the debit asks again and the purchase is on its purchase day.
    await setPaymentKind(db, ctx, debit.id, null);
    expect((await loadPayments(db, ws.workspaceId)).payments.find((p) => p.id === purchase.id)).toMatchObject({ taxDay: '2025-12-10', payLater: { dayUnknown: true } });
  });

  it('a bank line naming the statement settles it whatever its amount', async () => {
    const { ws, checkoutId } = await setUp({ bank: bankFile(bankLine('2026-01-20', 'Klarna Bank AB (publ)', 'Abrechnung 7ABCDEFG', '-64')) });
    expect((await loadPayments(db, ws.workspaceId)).payments.find((p) => p.id === checkoutId)).toMatchObject({ taxDay: '2026-01-20', payLater: { matchedBy: 'statement' } });
  });

  it('resume: a fresh load shows the same days, and the same list again is refused and changes nothing', async () => {
    const { ws, ctx, laterId } = await setUp();
    const first = await loadStatement(db, ws.workspaceId, 2025);
    expect(await code(importPayments(db, ctx, laterId, LIST))).toBe('file_already_imported');
    const again = await loadStatement(db, ws.workspaceId, 2025);
    expect(again.payments.payLaterDays).toEqual(first.payments.payLaterDays);
    expect(again.items.map((i) => [i.rowId, i.date])).toEqual(first.items.map((i) => [i.rowId, i.date]));
  });

  it('re-entry: purchases imported before the details were kept stay on their purchase day until the list is read again, which fills in the details only', async () => {
    const { ws, ctx, laterId, lampRow, checkoutId } = await setUp();
    // The state of production: rows stored without the list's details.
    await db.taxPayment.updateMany({ where: { accountId: laterId }, data: { sourceDetail: Prisma.DbNull } });
    const before = await db.taxPayment.findMany({ where: { accountId: laterId }, orderBy: { id: 'asc' } });
    expect(await item(ws.workspaceId, 2025, lampRow)).toMatchObject({ date: '2025-12-10' });
    expect((await loadStatement(db, ws.workspaceId, 2025)).payments.payLaterDays).toMatchObject({ moved: [], unknown: [], withoutDetail: 2 });

    // The same list once more, with one more purchase (a different file): only the details are filled in.
    const longer = laterFile(later(CHECKOUT), later(CARD), later(FEBRUARY), later({ day: '2026-02-04', merchant: 'Kiosk Beispiel', amount: '2.00', reference: '5000000000004', statement: '8BCDEFGH' }));
    expect(await importPayments(db, ctx, laterId, longer)).toMatchObject({ added: 1, alreadyThere: 3, detailFilled: 3 });
    const after = await db.taxPayment.findMany({ where: { accountId: laterId, id: { in: before.map((p) => p.id) } }, orderBy: { id: 'asc' } });
    const withoutDetail = (rows: typeof before) => rows.map((row) => ({ ...row, sourceDetail: 'left out' }));
    expect(withoutDetail(after)).toEqual(withoutDetail(before));
    expect(after.find((p) => p.id === checkoutId)?.sourceDetail).toEqual({ method: 'Invoice', card: false, statement: '7ABCDEFG', reference: '5000000000001' });
    expect(await db.taxPaymentLink.count({ where: { paymentId: checkoutId } })).toBe(1);
    expect(await item(ws.workspaceId, 2026, lampRow)).toMatchObject({ date: '2026-01-08' });

    // Read once more: nothing left to fill, and details already there are never overwritten.
    await db.taxPayment.update({ where: { id: checkoutId }, data: { sourceDetail: { method: 'Term Loan', card: false, statement: null, reference: '5000000000001' } } });
    const third = laterFile(later(CHECKOUT), later(CARD));
    expect(await importPayments(db, ctx, laterId, third)).toMatchObject({ added: 0, detailFilled: 0 });
    expect((await db.taxPayment.findUniqueOrThrow({ where: { id: checkoutId } })).sourceDetail).toMatchObject({ method: 'Term Loan' });
  });

  it('re-entry: the same list limited to one year fills in the details of every year, and is no empty import', async () => {
    const { ws, ctx, laterId, lampRow } = await setUp();
    await db.taxPayment.updateMany({ where: { accountId: laterId }, data: { sourceDetail: Prisma.DbNull } });
    // Every purchase of 2025 is stored already: the import adds nothing, yet it is kept because it filled in the
    // details, of 2026 too.
    const result = await importPayments(db, ctx, laterId, LIST, { onlyYear: 2025 });
    expect(result).toMatchObject({ added: 0, alreadyThere: 2, detailFilled: 3, onlyYear: 2025 });
    expect(await db.taxPayment.count({ where: { accountId: laterId, sourceDetail: { equals: Prisma.DbNull } } })).toBe(0);
    expect(await item(ws.workspaceId, 2026, lampRow)).toMatchObject({ date: '2026-01-08' });
    // Once filled, the next year has nothing to do and is refused as empty, as before.
    expect(await code(importPayments(db, ctx, laterId, LIST, { onlyYear: 2026 }))).toBe('nothing_new');
  });

  it('re-entry: an unknown payment method is reported after the import and read as checkout', async () => {
    const ws = await createWorkspace();
    const ctx: TaxContext = { workspaceId: ws.workspaceId, tenantId: ws.tenantId };
    const laterId = await createAccount(db, ctx, { label: 'Später zahlen', kind: 'payment_service' });
    const result = await importPayments(db, ctx, laterId, laterFile(later({ ...CHECKOUT, method: 'Direct Bank Transfer' })));
    expect(result).toMatchObject({ unknownMethods: ['Direct Bank Transfer'], notices: { unknown_method: 1 } });
    expect((await loadPayments(db, ws.workspaceId)).payments[0].payLater).toMatchObject({ method: 'checkout', dayUnknown: true });
  });

  it('only a purchase of the pay-later list can be said to be paid by card, only in its workspace, only with a known answer', async () => {
    const { ctx, checkoutId } = await setUp();
    const bankPayment = await db.taxPayment.findFirstOrThrow({ where: { authWorkspaceId: ctx.workspaceId, amountCents: -6_500 } });
    expect(await code(setPaymentMethod(db, ctx, bankPayment.id, 'card'))).toBe('invalid_kind');
    expect(await code(setPaymentMethod(db, ctx, checkoutId, 'financed'))).toBe('invalid_kind');
    const stranger = await createWorkspace();
    expect(await code(setPaymentMethod(db, { workspaceId: stranger.workspaceId, tenantId: stranger.tenantId }, checkoutId, 'card'))).toBe('payment_not_found');
    expect((await db.taxPayment.findUniqueOrThrow({ where: { id: checkoutId } })).payMethodOverride).toBeNull();
  });
});
