import { afterAll, describe, expect, it } from 'vitest';
import { createAccount, deleteImportBatch, importPayments, linkPayment, loadPayments, setAccountPrivate, setCounterpartyTreatment, setPaymentKind, PaymentServiceError } from '../service';
import {
  ShareError,
  endCompanyAccountShares,
  endShare,
  linkRoutedPayment,
  loadRoutedPayments,
  loadShares,
  receiversOf,
  routedPaymentFor,
  shareAccount,
  unlinkRoutedPayment,
} from '../routing';
import { receiptForLink, loadStatement } from '@/lib/tax/service';
import { LoopServiceError, answerNoReceipt, confirmCandidate, linkReceiptToPayment, loadLoopOverview, runReceiptLoop, settleAcrossShares, withdrawNoReceipt } from '@/lib/spending/loop-service';
import { runSpendingChecksAfterNewPayments } from '@/lib/spending/checks';
import { loadSpending, setCounterpartyCategory } from '@/lib/spending/service';
import { loadBudgets } from '@/lib/spending/budget-service';
import { mailboxFor } from '@/lib/spending/mailbox/server';
import type { NotificationChannel, NotificationMessage } from '@/lib/spending/notify/port';
import type { MailboxPort } from '@/lib/spending/mailbox/port';
import { createWorkspace, db, type TestWorkspace } from '../../../../../test/db-helpers';

/**
 * Payments across companies (plan docs/plans/2026-10-22-payments-across-companies.md)
 * against a real database (migration 0035): an account held by one company
 * shares its private payments with another. Through the four paths of a
 * stateful flow (forward, backtrack and revise, resume, re-entry), and the
 * privacy promise: a company never sees another company's business or
 * unanswered payments, and the holder never sees the receiver's links,
 * answers or finds. Every name and amount is invented.
 */

const HEADER = '"Booking Date","Value Date","Partner Name","Partner Iban",Type,"Payment Reference","Account Name","Amount (EUR)","Original Amount","Original Currency","Exchange Rate"';
const line = (day: string, partner: string, reference: string, amount: string) => `${day},${day},"${partner}",,Presentment,"${reference}",Hauptkonto,${amount},,,`;
const file = (...lines: string[]) => [HEADER, ...lines].join('\n') + '\n';
const TODAY = '2026-05-20';
const OFF_MAILBOX: MailboxPort = { status: () => ({ configured: false, missing: ['SPENDING_MAILBOX_ADDRESS'] }), search: async () => [], fetchAttachment: async () => ({ bytes: new Uint8Array(), mimeType: 'application/pdf', fileName: 'x.pdf' }) };

function recorder() {
  const sent: NotificationMessage[] = [];
  const channel: NotificationChannel = {
    name: 'push',
    async send(_r, message) {
      sent.push(message);
      return { status: 'sent' };
    },
  };
  return { channel, sent };
}

interface World {
  holder: TestWorkspace;
  receiver: TestWorkspace;
  hctx: { workspaceId: string; tenantId: string };
  rctx: { workspaceId: string; tenantId: string };
  accountId: string;
  batchId: string;
  ids: Map<string, string>;
}

/** Whiz-Art-like holder with one account of four payments: private, business, unanswered, mixed. */
async function world(share = true): Promise<World> {
  const [holder, receiver] = await Promise.all([createWorkspace(), createWorkspace()]);
  const hctx = { workspaceId: holder.workspaceId, tenantId: holder.tenantId };
  const rctx = { workspaceId: receiver.workspaceId, tenantId: receiver.tenantId };
  const accountId = await createAccount(db, hctx, { label: 'Girokonto', kind: 'bank' });
  const { batchId } = await importPayments(
    db,
    hctx,
    accountId,
    file(
      line('2026-05-10', 'Privat Laden', 'Einkauf', '-20.00'),
      line('2026-05-11', 'Firma Software', 'Abo', '-50.00'),
      line('2026-05-12', 'Unklar Laden', 'Einkauf', '-10.00'),
      line('2026-05-13', 'Teils Markt', 'Einkauf', '-30.00'),
    ),
  );
  await setCounterpartyTreatment(db, hctx, { counterparty: 'Privat Laden', treatment: 'private' });
  await setCounterpartyTreatment(db, hctx, { counterparty: 'Firma Software', treatment: 'business' });
  await setCounterpartyTreatment(db, hctx, { counterparty: 'Teils Markt', treatment: 'mixed' });
  if (share) await shareAccount(db, hctx, accountId, rctx, 'user-owner');
  const { payments } = await loadPayments(db, hctx.workspaceId);
  return { holder, receiver, hctx, rctx, accountId, batchId, ids: new Map(payments.map((p) => [p.counterparty, p.id])) };
}

