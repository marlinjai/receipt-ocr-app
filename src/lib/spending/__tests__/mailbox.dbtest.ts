import { afterAll, describe, expect, it } from 'vitest';
import { createAccount, deleteImportBatch, importPayments, loadPayments } from '@/lib/tax/payments/service';
import { linkReceiptToPayment, loadLoopOverview, runReceiptLoop } from '../loop-service';
import { dismissMailCandidate, findMailCandidate, MAX_SEARCH_TRIES } from '../mailbox/service';
import { listUnreadNotifications } from '../notify/service';
import { MailboxError, type MailCandidate, type MailboxPort, type MailSearch } from '../mailbox/port';
import type { NotificationChannel, NotificationMessage } from '../notify/port';
import { createWorkspace, db, type TestWorkspace } from '../../../../test/db-helpers';

/**
 * Step 3 of the missing-receipt loop (the expenses mailbox) against a real
 * database (migration 0028), with a mailbox made up for the test: forward,
 * backtrack and revise, resume, re-entry after failure, and company
 * separation. Run with `pnpm test:db`. Every name and address is invented.
 */

const HEADER = '"Booking Date","Value Date","Partner Name","Partner Iban",Type,"Payment Reference","Account Name","Amount (EUR)","Original Amount","Original Currency","Exchange Rate"';
const line = (day: string, partner: string, amount: string) => `${day},${day},"${partner}",,Presentment,"Einkauf",Hauptkonto,${amount},,,`;
const file = (...lines: string[]) => [HEADER, ...lines].join('\n') + '\n';
const TODAY = '2026-05-20';
const hoursLater = (h: number) => new Date(Date.now() + h * 3_600_000);

const mail = (o: Partial<MailCandidate> = {}): MailCandidate => ({ messageId: 'm1', partIndex: 0, fileName: 'Rechnung.pdf', mimeType: 'application/pdf', receivedDay: '2026-05-09', subject: 'Ihre Rechnung', from: 'billing@zyx.example', ...o });

/** A mailbox that answers from a list and records what it was asked. */
function mailbox(answer: (q: MailSearch) => MailCandidate[] | MailboxError) {
  const asked: MailSearch[] = [];
  const port: MailboxPort = {
    status: () => ({ configured: true }),
    async search(q) {
      asked.push(q);
      const a = answer(q);
      if (a instanceof MailboxError) throw a;
      return a;
    },
    async fetchAttachment() {
      throw new MailboxError('not_found');
    },
  };
  return { port, asked };
}

function recorder() {
  const sent: NotificationMessage[] = [];
  const channel: NotificationChannel = {
    name: 'push',
    async send(_r, m) {
      sent.push(m);
      return { status: 'sent' };
    },
  };
  return { channel, sent };
}

async function setup(lines: string[]): Promise<{ ws: TestWorkspace; ctx: { workspaceId: string; tenantId: string }; id: string; batchId: string }> {
  const ws = await createWorkspace();
  const ctx = { workspaceId: ws.workspaceId, tenantId: ws.tenantId };
  const accountId = await createAccount(db, ctx, { label: 'Girokonto', kind: 'bank' });
  const imported = await importPayments(db, ctx, accountId, file(...lines));
  const { payments } = await loadPayments(db, ctx.workspaceId);
  return { ws, ctx, id: payments[payments.length - 1].id, batchId: imported.batchId };
}

const candidateOf = async (workspaceId: string, id: string) => {
  const state = await stateOf(workspaceId, id);
  return state?.state === 'in_mailbox' ? state.mails[0].id : '';
};

const stateOf = async (workspaceId: string, id: string) => (await loadLoopOverview(db, workspaceId)).open.find((c) => c.paymentId === id)?.state;

afterAll(async () => {
  await db.$disconnect();
});

