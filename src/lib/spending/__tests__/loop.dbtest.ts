import { afterAll, describe, expect, it } from 'vitest';
import { createAccount, deleteImportBatch, importPayments, loadPayments, setPaymentKind, unlinkPayment } from '@/lib/tax/payments/service';
import { LoopServiceError, MAX_SENDS_PER_RUN, answerNoReceipt, confirmCandidate, loadLoopOverview, runReceiptLoop, withdrawNoReceipt } from '../loop-service';
import { listUnreadNotifications, markNotificationRead, saveNotifySettings, getNotifySettings, NotifyServiceError } from '../notify/service';
import type { NotificationChannel, NotificationMessage } from '../notify/port';
import { createWorkspace, db, type TestWorkspace } from '../../../../test/db-helpers';

/**
 * The missing-receipt loop against a real database (migration 0024), through
 * the four paths of a stateful flow: forward, backtrack and revise, resume
 * from what is stored, and re-entry after completion or failure. Run with
 * `pnpm test:db`. Every name and amount is invented.
 */

const HEADER = '"Booking Date","Value Date","Partner Name","Partner Iban",Type,"Payment Reference","Account Name","Amount (EUR)","Original Amount","Original Currency","Exchange Rate"';
const line = (day: string, partner: string, reference: string, amount: string, type = 'Presentment') => `${day},${day},"${partner}",,${type},"${reference}",Hauptkonto,${amount},,,`;
const file = (...lines: string[]) => [HEADER, ...lines].join('\n') + '\n';

const TODAY = '2026-05-20';
/** A moment long after any run, so every failed delivery is due for its retry. */
const later = (minutes: number) => new Date(Date.now() + minutes * 60_000);

/** A channel that records what it was asked to send and answers as told. */
function recorder(name: 'push' | 'email', answer: 'sent' | 'failed' | 'unavailable' = 'sent') {
  const sent: NotificationMessage[] = [];
  const channel: NotificationChannel = {
    name,
    async send(_r, message) {
      sent.push(message);
      return answer === 'sent' ? { status: 'sent' } : { status: answer, detail: 'test' };
    },
  };
  return { channel, sent };
}

async function setup(lines: string[]): Promise<{ ws: TestWorkspace; ctx: { workspaceId: string; tenantId: string }; ids: Map<string, string>; batchId: string }> {
  const ws = await createWorkspace();
  const ctx = { workspaceId: ws.workspaceId, tenantId: ws.tenantId };
  const accountId = await createAccount(db, ctx, { label: 'Girokonto', kind: 'bank' });
  const imported = await importPayments(db, ctx, accountId, file(...lines));
  const { payments } = await loadPayments(db, ctx.workspaceId);
  return { ws, ctx, ids: new Map(payments.map((p) => [p.counterparty, p.id])), batchId: imported.batchId };
}

const stateOf = async (workspaceId: string, paymentId: string) => {
  const o = await loadLoopOverview(db, workspaceId);
  return [...o.open, ...o.answered].find((c) => c.paymentId === paymentId)?.state.state ?? 'settled_or_not_needed';
};

const code = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    if (e instanceof LoopServiceError || e instanceof NotifyServiceError) return e.code;
    throw e;
  }
  return 'no error';
};

afterAll(async () => {
  await db.$disconnect();
});