const names = async (workspaceId: string) => (await loadRoutedPayments(db, workspaceId)).payments.map((p) => p.counterparty).sort();
const code = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    if (e instanceof PaymentServiceError || e instanceof ShareError || e instanceof LoopServiceError) return e.code;
    throw e;
  }
  return 'no error';
};
const stateOf = async (workspaceId: string, paymentId: string) => {
  const o = await loadLoopOverview(db, workspaceId);
  return [...o.open, ...o.answered].find((c) => c.paymentId === paymentId)?.state.state ?? 'settled_or_not_needed';
};
/** The tax statement of a year, as a string, to compare before and after. */
const statement = async (workspaceId: string) => JSON.stringify(await loadStatement(db, workspaceId, 2026));

afterAll(async () => {
  await db.$disconnect();
});

describe('forward', () => {
  it('routes private and unlinked mixed payments to the receiver, keeps business and unanswered with the holder', async () => {
    const w = await world();
    expect(await names(w.rctx.workspaceId)).toEqual(['Privat Laden', 'Teils Markt']);
    expect(await names(w.hctx.workspaceId)).toEqual(['Firma Software', 'Unklar Laden']);
    // The holder's payments tab still lists every payment: that is where an answer is changed back.
    expect((await loadPayments(db, w.hctx.workspaceId)).payments).toHaveLength(4);
    // The receiver sees the account, marked as the holder's.
    const routed = await loadRoutedPayments(db, w.rctx.workspaceId);
    expect(routed.accounts).toEqual([expect.objectContaining({ id: w.accountId, label: 'Girokonto', sharedFrom: w.hctx.workspaceId })]);
    expect(routed.payments.every((p) => p.routedFrom === w.hctx.workspaceId)).toBe(true);
  });

  it('the receiver links a private receipt; the holder never sees the link and its tax figures stay the same', async () => {
    const w = await world(false);
    const before = await statement(w.hctx.workspaceId);
    await shareAccount(db, w.hctx, w.accountId, w.rctx, 'user-owner');
    expect(await statement(w.hctx.workspaceId)).toBe(before);

    const rowId = await w.receiver.addReceipt({ Name: 'Privat Laden Bon', Vendor: 'Privat Laden', Gross: 20, Date: '2026-05-10', Currency: 'EUR', 'FX Rate': 1 });
    const id = w.ids.get('Privat Laden') as string;
    expect(await stateOf(w.rctx.workspaceId, id)).toBe('proposed');
    await confirmCandidate(db, w.rctx, id, rowId);
    expect(await stateOf(w.rctx.workspaceId, id)).toBe('settled_or_not_needed');

    const link = await db.taxPaymentLink.findFirstOrThrow({ where: { paymentId: id } });
    expect(link).toMatchObject({ authWorkspaceId: w.rctx.workspaceId, authTenantId: w.rctx.tenantId, rowId, cents: 2000 });
    expect((await loadPayments(db, w.hctx.workspaceId)).payments.find((p) => p.id === id)?.links).toEqual([]);
    expect(await statement(w.hctx.workspaceId)).toBe(before);
    // Linking it twice adds nothing.
    expect((await linkRoutedPayment(db, w.rctx, id, rowId, receiptForLink(db, w.rctx.workspaceId))).linkId).toBe(link.id);
  });

  it('asks about a private payment in the receiver only and a business one in the holder only, each once', async () => {
    const w = await world();
    const inReceiver = recorder();
    const inHolder = recorder();
    await runReceiptLoop(db, w.rctx, { today: TODAY, channels: [inReceiver.channel], mailbox: OFF_MAILBOX });
    await runReceiptLoop(db, w.hctx, { today: TODAY, channels: [inHolder.channel], mailbox: OFF_MAILBOX });
    const subjects = (sent: NotificationMessage[]) => sent.map((m) => m.subjectKey).sort();
    expect(subjects(inReceiver.sent)).toEqual([`missing_receipt:${w.ids.get('Privat Laden')}`, `missing_receipt:${w.ids.get('Teils Markt')}`].sort());
    expect(subjects(inHolder.sent)).toEqual([`missing_receipt:${w.ids.get('Firma Software')}`, `missing_receipt:${w.ids.get('Unklar Laden')}`].sort());
    // The receiver's message leads into the receiver.
    expect(inReceiver.sent[0].path).toContain(encodeURIComponent(w.rctx.workspaceId));
  });

  it('the spending overview and the budgets count each payment in one company only', async () => {
    const w = await world();
    const receiver = await loadSpending(db, w.rctx.workspaceId, 2026, null);
    const holder = await loadSpending(db, w.hctx.workspaceId, 2026, null);
    expect(receiver.overview.split).toEqual({ private: 5000, business: 0, unanswered: 0 });
    expect(holder.overview.split).toEqual({ private: 0, business: 5000, unanswered: 1000 });
    expect(holder.sharedOut).toEqual([{ accountLabel: 'Girokonto', receiverWorkspaceId: w.rctx.workspaceId }]);
    const spent = (lines: Awaited<ReturnType<typeof loadBudgets>>) => lines.reduce((s, l) => s + l.spentCents, 0);
    expect(spent(await loadBudgets(db, w.rctx.workspaceId, TODAY))).toBe(5000);
    // The holder's budgets keep what is not business: only the unanswered payment, never the routed ones.
    expect(spent(await loadBudgets(db, w.hctx.workspaceId, TODAY))).toBe(1000);
  });

  it('a category the holder gave a private counterparty before the split still applies; the receiver\'s own wins', async () => {
    const w = await world(false);
    await setCounterpartyCategory(db, w.hctx, { counterparty: 'Privat Laden', category: 'groceries_drugstore' });
    await shareAccount(db, w.hctx, w.accountId, w.rctx, 'user-owner');
    const category = async () => (await loadSpending(db, w.rctx.workspaceId, 2026, null)).overview.payments.find((p) => p.counterparty === 'Privat Laden')?.category;
    expect(await category()).toBe('groceries_drugstore');
    await setCounterpartyCategory(db, w.rctx, { counterparty: 'Privat Laden', category: 'leisure_sport' });
    expect(await category()).toBe('leisure_sport');
    // Nothing flows back: the holder's answer is unchanged.
    expect((await db.spendingCategoryAnswer.findFirstOrThrow({ where: { authWorkspaceId: w.hctx.workspaceId } })).category).toBe('groceries_drugstore');
  });

  it('after new payments the checks run for the holder and for the receiver', async () => {
    const w = await world();
    expect(await receiversOf(db, [w.hctx.workspaceId])).toEqual([{ workspaceId: w.rctx.workspaceId, tenantId: w.rctx.tenantId }]);
    await runSpendingChecksAfterNewPayments(db, w.hctx, { today: TODAY, channels: [], mailbox: OFF_MAILBOX });
    const queued = (workspaceId: string) => db.spendingNotification.count({ where: { authWorkspaceId: workspaceId, kind: 'missing_receipt' } });
    expect(await queued(w.rctx.workspaceId)).toBe(2);
    expect(await queued(w.hctx.workspaceId)).toBe(2);
  });
});