describe('forward', () => {
  it('finds the invoice in the mailbox, shows it, and notifies with the mailbox message', async () => {
    const { ctx, id } = await setup([line('2026-05-10', 'Zyx Handel', '-29.99')]);
    const box = mailbox(() => [mail(), mail({ partIndex: 1, fileName: 'Lieferschein.pdf' })]);
    // Another payment without a name: not searched.
    const push = recorder();
    const run = await runReceiptLoop(db, ctx, { today: TODAY, channels: [push.channel], mailbox: box.port });
    expect(run.mailbox).toEqual({ status: 'ok', searched: 1, found: 1 });
    expect(box.asked[0]).toMatchObject({ vendorWords: ['Zyx Handel', 'zyx handel'], amountCents: 2999, fromDay: '2026-04-26', toDay: '2026-05-13' });
    const state = await stateOf(ctx.workspaceId, id);
    expect(state?.state).toBe('in_mailbox');
    expect(state?.state === 'in_mailbox' && state.mails.map((m) => m.fileName)).toEqual(['Rechnung.pdf', 'Lieferschein.pdf']);
    expect(push.sent[0].title).toBe('Rechnung im Postfach: Zyx Handel');
  });

  it('once the attachment is a receipt, links it to the payment the owner took it over for, and settles the messages', async () => {
    const { ws, ctx, id } = await setup([line('2026-05-10', 'Zyx Handel', '-29.99')]);
    const push = recorder();
    await runReceiptLoop(db, ctx, { today: TODAY, mailbox: mailbox(() => [mail()]).port, channels: [push.channel] });
    // What the upload path makes of the attachment: here a reading whose vendor does not match the bank's name.
    const rowId = await ws.addReceipt({ Name: 'Rechnung', Vendor: 'ZH Services', Gross: 29.99, Date: '2026-05-09', Currency: 'EUR', 'FX Rate': 1 });
    await linkReceiptToPayment(db, ctx, id, rowId);
    expect(await stateOf(ctx.workspaceId, id)).toBeUndefined();
    expect(await listUnreadNotifications(db, ctx.workspaceId)).toEqual([]);
    // Linking again is fine; it is linked.
    await linkReceiptToPayment(db, ctx, id, rowId);
  });

  it('does nothing and says so when no mailbox is set up', async () => {
    const { ctx, id } = await setup([line('2026-05-10', 'Zyx Handel', '-29.99')]);
    const off: MailboxPort = { status: () => ({ configured: false, missing: ['SPENDING_MAILBOX_ADDRESS'] }), search: async () => [], fetchAttachment: async () => { throw new MailboxError('not_configured'); } };
    const run = await runReceiptLoop(db, ctx, { today: TODAY, mailbox: off, channels: [] });
    expect(run.mailbox).toEqual({ status: 'off', missing: ['SPENDING_MAILBOX_ADDRESS'] });
    expect((await stateOf(ctx.workspaceId, id))?.state).toBe('missing');
  });
});

describe('resume and re-entry', () => {
  it('searches a payment once when found, and again a day later while nothing was found, at most three times', async () => {
    const { ctx } = await setup([line('2026-05-10', 'Zyx Handel', '-29.99')]);
    const box = mailbox(() => []);
    await runReceiptLoop(db, ctx, { today: TODAY, mailbox: box.port, channels: [] });
    await runReceiptLoop(db, ctx, { today: TODAY, mailbox: box.port, channels: [] });
    expect(box.asked).toHaveLength(1);
    for (let i = 1; i <= 4; i++) await runReceiptLoop(db, ctx, { today: TODAY, mailbox: box.port, channels: [], now: hoursLater(25 * i) });
    expect(box.asked).toHaveLength(MAX_SEARCH_TRIES);

    const { ctx: found } = await setup([line('2026-05-10', 'Zyx Handel', '-29.99')]);
    const hit = mailbox(() => [mail()]);
    await runReceiptLoop(db, found, { today: TODAY, mailbox: hit.port, channels: [] });
    await runReceiptLoop(db, found, { today: TODAY, mailbox: hit.port, channels: [], now: hoursLater(30) });
    expect(hit.asked).toHaveLength(1);
  });

  it('stops at a revoked grant, reports it, uses up no try, and searches again on a later run', async () => {
    const { ctx } = await setup([line('2026-05-10', 'Zyx Handel', '-29.99'), line('2026-05-11', 'Abc Laden', '-5')]);
    const revoked = mailbox(() => new MailboxError('auth_failed'));
    const run = await runReceiptLoop(db, ctx, { today: TODAY, mailbox: revoked.port, channels: [] });
    expect(run.mailbox).toMatchObject({ status: 'error', code: 'auth_failed', searched: 0 });
    expect(revoked.asked).toHaveLength(1);
    // Days of failures burn nothing: once the grant works again, each payment still has all its tries.
    for (let day = 1; day <= 4; day++) await runReceiptLoop(db, ctx, { today: TODAY, mailbox: revoked.port, channels: [], now: hoursLater(25 * day) });
    const nothing = mailbox(() => []);
    for (let day = 5; day <= 8; day++) await runReceiptLoop(db, ctx, { today: TODAY, mailbox: nothing.port, channels: [], now: hoursLater(25 * day) });
    expect(nothing.asked.filter((q) => q.vendorWords[0] === 'Zyx Handel')).toHaveLength(MAX_SEARCH_TRIES);
  });

  it('two runs at the same moment do not fail each other', async () => {
    const { ctx } = await setup([line('2026-05-10', 'Zyx Handel', '-29.99')]);
    const box = mailbox(() => [mail()]);
    const [a, b] = await Promise.all([
      runReceiptLoop(db, ctx, { today: TODAY, mailbox: box.port, channels: [] }),
      runReceiptLoop(db, ctx, { today: TODAY, mailbox: box.port, channels: [] }),
    ]);
    expect(a.mailbox.status).toBe('ok');
    expect(b.mailbox.status).toBe('ok');
  });

  it('never searches history or payments that need no receipt', async () => {
    const { ctx } = await setup([line('2025-01-10', 'Alt Laden', '-5'), line('2026-05-10', '', '-100')]);
    const box = mailbox(() => []);
    await runReceiptLoop(db, ctx, { today: TODAY, mailbox: box.port, channels: [] });
    // The old payment is outside the two weeks; the nameless one is not searched (an amount alone finds any mail).
    expect(box.asked).toEqual([]);
  });
});

