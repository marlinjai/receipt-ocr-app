import { afterAll, describe, expect, it } from 'vitest';
import { createAccount, importPayments, loadPayments, setCounterpartyTreatment } from '@/lib/tax/payments/service';
import { loadLoopOverview, runReceiptLoop, settleAfterOwnNames } from '../loop-service';
import { listUnreadNotifications } from '../notify/service';
import type { NotificationChannel, NotificationMessage } from '../notify/port';
import { SpendingServiceError, loadOwnNames, loadSpending, saveOwnNames } from '../service';
import { loadBudgets } from '../budget-service';
import { createWorkspace, db } from '../../../../test/db-helpers';

/**
 * The owner's own names against a real database (migration 0037), through the
 * four paths: forward, backtrack and revise, resume from what is stored, and
 * re-entry. Run with `pnpm test:db`. Every name and amount is invented.
 */

const HEADER = '"Booking Date","Value Date","Partner Name","Partner Iban",Type,"Payment Reference","Account Name","Amount (EUR)","Original Amount","Original Currency","Exchange Rate"';
const line = (day: string, partner: string, reference: string, amount: string, type = 'Presentment') => `${day},${day},"${partner}",,${type},"${reference}",Hauptkonto,${amount},,,`;
const file = (...lines: string[]) => [HEADER, ...lines].join('\n') + '\n';

const TODAY = '2026-10-23';
const LINES = [
  line('2026-10-20', 'Erika Beispiel', 'Main Account - Rainy Day Fund', '-500', 'Debit Transfer'),
  line('2026-10-21', 'BEISPIEL ERIKA', 'Sparen', '-250', 'Debit Transfer'),
  line('2026-10-22', 'Zyx Handel', 'Bestellung', '-30'),
];

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

async function setup() {
  const ws = await createWorkspace();
  const ctx = { workspaceId: ws.workspaceId, tenantId: ws.tenantId };
  const accountId = await createAccount(db, ctx, { label: 'Girokonto', kind: 'bank' });
  await importPayments(db, ctx, accountId, file(...LINES));
  const { payments } = await loadPayments(db, ctx.workspaceId);
  return { ctx, accountId, ids: new Map(payments.map((p) => [p.counterparty, p.id])) };
}

const openIds = async (workspaceId: string) => (await loadLoopOverview(db, workspaceId)).open.map((c) => c.counterparty).sort();

afterAll(async () => {
  await db.$disconnect();
});