describe('privacy', () => {
  it('the receiver can never read, link, unlink, answer or confirm a business or unanswered payment', async () => {
    const w = await world();
    const rowId = await w.receiver.addReceipt({ Name: 'Software', Vendor: 'Firma Software', Gross: 50, Date: '2026-05-11', Currency: 'EUR', 'FX Rate': 1 });
    for (const name of ['Firma Software', 'Unklar Laden']) {
      const id = w.ids.get(name) as string;
      expect(await routedPaymentFor(db, w.rctx.workspaceId, id)).toBeNull();
      expect(await code(linkRoutedPayment(db, w.rctx, id, rowId, receiptForLink(db, w.rctx.workspaceId)))).toBe('payment_not_found');
      expect(await code(unlinkRoutedPayment(db, w.rctx, id))).toBe('payment_not_found');
      expect(await code(answerNoReceipt(db, w.rctx, id, 'Test'))).toBe('payment_not_found');
      expect(await code(confirmCandidate(db, w.rctx, id, rowId))).toBe('payment_not_found');
    }
    const overview = await loadLoopOverview(db, w.rctx.workspaceId);
    expect([...overview.open, ...overview.answered].map((c) => c.counterparty).sort()).toEqual(['Privat Laden', 'Teils Markt']);
    expect((await loadSpending(db, w.rctx.workspaceId, 2026, null)).overview.payments.map((p) => p.counterparty).sort()).toEqual(['Privat Laden', 'Teils Markt']);
  });

  it('a third company sees nothing, and the holder cannot act on what it routed away', async () => {
    const w = await world();
    const third = await createWorkspace();
    expect(await names(third.workspaceId)).toEqual([]);
    expect(await routedPaymentFor(db, third.workspaceId, w.ids.get('Privat Laden') as string)).toBeNull();
    expect(await code(answerNoReceipt(db, w.hctx, w.ids.get('Privat Laden') as string, 'Test'))).toBe('payment_not_found');
    expect(await code(endShare(db, third.workspaceId, (await loadShares(db, w.hctx.workspaceId)).outgoing[0].id))).toBe('share_not_found');
  });

  it('the receiver can take no receipt over for a payment that is not routed to it', async () => {
    const w = await world();
    const rowId = await w.receiver.addReceipt({ Name: 'Software', Vendor: 'Firma Software', Gross: 50, Date: '2026-05-11', Currency: 'EUR', 'FX Rate': 1 });
    expect(await code(linkReceiptToPayment(db, w.rctx, w.ids.get('Firma Software') as string, rowId))).toBe('payment_not_found');
    expect(await db.taxPaymentLink.count({ where: { authWorkspaceId: w.rctx.workspaceId } })).toBe(0);
  });

  it('a receipt of the receiver is not paid twice by routed payments', async () => {
    const w = await world();
    const rowId = await w.receiver.addReceipt({ Name: 'Bon', Vendor: 'Privat Laden', Gross: 20, Date: '2026-05-10', Currency: 'EUR', 'FX Rate': 1 });
    await linkReceiptToPayment(db, w.rctx, w.ids.get('Privat Laden') as string, rowId);
    expect(await code(linkReceiptToPayment(db, w.rctx, w.ids.get('Teils Markt') as string, rowId))).toBe('receipt_already_paid');
    // Confirmed, as the payments tab does after asking, it goes through.
    await linkRoutedPayment(db, w.rctx, w.ids.get('Teils Markt') as string, rowId, receiptForLink(db, w.rctx.workspaceId), { confirmed: true });
    expect(await db.taxPaymentLink.count({ where: { authWorkspaceId: w.rctx.workspaceId, rowId } })).toBe(2);
  });

  it('the holder never reads the receiver\'s "no receipt" answer', async () => {
    const w = await world();
    const id = w.ids.get('Privat Laden') as string;
    await answerNoReceipt(db, w.rctx, id, 'Geschenk ohne Beleg');
    expect(await stateOf(w.rctx.workspaceId, id)).toBe('no_receipt');
    await setCounterpartyTreatment(db, w.hctx, { counterparty: 'Privat Laden', treatment: 'business' });
    expect(await stateOf(w.hctx.workspaceId, id)).toBe('missing');
  });

  it('the mailbox serves its company and a receiver of its private payments, and no other company', async () => {
    const w = await world();
    const third = await createWorkspace();
    const env = {
      SPENDING_MAILBOX_CLIENT_ID: 'test-client',
      SPENDING_MAILBOX_CLIENT_SECRET: 'test-secret-value',
      SPENDING_MAILBOX_REFRESH_TOKEN: 'test-refresh-value',
      SPENDING_MAILBOX_ADDRESS: 'expenses@example.com',
      SPENDING_MAILBOX_WORKSPACE_ID: w.hctx.workspaceId,
    };
    expect((await mailboxFor(db, w.hctx.workspaceId, env)).status()).toMatchObject({ configured: true });
    expect((await mailboxFor(db, w.rctx.workspaceId, env)).status()).toMatchObject({ configured: true });
    expect((await mailboxFor(db, third.workspaceId, env)).status()).toMatchObject({ configured: false, reason: 'other_company' });
    await endShare(db, w.rctx.workspaceId, (await loadShares(db, w.rctx.workspaceId)).incoming[0].id);
    expect((await mailboxFor(db, w.rctx.workspaceId, env)).status()).toMatchObject({ configured: false, reason: 'other_company' });
  });
});