describe('forward', () => {
  it('skips what needs no receipt, proposes a fitting receipt, notifies about a missing one, and settles on confirm', async () => {
    const { ws, ctx, ids } = await setup([
      line('2026-05-10', 'Zyx Handel', 'Bestellung 4711', '-29.99'),
      line('2026-05-12', 'Abc Laden', 'Einkauf', '-12.50'),
      line('2026-05-13', 'Beispielbank', 'Kreditrate 05/2026', '-250'),
      line('2026-05-14', '', 'Geldautomat Markt', '-100'),
    ]);
    await ws.addReceipt({ Name: 'Zyx Rechnung', Vendor: 'Zyx Handel GmbH', Gross: 29.99, Date: '2026-05-09', Currency: 'EUR', 'FX Rate': 1 });

    const overview = await loadLoopOverview(db, ctx.workspaceId);
    expect(overview.counts.notNeeded.loan).toBe(1);
    expect(overview.counts.notNeeded.cash).toBe(1);
    expect(overview.open.map((c) => [c.counterparty, c.state.state])).toEqual([
      ['Abc Laden', 'missing'],
      ['Zyx Handel', 'proposed'],
    ]);

    const push = recorder('push');
    const run = await runReceiptLoop(db, ctx, { today: TODAY, channels: [push.channel] });
    expect(run).toMatchObject({ notified: 1, open: 2 });
    expect(push.sent.map((m) => m.subjectKey)).toEqual([`missing_receipt:${ids.get('Abc Laden')}`]);
    expect(push.sent[0].path).toBe(`/app/spending?pruefen=${ids.get('Abc Laden')}`);

    const zyx = overview.open.find((c) => c.counterparty === 'Zyx Handel');
    const rowId = zyx?.state.state === 'proposed' ? zyx.state.candidates[0].rowId : '';
    await confirmCandidate(db, ctx, ids.get('Zyx Handel') as string, rowId);
    expect(await stateOf(ctx.workspaceId, ids.get('Zyx Handel') as string)).toBe('settled_or_not_needed');
    expect((await loadLoopOverview(db, ctx.workspaceId)).counts.hasReceipt).toBe(1);
  });

  it('falls back to e-mail when push cannot deliver, and keeps it in the app when nothing can', async () => {
    const { ctx } = await setup([line('2026-05-10', 'Abc Laden', 'Einkauf', '-12.50'), line('2026-05-11', 'Def Laden', 'Einkauf', '-5')]);
    const push = recorder('push', 'unavailable');
    const email = recorder('email');
    await saveNotifySettings(db, ctx, { channel: 'push', notifyEmail: 'owner@example.com' });
    await runReceiptLoop(db, ctx, { today: TODAY, channels: [push.channel, email.channel] });
    expect(email.sent).toHaveLength(2);
    const queue = await listUnreadNotifications(db, ctx.workspaceId);
    expect(queue.map((n) => n.channel)).toEqual(['email', 'email']);
  });
});

describe('backtrack and revise', () => {
  it('a "no receipt" answer settles the payment; taking it back opens it again without a second notification', async () => {
    const { ctx, ids } = await setup([line('2026-05-10', 'Abc Laden', 'Einkauf', '-12.50')]);
    const id = ids.get('Abc Laden') as string;
    const push = recorder('push');
    await runReceiptLoop(db, ctx, { today: TODAY, channels: [push.channel] });
    expect(await code(answerNoReceipt(db, ctx, id, '   '))).toBe('reason_required');
    await answerNoReceipt(db, ctx, id, 'Parkautomat ohne Beleg');
    expect(await stateOf(ctx.workspaceId, id)).toBe('no_receipt');
    expect(await listUnreadNotifications(db, ctx.workspaceId)).toEqual([]);

    await withdrawNoReceipt(db, ctx, id);
    expect(await stateOf(ctx.workspaceId, id)).toBe('missing');
    await runReceiptLoop(db, ctx, { today: TODAY, channels: [push.channel] });
    expect(push.sent).toHaveLength(1);
  });

  it('a payment re-labelled as an own transfer leaves the loop, and comes back when the label is taken back', async () => {
    const { ctx, ids } = await setup([line('2026-05-10', 'Abc Laden', 'Einkauf', '-12.50')]);
    const id = ids.get('Abc Laden') as string;
    await setPaymentKind(db, ctx, id, 'own_transfer');
    expect(await stateOf(ctx.workspaceId, id)).toBe('settled_or_not_needed');
    await setPaymentKind(db, ctx, id, null);
    expect(await stateOf(ctx.workspaceId, id)).toBe('missing');
  });

  it('a removed link opens the payment again, with the receipt proposed again', async () => {
    const { ws, ctx, ids } = await setup([line('2026-05-10', 'Zyx Handel', 'Bestellung', '-29.99')]);
    const rowId = await ws.addReceipt({ Name: 'Zyx Rechnung', Vendor: 'Zyx Handel', Gross: 29.99, Date: '2026-05-10', Currency: 'EUR', 'FX Rate': 1 });
    const id = ids.get('Zyx Handel') as string;
    await confirmCandidate(db, ctx, id, rowId);
    const { payments } = await loadPayments(db, ctx.workspaceId);
    await unlinkPayment(db, ctx, payments[0].links[0].id);
    expect(await stateOf(ctx.workspaceId, id)).toBe('proposed');
  });

  it('refuses to confirm a receipt that is not proposed for the payment', async () => {
    const { ws, ctx, ids } = await setup([line('2026-05-10', 'Zyx Handel', 'Bestellung', '-29.99')]);
    const other = await ws.addReceipt({ Name: 'Anderes', Vendor: 'Ganz Anders', Gross: 29.99, Date: '2026-05-10', Currency: 'EUR', 'FX Rate': 1 });
    expect(await code(confirmCandidate(db, ctx, ids.get('Zyx Handel') as string, other))).toBe('not_a_candidate');
  });
});