describe('backtrack and revise', () => {
  it('"not the invoice" sets the mail aside for good and lets a later search find another', async () => {
    const { ctx, id } = await setup([line('2026-05-10', 'Zyx Handel', '-29.99')]);
    let answer = [mail()];
    const box = mailbox(() => answer);
    await runReceiptLoop(db, ctx, { today: TODAY, mailbox: box.port, channels: [] });
    await dismissMailCandidate(db, ctx, await candidateOf(ctx.workspaceId, id));
    expect((await stateOf(ctx.workspaceId, id))?.state).toBe('missing');
    // The same mail found again stays aside; a new one is offered.
    await runReceiptLoop(db, ctx, { today: TODAY, mailbox: box.port, channels: [], now: hoursLater(25) });
    expect((await stateOf(ctx.workspaceId, id))?.state).toBe('missing');
    answer = [mail(), mail({ messageId: 'm2', fileName: 'Rechnung-richtig.pdf' })];
    await runReceiptLoop(db, ctx, { today: TODAY, mailbox: box.port, channels: [], now: hoursLater(50) });
    const state = await stateOf(ctx.workspaceId, id);
    expect(state?.state === 'in_mailbox' && state.mails.map((m) => m.fileName)).toEqual(['Rechnung-richtig.pdf']);
  });

  it('a find made on a later search gets its own message after the "receipt missing" one', async () => {
    const { ctx } = await setup([line('2026-05-10', 'Zyx Handel', '-29.99')]);
    let answer: ReturnType<typeof mail>[] = [];
    const box = mailbox(() => answer);
    const push = recorder();
    await runReceiptLoop(db, ctx, { today: TODAY, mailbox: box.port, channels: [push.channel] });
    answer = [mail()];
    await runReceiptLoop(db, ctx, { today: TODAY, mailbox: box.port, channels: [push.channel], now: hoursLater(25) });
    expect(push.sent.map((m) => m.title)).toEqual(['Beleg fehlt: Zyx Handel', 'Rechnung im Postfach: Zyx Handel']);
  });

  it('finds of a payment whose import was undone go with it', async () => {
    const { ctx, batchId } = await setup([line('2026-05-10', 'Zyx Handel', '-29.99')]);
    await runReceiptLoop(db, ctx, { today: TODAY, mailbox: mailbox(() => [mail()]).port, channels: [] });
    await deleteImportBatch(db, ctx, batchId);
    await runReceiptLoop(db, ctx, { today: TODAY, mailbox: mailbox(() => []).port, channels: [] });
    expect(await db.spendingMailCandidate.count({ where: { authWorkspaceId: ctx.workspaceId } })).toBe(0);
    expect(await db.spendingMailSearch.count({ where: { authWorkspaceId: ctx.workspaceId } })).toBe(0);
  });
});

describe('company separation', () => {
  it("a found attachment belongs to one company: the other never sees or reaches it", async () => {
    const a = await setup([line('2026-05-10', 'Zyx Handel', '-29.99')]);
    const b = await setup([line('2026-05-10', 'Zyx Handel', '-29.99')]);
    await runReceiptLoop(db, a.ctx, { today: TODAY, mailbox: mailbox(() => [mail()]).port, channels: [] });
    const state = await stateOf(a.ctx.workspaceId, a.id);
    const candidateId = state?.state === 'in_mailbox' ? state.mails[0].id : '';
    expect(await findMailCandidate(db, a.ctx.workspaceId, candidateId)).not.toBeNull();
    expect(await findMailCandidate(db, b.ctx.workspaceId, candidateId)).toBeNull();
    await expect(dismissMailCandidate(db, b.ctx, candidateId)).rejects.toMatchObject({ code: 'candidate_not_found' });
    expect((await stateOf(b.ctx.workspaceId, b.id))?.state).toBe('missing');
  });
});