describe('backtrack and revise', () => {
  it('an answer flipped to business moves the payment back at once, its private link dormant; flipped back, both return', async () => {
    const w = await world();
    const id = w.ids.get('Privat Laden') as string;
    const rowId = await w.receiver.addReceipt({ Name: 'Privat Laden Bon', Vendor: 'Privat Laden', Gross: 20, Date: '2026-05-10', Currency: 'EUR', 'FX Rate': 1 });
    await confirmCandidate(db, w.rctx, id, rowId);
    const taxBefore = await statement(w.hctx.workspaceId);

    await setCounterpartyTreatment(db, w.hctx, { counterparty: 'Privat Laden', treatment: 'business' });
    expect(await names(w.rctx.workspaceId)).toEqual(['Teils Markt']);
    expect(await names(w.hctx.workspaceId)).toEqual(['Firma Software', 'Privat Laden', 'Unklar Laden']);
    // The receiver's link counts nowhere in the holder: the payment asks for a business receipt there.
    expect(await stateOf(w.hctx.workspaceId, id)).toBe('missing');
    expect((await loadPayments(db, w.hctx.workspaceId)).payments.find((p) => p.id === id)?.links).toEqual([]);
    // The receiver sees only that its own receipt hangs on a payment that left: never the payment.
    expect((await loadRoutedPayments(db, w.rctx.workspaceId)).dormantLinks).toEqual([expect.objectContaining({ paymentId: id, rowId, cents: 2000 })]);

    await setCounterpartyTreatment(db, w.hctx, { counterparty: 'Privat Laden', treatment: 'private' });
    expect(await names(w.rctx.workspaceId)).toEqual(['Privat Laden', 'Teils Markt']);
    expect(await stateOf(w.rctx.workspaceId, id)).toBe('settled_or_not_needed');
    expect(await statement(w.hctx.workspaceId)).toBe(taxBefore);
  });

  it('counter-case: giving the same private answer again changes nothing', async () => {
    const w = await world();
    const before = await loadRoutedPayments(db, w.rctx.workspaceId);
    await setCounterpartyTreatment(db, w.hctx, { counterparty: 'Privat Laden', treatment: 'private' });
    expect(await loadRoutedPayments(db, w.rctx.workspaceId)).toEqual(before);
  });

  it('a mixed payment the holder links to a business receipt comes back to the holder whole', async () => {
    const w = await world();
    const id = w.ids.get('Teils Markt') as string;
    const rowId = await w.holder.addReceipt({ Name: 'Teils Markt Rechnung', Vendor: 'Teils Markt', Gross: 30, Date: '2026-05-13', Currency: 'EUR', 'FX Rate': 1 });
    await linkPayment(db, w.hctx, { paymentId: id, rowId }, receiptForLink(db, w.hctx.workspaceId));
    expect(await names(w.rctx.workspaceId)).toEqual(['Privat Laden']);
    expect(await names(w.hctx.workspaceId)).toContain('Teils Markt');
  });

  it('one payment re-labelled private goes over; a whole private account sends what is not business', async () => {
    const w = await world();
    await setPaymentKind(db, w.hctx, w.ids.get('Unklar Laden') as string, 'private');
    expect(await names(w.rctx.workspaceId)).toEqual(['Privat Laden', 'Teils Markt', 'Unklar Laden']);
    await setPaymentKind(db, w.hctx, w.ids.get('Unklar Laden') as string, null);
    await setAccountPrivate(db, w.hctx, w.accountId, true);
    // Unanswered on a private account is private; the business answer stands above the account.
    expect(await names(w.rctx.workspaceId)).toEqual(['Privat Laden', 'Teils Markt', 'Unklar Laden']);
    expect(await names(w.hctx.workspaceId)).toEqual(['Firma Software']);
  });
});