describe('resume from what is stored', () => {
  it('a second run, as after a restart, notifies nobody again and recomputes the same state', async () => {
    const { ctx } = await setup([line('2026-05-10', 'Abc Laden', 'Einkauf', '-12.50')]);
    const push = recorder('push');
    const first = await runReceiptLoop(db, ctx, { today: TODAY, channels: [push.channel] });
    const before = await loadLoopOverview(db, ctx.workspaceId);
    const second = await runReceiptLoop(db, ctx, { today: TODAY, channels: [push.channel] });
    expect(first.notified).toBe(1);
    expect(second.notified).toBe(0);
    expect(await loadLoopOverview(db, ctx.workspaceId)).toEqual(before);
  });

  it('notifies only about recent payments: a year of imported history sends no messages', async () => {
    const { ctx } = await setup([line('2025-03-10', 'Alt Laden', 'Einkauf', '-12.50')]);
    const push = recorder('push');
    const run = await runReceiptLoop(db, ctx, { today: TODAY, channels: [push.channel] });
    expect(run).toMatchObject({ notified: 0, open: 1 });
  });

  it('keeps the notification setting', async () => {
    const { ctx } = await setup([line('2026-05-10', 'Abc Laden', 'Einkauf', '-1')]);
    expect(await getNotifySettings(db, ctx.workspaceId)).toEqual({ channel: 'push', notifyEmail: null });
    await saveNotifySettings(db, ctx, { channel: 'email', notifyEmail: ' owner@example.com ' });
    expect(await getNotifySettings(db, ctx.workspaceId)).toEqual({ channel: 'email', notifyEmail: 'owner@example.com' });
    expect(await code(saveNotifySettings(db, ctx, { channel: 'fax' }))).toBe('invalid_channel');
    expect(await code(saveNotifySettings(db, ctx, { channel: 'email', notifyEmail: 'no-at-sign' }))).toBe('invalid_email');
  });
});

describe('re-entry after completion or failure', () => {
  it('a failed delivery is tried again on the next run, at most three times, then stays in the app', async () => {
    const { ctx } = await setup([line('2026-05-10', 'Abc Laden', 'Einkauf', '-12.50')]);
    const failing = recorder('push', 'failed');
    await runReceiptLoop(db, ctx, { today: TODAY, channels: [failing.channel] });
    // Not again right away: another run may be delivering it at this moment.
    expect((await runReceiptLoop(db, ctx, { today: TODAY, channels: [failing.channel] })).retried).toBe(0);
    expect((await runReceiptLoop(db, ctx, { today: TODAY, channels: [failing.channel], now: later(2) })).retried).toBe(1);
    expect((await runReceiptLoop(db, ctx, { today: TODAY, channels: [failing.channel], now: later(4) })).retried).toBe(1);
    expect((await runReceiptLoop(db, ctx, { today: TODAY, channels: [failing.channel], now: later(6) })).retried).toBe(0);
    expect(failing.sent).toHaveLength(3);
    const [queued] = await listUnreadNotifications(db, ctx.workspaceId);
    expect(queued).toMatchObject({ channel: null, failed: true });

    // Recovers once a channel works again within the limit.
    const { ctx: ctx2 } = await setup([line('2026-05-10', 'Abc Laden', 'Einkauf', '-12.50')]);
    await runReceiptLoop(db, ctx2, { today: TODAY, channels: [failing.channel] });
    const working = recorder('push');
    await runReceiptLoop(db, ctx2, { today: TODAY, channels: [working.channel], now: later(2) });
    expect((await listUnreadNotifications(db, ctx2.workspaceId))[0]).toMatchObject({ channel: 'push', failed: false });
  });

  it('a settled payment stays settled on every later run, and a read notification is not shown again', async () => {
    const { ctx, ids } = await setup([line('2026-05-10', 'Abc Laden', 'Einkauf', '-12.50')]);
    const push = recorder('push');
    await runReceiptLoop(db, ctx, { today: TODAY, channels: [push.channel] });
    const [n] = await listUnreadNotifications(db, ctx.workspaceId);
    await markNotificationRead(db, ctx, n.id);
    await markNotificationRead(db, ctx, n.id);
    expect(await code(markNotificationRead(db, ctx, 'no-such-id'))).toBe('notification_not_found');
    await answerNoReceipt(db, ctx, ids.get('Abc Laden') as string, 'Spende ohne Quittung');
    for (let i = 0; i < 2; i++) await runReceiptLoop(db, ctx, { today: TODAY, channels: [push.channel] });
    expect(push.sent).toHaveLength(1);
    expect(await stateOf(ctx.workspaceId, ids.get('Abc Laden') as string)).toBe('no_receipt');
  });
});