describe('own names', () => {
  it('forward: payments to the own name stop counting and asking, and their open messages are settled as own account', async () => {
    const { ctx } = await setup();
    const push = recorder();
    // Before the name: the transfers to oneself are unclear spending and ask for a receipt.
    await runReceiptLoop(db, ctx, { today: TODAY, channels: [push.channel] });
    expect(push.sent.map((m) => m.title).sort()).toEqual(['Beleg fehlt: BEISPIEL ERIKA', 'Beleg fehlt: Erika Beispiel', 'Beleg fehlt: Zyx Handel']);
    expect((await loadSpending(db, ctx.workspaceId, 2026, null)).overview.totalCents).toBe(78_000);

    expect(await saveOwnNames(db, ctx, { add: 'Erika Beispiel' })).toEqual(['Erika Beispiel']);
    const view = await loadSpending(db, ctx.workspaceId, 2026, null);
    expect(view.overview.totalCents).toBe(3000);
    expect(view.overview.unclear.map((u) => u.counterparty)).toEqual(['Zyx Handel']);
    expect(view.overview.ownTransfers.byName).toEqual({ cents: 75_000, count: 2 });
    expect(view.ownAccounts.map((o) => [o.label, o.byName]).sort()).toEqual([
      ['BEISPIEL ERIKA', true],
      ['Erika Beispiel', true],
    ]);
    expect(await openIds(ctx.workspaceId)).toEqual(['Zyx Handel']);

    // The next run settles the two messages and says why; nothing new is sent.
    const run = await runReceiptLoop(db, ctx, { today: TODAY, channels: [push.channel] });
    expect(run).toMatchObject({ notified: 0, settled: 2, settledOwnName: 2, open: 1 });
    expect((await listUnreadNotifications(db, ctx.workspaceId)).map((n) => n.title)).toEqual(['Beleg fehlt: Zyx Handel']);
    expect(push.sent).toHaveLength(3);
  });

  it('forward, as the page does it: saving a name settles its messages at once and counts them', async () => {
    const { ctx } = await setup();
    const push = recorder();
    await runReceiptLoop(db, ctx, { today: TODAY, channels: [push.channel] });
    await saveOwnNames(db, ctx, { add: 'Beispiel, Erika' });
    expect(await settleAfterOwnNames(db, ctx.workspaceId)).toBe(2);
    expect((await listUnreadNotifications(db, ctx.workspaceId)).map((n) => n.title)).toEqual(['Beleg fehlt: Zyx Handel']);
    // Nothing left for the loop to settle, and nothing sent.
    expect(await runReceiptLoop(db, ctx, { today: TODAY, channels: [push.channel] })).toMatchObject({ notified: 0, settled: 0, settledOwnName: 0 });
    expect(push.sent).toHaveLength(3);
  });

  it('backtrack: a name taken out brings its payments back, asked about again without a second message; an answer of the payments tab wins', async () => {
    const { ctx } = await setup();
    const push = recorder();
    await runReceiptLoop(db, ctx, { today: TODAY, channels: [push.channel] });
    await saveOwnNames(db, ctx, { add: 'Erika Beispiel' });
    await settleAfterOwnNames(db, ctx.workspaceId);
    expect(await openIds(ctx.workspaceId)).toEqual(['Zyx Handel']);

    await saveOwnNames(db, ctx, { remove: 'Erika Beispiel' });
    expect((await loadSpending(db, ctx.workspaceId, 2026, null)).overview.totalCents).toBe(78_000);
    expect(await openIds(ctx.workspaceId)).toEqual(['BEISPIEL ERIKA', 'Erika Beispiel', 'Zyx Handel']);
    await runReceiptLoop(db, ctx, { today: TODAY, channels: [push.channel] });
    expect(push.sent).toHaveLength(3);

    // An explicit answer overrides the names both ways: "private" keeps one spelling as spending ...
    await saveOwnNames(db, ctx, { add: 'Erika Beispiel' });
    await setCounterpartyTreatment(db, ctx, { counterparty: 'BEISPIEL ERIKA', treatment: 'private' });
    const view = await loadSpending(db, ctx.workspaceId, 2026, null);
    expect(view.overview.totalCents).toBe(28_000);
    expect(view.ownAccounts.map((o) => o.label)).toEqual(['Erika Beispiel']);
    // ... and an own-account answer stays one without the name, then with a take-back button.
    await setCounterpartyTreatment(db, ctx, { counterparty: 'Erika Beispiel', treatment: 'own_account' });
    await saveOwnNames(db, ctx, { remove: 'Erika Beispiel' });
    expect((await loadSpending(db, ctx.workspaceId, 2026, null)).ownAccounts).toEqual([{ counterpartyKey: 'erika beispiel', label: 'Erika Beispiel', byName: false }]);
  });

  it('resume: the names are kept per company and read back after a restart', async () => {
    const { ctx } = await setup();
    const other = await setup();
    await saveOwnNames(db, ctx, { add: '  Erika Beispiel ' });
    // A second spelling of a listed name is refused, so the page can say so.
    await expect(saveOwnNames(db, ctx, { add: 'Beispiel, Erika' })).rejects.toMatchObject({ code: 'name_listed' });
    await saveOwnNames(db, ctx, { add: 'Erika M. Beispiel' });
    expect(await loadOwnNames(db, ctx.workspaceId)).toEqual(['Erika Beispiel', 'Erika M. Beispiel']);
    expect((await loadSpending(db, ctx.workspaceId, 2026, null)).ownNames).toEqual(['Erika Beispiel', 'Erika M. Beispiel']);
    // Never in another company.
    expect(await loadOwnNames(db, other.ctx.workspaceId)).toEqual([]);
    expect((await loadSpending(db, other.ctx.workspaceId, 2026, null)).overview.totalCents).toBe(78_000);
    // A company in the owner's name is another legal person, never an own account.
    expect((await loadSpending(db, ctx.workspaceId, 2026, null)).overview.ownTransfers.byName.count).toBe(2);
    // A name with nothing to match on is refused and changes nothing.
    await expect(saveOwnNames(db, ctx, { add: '-' })).rejects.toBeInstanceOf(SpendingServiceError);
    await expect(saveOwnNames(db, ctx, ['Erika'])).rejects.toMatchObject({ code: 'invalid_names' });
    // Two pages changing the list never undo each other: each change applies to the list as stored.
    await Promise.all([saveOwnNames(db, other.ctx, { add: 'Erika Beispiel' }), saveOwnNames(db, other.ctx, { add: 'Max Beispiel' }), saveOwnNames(db, other.ctx, { add: 'Eva Beispiel' })]);
    expect((await loadOwnNames(db, other.ctx.workspaceId)).sort()).toEqual(['Erika Beispiel', 'Eva Beispiel', 'Max Beispiel']);
    await Promise.all([saveOwnNames(db, other.ctx, { remove: 'Eva Beispiel' }), saveOwnNames(db, other.ctx, { remove: 'Max Beispiel' })]);
    expect(await loadOwnNames(db, other.ctx.workspaceId)).toEqual(['Erika Beispiel']);
    expect(await loadOwnNames(db, ctx.workspaceId)).toEqual(['Erika Beispiel', 'Erika M. Beispiel']);
  });

  it('re-entry: saving the same names again, or a second run, changes nothing and sends nothing', async () => {
    const { ctx, accountId } = await setup();
    const push = recorder();
    await saveOwnNames(db, ctx, { add: 'Erika Beispiel' });
    await runReceiptLoop(db, ctx, { today: TODAY, channels: [push.channel] });
    expect(push.sent.map((m) => m.title)).toEqual(['Beleg fehlt: Zyx Handel']);
    // The same name a second time changes nothing.
    await expect(saveOwnNames(db, ctx, { add: 'Erika Beispiel' })).rejects.toMatchObject({ code: 'name_listed' });
    expect(await loadOwnNames(db, ctx.workspaceId)).toEqual(['Erika Beispiel']);
    const again = await runReceiptLoop(db, ctx, { today: TODAY, channels: [push.channel] });
    expect(again).toMatchObject({ notified: 0, settled: 0, settledOwnName: 0 });
    // The same file imported a second time is refused: no payment and no message more.
    await expect(importPayments(db, ctx, accountId, file(...LINES))).rejects.toMatchObject({ code: 'file_already_imported' });
    expect((await loadPayments(db, ctx.workspaceId)).payments).toHaveLength(3);
    await runReceiptLoop(db, ctx, { today: TODAY, channels: [push.channel] });
    expect(push.sent).toHaveLength(1);
    // The budgets count no own transfer either.
    expect((await loadBudgets(db, ctx.workspaceId, TODAY)).find((l) => l.key === 'unclear')?.spentCents).toBe(3000);
  });
});