describe('resume', () => {
  it('a fresh read gives the same split, and a payment told about in the holder is not told about again in the receiver', async () => {
    const w = await world();
    const id = w.ids.get('Unklar Laden') as string;
    const inHolder = recorder();
    await runReceiptLoop(db, w.hctx, { today: TODAY, channels: [inHolder.channel], mailbox: OFF_MAILBOX });
    expect(inHolder.sent.map((m) => m.subjectKey)).toContain(`missing_receipt:${id}`);

    await setCounterpartyTreatment(db, w.hctx, { counterparty: 'Unklar Laden', treatment: 'private' });
    const inReceiver = recorder();
    await runReceiptLoop(db, w.rctx, { today: TODAY, channels: [inReceiver.channel], mailbox: OFF_MAILBOX });
    expect(inReceiver.sent.map((m) => m.subjectKey)).not.toContain(`missing_receipt:${id}`);
    // It left the holder's in-app queue on the holder's next run.
    await runReceiptLoop(db, w.hctx, { today: TODAY, channels: [inHolder.channel], mailbox: OFF_MAILBOX });
    expect(await db.spendingNotification.count({ where: { authWorkspaceId: w.hctx.workspaceId, subjectKey: `missing_receipt:${id}`, readAt: null } })).toBe(0);
    expect(await names(w.rctx.workspaceId)).toEqual(['Privat Laden', 'Teils Markt', 'Unklar Laden']);
  });

  it('"no receipt exists" said in the holder before the split still holds in the receiver, and is taken back only there', async () => {
    const w = await world(false);
    const id = w.ids.get('Privat Laden') as string;
    await answerNoReceipt(db, w.hctx, id, 'Automat ohne Beleg');
    await shareAccount(db, w.hctx, w.accountId, w.rctx, 'user-owner');
    expect(await stateOf(w.rctx.workspaceId, id)).toBe('no_receipt');
    const answered = (await loadLoopOverview(db, w.rctx.workspaceId)).answered.find((c) => c.paymentId === id);
    expect(answered?.state).toEqual({ state: 'no_receipt', reason: 'Automat ohne Beleg', fromHolder: true });
    expect(await code(withdrawNoReceipt(db, w.rctx, id))).toBe('answered_by_holder');
    // The receiver's own answer stands above it and is its own to take back.
    await answerNoReceipt(db, w.rctx, id, 'Eigene Antwort');
    expect((await loadLoopOverview(db, w.rctx.workspaceId)).answered.find((c) => c.paymentId === id)?.state).toEqual({ state: 'no_receipt', reason: 'Eigene Antwort' });
    await withdrawNoReceipt(db, w.rctx, id);
    expect(await stateOf(w.rctx.workspaceId, id)).toBe('no_receipt');
  });
});