describe('more paths', () => {
  it('delivers on a later run what a run created but stopped before delivering', async () => {
    const { ctx, ids } = await setup([line('2026-05-10', 'Abc Laden', 'Einkauf', '-12.50')]);
    // What a crash between creating and delivering leaves behind.
    await db.spendingNotification.create({
      data: { authWorkspaceId: ctx.workspaceId, authTenantId: ctx.tenantId, subjectKey: `missing_receipt:${ids.get('Abc Laden')}`, kind: 'missing_receipt', title: 't', body: 'b', path: '/app/spending', failed: true },
    });
    const push = recorder('push');
    const run = await runReceiptLoop(db, ctx, { today: TODAY, channels: [push.channel], now: later(2) });
    expect(run).toMatchObject({ notified: 0, retried: 1 });
    expect(push.sent).toHaveLength(1);
    expect((await listUnreadNotifications(db, ctx.workspaceId))[0]).toMatchObject({ channel: 'push', failed: false });
  });

  it('takes the notification of a payment whose import was undone out of the queue, and never retries it', async () => {
    const { ctx, batchId } = await setup([line('2026-05-10', 'Abc Laden', 'Einkauf', '-12.50')]);
    const failing = recorder('push', 'failed');
    await runReceiptLoop(db, ctx, { today: TODAY, channels: [failing.channel] });
    await deleteImportBatch(db, ctx, batchId);
    const run = await runReceiptLoop(db, ctx, { today: TODAY, channels: [failing.channel], now: later(2) });
    expect(run).toMatchObject({ settled: 1, retried: 0, open: 0 });
    expect(await listUnreadNotifications(db, ctx.workspaceId)).toEqual([]);
    expect(failing.sent).toHaveLength(1);
  });

  it('retries to the address set now, after the owner changed it', async () => {
    const { ctx } = await setup([line('2026-05-10', 'Abc Laden', 'Einkauf', '-12.50')]);
    const seen: Array<string | null> = [];
    let answer: 'failed' | 'sent' = 'failed';
    const email: NotificationChannel = {
      name: 'email',
      async send(recipient) {
        seen.push(recipient.email);
        return answer === 'sent' ? { status: 'sent' } : { status: 'failed', detail: 'test' };
      },
    };
    await saveNotifySettings(db, ctx, { channel: 'email', notifyEmail: 'old@example.com' });
    await runReceiptLoop(db, ctx, { today: TODAY, channels: [email] });
    await saveNotifySettings(db, ctx, { channel: 'email', notifyEmail: 'new@example.com' });
    answer = 'sent';
    await runReceiptLoop(db, ctx, { today: TODAY, channels: [email], now: later(2) });
    expect(seen).toEqual(['old@example.com', 'new@example.com']);
  });

  it('keeps the newest reason when "no receipt" is answered twice, also at the same moment', async () => {
    const { ctx, ids } = await setup([line('2026-05-10', 'Abc Laden', 'Einkauf', '-12.50')]);
    const id = ids.get('Abc Laden') as string;
    await Promise.all([answerNoReceipt(db, ctx, id, 'erste'), answerNoReceipt(db, ctx, id, 'zweite')]);
    await answerNoReceipt(db, ctx, id, 'dritte');
    const [answered] = (await loadLoopOverview(db, ctx.workspaceId)).answered;
    expect(answered.state).toEqual({ state: 'no_receipt', reason: 'dritte' });
  });

  it('refuses to confirm a receipt a second time', async () => {
    const { ws, ctx, ids } = await setup([line('2026-05-10', 'Zyx Handel', 'Bestellung', '-29.99')]);
    const rowId = await ws.addReceipt({ Name: 'Zyx Rechnung', Vendor: 'Zyx Handel', Gross: 29.99, Date: '2026-05-10', Currency: 'EUR', 'FX Rate': 1 });
    await confirmCandidate(db, ctx, ids.get('Zyx Handel') as string, rowId);
    expect(await code(confirmCandidate(db, ctx, ids.get('Zyx Handel') as string, rowId))).toBe('not_a_candidate');
  });

  it('proposes a foreign-currency receipt by its estimate', async () => {
    const { ws, ctx, ids } = await setup([line('2026-05-10', 'Zyx Handel', 'Abo', '-18.70')]);
    const rowId = await ws.addReceipt({ Name: 'Zyx Abo', Vendor: 'Zyx Handel', Gross: 20, Date: '2026-05-09', Currency: 'USD', 'FX Rate': 0.92 });
    const check = (await loadLoopOverview(db, ctx.workspaceId)).open.find((c) => c.paymentId === ids.get('Zyx Handel'));
    expect(check?.state).toEqual({ state: 'proposed', candidates: [{ rowId, label: 'Zyx Abo', day: '2026-05-09', amountCents: 1840, estimated: true }] });
  });

  it('counts only payments not notified before towards the limit', async () => {
    const lines = Array.from({ length: MAX_SENDS_PER_RUN + 2 }, (_, i) => line(i < 5 ? '2026-05-08' : '2026-05-10', `Laden ${i + 1}`, 'Einkauf', `-${i + 1}`));
    const { ctx } = await setup(lines);
    const push = recorder('push');
    // The five older ones were notified about on an earlier day.
    await runReceiptLoop(db, ctx, { today: '2026-05-08', channels: [push.channel] });
    expect(push.sent).toHaveLength(5);
    expect(await runReceiptLoop(db, ctx, { today: TODAY, channels: [push.channel] })).toMatchObject({ notified: 7, deferred: 0 });
  });

  it('retries one notification once when two retry runs meet', async () => {
    const { ctx } = await setup([line('2026-05-10', 'Abc Laden', 'Einkauf', '-12.50')]);
    const failing = recorder('push', 'failed');
    await runReceiptLoop(db, ctx, { today: TODAY, channels: [failing.channel] });
    const retry = recorder('push');
    await Promise.all([
      runReceiptLoop(db, ctx, { today: TODAY, channels: [retry.channel], now: later(2) }),
      runReceiptLoop(db, ctx, { today: TODAY, channels: [retry.channel], now: later(2) }),
    ]);
    expect(retry.sent).toHaveLength(1);
  });

  it('sends one notification when two runs meet', async () => {
    const { ctx } = await setup([line('2026-05-10', 'Abc Laden', 'Einkauf', '-12.50')]);
    const push = recorder('push');
    await Promise.all([runReceiptLoop(db, ctx, { today: TODAY, channels: [push.channel] }), runReceiptLoop(db, ctx, { today: TODAY, channels: [push.channel] })]);
    expect(push.sent).toHaveLength(1);
  });

  it('sends a limited number per run and the rest on the next one', async () => {
    const lines = Array.from({ length: MAX_SENDS_PER_RUN + 2 }, (_, i) => line('2026-05-10', `Laden ${i + 1}`, 'Einkauf', `-${i + 1}`));
    const { ctx } = await setup(lines);
    const push = recorder('push');
    expect(await runReceiptLoop(db, ctx, { today: TODAY, channels: [push.channel] })).toMatchObject({ notified: MAX_SENDS_PER_RUN, deferred: 2 });
    expect(await runReceiptLoop(db, ctx, { today: TODAY, channels: [push.channel] })).toMatchObject({ notified: 2, deferred: 0 });
  });
});