describe('links of the receiver', () => {
  it('"Lösen" takes the receiver\'s link back, and the payment asks again', async () => {
    const w = await world();
    const id = w.ids.get('Privat Laden') as string;
    const rowId = await w.receiver.addReceipt({ Name: 'Bon', Vendor: 'Privat Laden', Gross: 20, Date: '2026-05-10', Currency: 'EUR', 'FX Rate': 1 });
    await confirmCandidate(db, w.rctx, id, rowId);
    expect(await unlinkRoutedPayment(db, w.rctx, id)).toBe(1);
    expect(await stateOf(w.rctx.workspaceId, id)).toBe('proposed');
    expect(await code(unlinkRoutedPayment(db, w.rctx, id))).toBe('payment_not_found');
  });

  it('a dormant link keeps its receipt from being proposed elsewhere, and can be taken back to free it', async () => {
    const w = await world();
    const id = w.ids.get('Privat Laden') as string;
    const rowId = await w.receiver.addReceipt({ Name: 'Bon', Vendor: 'Privat Laden', Gross: 20, Date: '2026-05-10', Currency: 'EUR', 'FX Rate': 1 });
    await confirmCandidate(db, w.rctx, id, rowId);
    // The shop is answered business now (the first payment and its link go dormant); a second payment of the
    // same shop and amount is re-labelled private on its own, so it is routed here.
    await importPayments(db, w.hctx, w.accountId, file(line('2026-05-15', 'Privat Laden', 'Einkauf zwei', '-20.00')));
    await setCounterpartyTreatment(db, w.hctx, { counterparty: 'Privat Laden', treatment: 'business' });
    const second = (await loadPayments(db, w.hctx.workspaceId)).payments.find((p) => p.reference === 'Einkauf zwei')?.id as string;
    await setPaymentKind(db, w.hctx, second, 'private');
    expect(await names(w.rctx.workspaceId)).toEqual(['Privat Laden', 'Teils Markt']);
    expect(await stateOf(w.rctx.workspaceId, second)).toBe('missing');
    expect(await unlinkRoutedPayment(db, w.rctx, id)).toBe(1);
    expect(await stateOf(w.rctx.workspaceId, second)).toBe('proposed');
  });

  it('a company that holds and receives never pays one receipt twice, and its proposals leave a receipt linked elsewhere out', async () => {
    const w = await world();
    const own = await createAccount(db, w.rctx, { label: 'Eigenes Konto', kind: 'bank' });
    await importPayments(db, w.rctx, own, file(line('2026-05-10', 'Privat Laden', 'Zweite Abbuchung', '-20.00')));
    const ownPayment = (await loadPayments(db, w.rctx.workspaceId)).payments[0].id;
    const rowId = await w.receiver.addReceipt({ Name: 'Bon', Vendor: 'Privat Laden', Gross: 20, Date: '2026-05-10', Currency: 'EUR', 'FX Rate': 1 });
    await confirmCandidate(db, w.rctx, w.ids.get('Privat Laden') as string, rowId);
    expect(await code(linkPayment(db, w.rctx, { paymentId: ownPayment, rowId }, receiptForLink(db, w.rctx.workspaceId)))).toBe('receipt_already_paid');
    expect(await code(linkPayment(db, w.rctx, { paymentId: ownPayment, rowId }, receiptForLink(db, w.rctx.workspaceId), 'estimate'))).toBe('proposal_gone');
    const view = await loadStatement(db, w.rctx.workspaceId, 2026);
    expect(view.payments.estimateProposals.some((p) => p.rowId === rowId)).toBe(false);
    expect((await loadPayments(db, w.rctx.workspaceId)).linkedElsewhere.get(rowId)).toBe(2000);
  });
});