describe('company separation', () => {
  it('never proposes another company\'s receipt, and never answers or notifies across companies', async () => {
    const a = await setup([line('2026-05-10', 'Zyx Handel', 'Bestellung', '-29.99')]);
    const b = await setup([line('2026-05-10', 'Zyx Handel', 'Bestellung', '-29.99')]);
    const rowOfB = await b.ws.addReceipt({ Name: 'Zyx Rechnung', Vendor: 'Zyx Handel', Gross: 29.99, Date: '2026-05-10', Currency: 'EUR', 'FX Rate': 1 });
    expect(await stateOf(a.ctx.workspaceId, a.ids.get('Zyx Handel') as string)).toBe('missing');
    expect(await stateOf(b.ctx.workspaceId, b.ids.get('Zyx Handel') as string)).toBe('proposed');
    expect(await code(confirmCandidate(db, a.ctx, a.ids.get('Zyx Handel') as string, rowOfB))).toBe('not_a_candidate');
    expect(await code(answerNoReceipt(db, a.ctx, b.ids.get('Zyx Handel') as string, 'fremd'))).toBe('payment_not_found');

    const push = recorder('push');
    await runReceiptLoop(db, a.ctx, { today: TODAY, channels: [push.channel] });
    expect(await listUnreadNotifications(db, b.ctx.workspaceId)).toEqual([]);
    const [n] = await listUnreadNotifications(db, a.ctx.workspaceId);
    expect(await code(markNotificationRead(db, b.ctx, n.id))).toBe('notification_not_found');
  });
});