describe('re-entry: messages', () => {
  it('a payment told about in the receiver is not told about again in the holder after the share ended', async () => {
    const w = await world();
    const id = w.ids.get('Privat Laden') as string;
    const inReceiver = recorder();
    await runReceiptLoop(db, w.rctx, { today: TODAY, channels: [inReceiver.channel], mailbox: OFF_MAILBOX });
    expect(inReceiver.sent.map((m) => m.subjectKey)).toContain(`missing_receipt:${id}`);
    await endShare(db, w.hctx.workspaceId, (await loadShares(db, w.hctx.workspaceId)).outgoing[0].id);
    const inHolder = recorder();
    await runReceiptLoop(db, w.hctx, { today: TODAY, channels: [inHolder.channel], mailbox: OFF_MAILBOX });
    expect(inHolder.sent.map((m) => m.subjectKey)).not.toContain(`missing_receipt:${id}`);
  });

  it('a message about a payment that moved leaves the queue of the company it left at once, both ways', async () => {
    const w = await world(false);
    const id = w.ids.get('Privat Laden') as string;
    const unread = (workspaceId: string) => db.spendingNotification.count({ where: { authWorkspaceId: workspaceId, subjectKey: `missing_receipt:${id}`, readAt: null } });
    await runReceiptLoop(db, w.hctx, { today: TODAY, channels: [], mailbox: OFF_MAILBOX });
    expect(await unread(w.hctx.workspaceId)).toBe(1);
    // Shared: the holder's message goes at once, as the sharing action does after its answer.
    await shareAccount(db, w.hctx, w.accountId, w.rctx, 'user-owner');
    await settleAcrossShares(db, [w.hctx.workspaceId, w.rctx.workspaceId]);
    expect(await unread(w.hctx.workspaceId)).toBe(0);

    // Answered business in the holder: the receiver's message goes at once.
    await setCounterpartyTreatment(db, w.hctx, { counterparty: 'Unklar Laden', treatment: 'private' });
    const other = w.ids.get('Unklar Laden') as string;
    await db.spendingNotification.create({ data: { authWorkspaceId: w.rctx.workspaceId, subjectKey: `missing_receipt:${other}`, kind: 'missing_receipt', title: 'Beleg fehlt', body: 'Test', path: '/app/spending' } });
    await setCounterpartyTreatment(db, w.hctx, { counterparty: 'Unklar Laden', treatment: 'business' });
    await settleAcrossShares(db, [w.hctx.workspaceId], { onlyWithReceivers: true });
    expect(await db.spendingNotification.count({ where: { authWorkspaceId: w.rctx.workspaceId, subjectKey: `missing_receipt:${other}`, readAt: null } })).toBe(0);

    // Ended: what the receiver still had about the account's payments goes too.
    await db.spendingNotification.create({ data: { authWorkspaceId: w.rctx.workspaceId, subjectKey: `missing_receipt:${id}`, kind: 'missing_receipt', title: 'Beleg fehlt', body: 'Test', path: '/app/spending' } });
    const ended = await endShare(db, w.rctx.workspaceId, (await loadShares(db, w.rctx.workspaceId)).incoming[0].id);
    expect(ended).toEqual({ holder: w.hctx, receiver: w.rctx });
    await settleAcrossShares(db, [ended.holder.workspaceId, ended.receiver.workspaceId]);
    expect(await unread(w.rctx.workspaceId)).toBe(0);
  });
});

describe('re-entry', () => {
  it('ending the share brings every payment back; sharing again revives the private link', async () => {
    const w = await world();
    const id = w.ids.get('Privat Laden') as string;
    const rowId = await w.receiver.addReceipt({ Name: 'Privat Laden Bon', Vendor: 'Privat Laden', Gross: 20, Date: '2026-05-10', Currency: 'EUR', 'FX Rate': 1 });
    await confirmCandidate(db, w.rctx, id, rowId);
    const shareId = (await loadShares(db, w.hctx.workspaceId)).outgoing[0].id;
    await endShare(db, w.rctx.workspaceId, shareId);
    expect(await names(w.rctx.workspaceId)).toEqual([]);
    expect(await names(w.hctx.workspaceId)).toHaveLength(4);
    expect(await code(endShare(db, w.hctx.workspaceId, shareId))).toBe('share_not_found');

    await shareAccount(db, w.hctx, w.accountId, w.rctx, 'user-owner');
    expect(await stateOf(w.rctx.workspaceId, id)).toBe('settled_or_not_needed');
  });

  it('refuses the same company, a second receiver, and another company\'s account', async () => {
    const w = await world();
    const other = await createWorkspace();
    const octx = { workspaceId: other.workspaceId, tenantId: other.tenantId };
    expect(await code(shareAccount(db, w.hctx, w.accountId, w.hctx, 'user-owner'))).toBe('same_company');
    expect(await code(shareAccount(db, w.hctx, w.accountId, octx, 'user-owner'))).toBe('already_shared');
    expect(await code(shareAccount(db, octx, w.accountId, w.rctx, 'user-owner'))).toBe('account_not_found');
  });

  it('undoing the import takes the payments and the receiver\'s links along', async () => {
    const w = await world();
    const id = w.ids.get('Privat Laden') as string;
    const rowId = await w.receiver.addReceipt({ Name: 'Privat Laden Bon', Vendor: 'Privat Laden', Gross: 20, Date: '2026-05-10', Currency: 'EUR', 'FX Rate': 1 });
    await confirmCandidate(db, w.rctx, id, rowId);
    await deleteImportBatch(db, w.hctx, w.batchId);
    expect(await names(w.rctx.workspaceId)).toEqual([]);
    expect(await db.taxPaymentLink.count({ where: { authWorkspaceId: w.rctx.workspaceId } })).toBe(0);
  });

  it('erasing the receiver ends the share and removes the links that tied the two; erasing the holder does too', async () => {
    const w = await world();
    const id = w.ids.get('Privat Laden') as string;
    const rowId = await w.receiver.addReceipt({ Name: 'Privat Laden Bon', Vendor: 'Privat Laden', Gross: 20, Date: '2026-05-10', Currency: 'EUR', 'FX Rate': 1 });
    await confirmCandidate(db, w.rctx, id, rowId);
    expect(await endCompanyAccountShares(db, w.rctx.tenantId, [])).toMatchObject({ shares: 1, links: 1 });
    expect(await db.taxAccountShare.count({ where: { accountId: w.accountId } })).toBe(0);
    expect(await db.taxPaymentLink.count({ where: { authWorkspaceId: w.rctx.workspaceId } })).toBe(0);
    expect(await endCompanyAccountShares(db, w.rctx.tenantId, [])).toEqual({ shares: 0, links: 0, records: 0 });
    // The holder's payments stay its records.
    expect((await loadPayments(db, w.hctx.workspaceId)).payments).toHaveLength(4);

    const v = await world();
    const vid = v.ids.get('Privat Laden') as string;
    const vrow = await v.receiver.addReceipt({ Name: 'Privat Laden Bon', Vendor: 'Privat Laden', Gross: 20, Date: '2026-05-10', Currency: 'EUR', 'FX Rate': 1 });
    await confirmCandidate(db, v.rctx, vid, vrow);
    expect(await endCompanyAccountShares(db, 'some-other-tenant', [v.hctx.workspaceId])).toMatchObject({ shares: 1, links: 1 });
    expect(await db.taxPaymentLink.count({ where: { authWorkspaceId: v.rctx.workspaceId } })).toBe(0);
  });

  it('erasure also removes what the receiver kept about the holder\'s payments, and nothing of the holder\'s own', async () => {
    const w = await world();
    const id = w.ids.get('Teils Markt') as string;
    await answerNoReceipt(db, w.rctx, id, 'Kein Beleg');
    await answerNoReceipt(db, w.hctx, w.ids.get('Unklar Laden') as string, 'Auch keiner');
    await runReceiptLoop(db, w.rctx, { today: TODAY, channels: [], mailbox: OFF_MAILBOX });
    await db.spendingMailSearch.create({ data: { authWorkspaceId: w.rctx.workspaceId, paymentId: id, outcome: 'none', tries: 1, searchedAt: new Date() } });
    const result = await endCompanyAccountShares(db, w.rctx.tenantId, [w.rctx.workspaceId]);
    expect(result.shares).toBe(1);
    expect(result.records).toBeGreaterThanOrEqual(3);
    expect(await db.spendingReceiptAnswer.count({ where: { authWorkspaceId: w.rctx.workspaceId } })).toBe(0);
    expect(await db.spendingMailSearch.count({ where: { authWorkspaceId: w.rctx.workspaceId } })).toBe(0);
    expect(await db.spendingNotification.count({ where: { authWorkspaceId: w.rctx.workspaceId } })).toBe(0);
    expect(await db.spendingReceiptAnswer.count({ where: { authWorkspaceId: w.hctx.workspaceId } })).toBe(1);
  });
});
