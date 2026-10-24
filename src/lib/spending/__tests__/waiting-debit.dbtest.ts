import { afterAll, describe, expect, it } from 'vitest';
import { createAccount, deleteImportBatch, importPayments, loadPayments, setPaymentKind } from '@/lib/tax/payments/service';
import { loadLoopOverview, runReceiptLoop } from '../loop-service';
import { listUnreadNotifications } from '../notify/service';
import type { NotificationChannel, NotificationMessage } from '../notify/port';
import { loadSpending } from '../service';
import { createWorkspace, db } from '../../../../test/db-helpers';

/**
 * A pay-later collection after the end of the imported list waits for the
 * next list (plan docs/plans/2026-10-23-budget-overview.md, decision 2), against
 * a real database, through the four paths. Run with `pnpm test:db`. Every name
 * and amount is invented.
 */

const HEADER = '"Booking Date","Value Date","Partner Name","Partner Iban",Type,"Payment Reference","Account Name","Amount (EUR)","Original Amount","Original Currency","Exchange Rate"';
const line = (day: string, partner: string, reference: string, amount: string, type = 'Presentment') => `${day},${day},"${partner}",,${type},"${reference}",Hauptkonto,${amount},,,`;
const file = (...lines: string[]) => [HEADER, ...lines].join('\n') + '\n';
const LATER_HEADER = 'created_date,created_time,activated,settled,amount,currency,merchant,items,payment_method,status,payment_reference,statement_number,category,purchase_type,card,source,timezone';
const later = (day: string, merchant: string, amount: string, reference: string) =>
  [day, '09:30', `${day} 09:31`, '', amount, 'EUR', `"${merchant}"`, `"${merchant} Bestellung"`, 'Invoice', '"Normal"', reference, `ORDER${reference}`, '', '', '', 'beispiel-quelle', 'Europe/Berlin'].join(',');
const laterFile = (...lines: string[]) => [LATER_HEADER, ...lines].join('\n') + '\n';

const TODAY = '2026-10-24';

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
  const bankId = await createAccount(db, ctx, { label: 'Girokonto', kind: 'bank' });
  const laterId = await createAccount(db, ctx, { label: 'Später zahlen', kind: 'payment_service' });
  // The list ends on 30.09; the collection of 23.10 pays purchases the list does not hold yet.
  await importPayments(db, ctx, laterId, laterFile(later('2026-09-10', 'Kiosk Beispiel', '20.00', '6000000000001'), later('2026-09-30', 'Laden Beispiel', '30.00', '6000000000002')));
  await importPayments(db, ctx, bankId, file(line('2026-10-23', 'Klarna Bank AB (publ)', 'Klarna Sammelzahlung', '-1261.69', 'Direct Debit'), line('2026-10-20', 'Zyx Handel', 'Bestellung', '-30')));
  const { payments } = await loadPayments(db, ctx.workspaceId);
  return { ctx, laterId, debitId: payments.find((p) => p.amountCents === -126_169)?.id as string };
}

afterAll(async () => {
  await db.$disconnect();
});

describe('a collective debit after the end of its list', () => {
  it('forward: is no spending, asks for no receipt, and is named as waiting for the next list', async () => {
    const { ctx } = await setup();
    const view = await loadSpending(db, ctx.workspaceId, 2026, 10);
    expect(view.overview.totalCents).toBe(3000);
    expect(view.overview.waitingDebits).toEqual([{ service: 'klarna', cents: 126_169, count: 1 }]);
    expect(view.overview.unclear.map((u) => u.counterparty)).toEqual(['Zyx Handel']);
    const push = recorder();
    await runReceiptLoop(db, ctx, { today: TODAY, channels: [push.channel] });
    expect(push.sent.map((m) => m.title)).toEqual(['Beleg fehlt: Zyx Handel']);
  });

  it('backtrack: the next list covers its day and the debit is an ordinary collection; undoing that import makes it wait again', async () => {
    const { ctx, laterId } = await setup();
    const next = await importPayments(db, ctx, laterId, laterFile(later('2026-10-22', 'Werkstatt Beispiel', '1261.69', '6000000000003'), later('2026-10-25', 'Kiosk Beispiel', '5.00', '6000000000004')));
    const covered = await loadSpending(db, ctx.workspaceId, 2026, 10);
    expect(covered.overview.waitingDebits).toEqual([]);
    expect(covered.overview.ownTransfers.count).toBe(1);
    await deleteImportBatch(db, ctx, next.batchId);
    expect((await loadSpending(db, ctx.workspaceId, 2026, 10)).overview.waitingDebits).toEqual([{ service: 'klarna', cents: 126_169, count: 1 }]);
  });

  it('backtrack: a person who says what the debit is overrules the rule, and the debit stops waiting', async () => {
    const { ctx, debitId } = await setup();
    await setPaymentKind(db, ctx, debitId, 'spend');
    const view = await loadSpending(db, ctx.workspaceId, 2026, 10);
    expect(view.overview.waitingDebits).toEqual([]);
    expect(view.overview.totalCents).toBe(3000 + 126_169);
    expect((await loadLoopOverview(db, ctx.workspaceId)).open.map((c) => c.counterparty).sort()).toEqual(['Klarna Bank AB (publ)', 'Zyx Handel']);
    await setPaymentKind(db, ctx, debitId, null);
    expect((await loadSpending(db, ctx.workspaceId, 2026, 10)).overview.waitingDebits).toHaveLength(1);
  });

  it('forward, as on production: a debit already asked about starts waiting once the list is imported, and its message is settled', async () => {
    const ws = await createWorkspace();
    const ctx = { workspaceId: ws.workspaceId, tenantId: ws.tenantId };
    const bankId = await createAccount(db, ctx, { label: 'Girokonto', kind: 'bank' });
    const laterId = await createAccount(db, ctx, { label: 'Später zahlen', kind: 'payment_service' });
    await importPayments(db, ctx, bankId, file(line('2026-10-23', 'Klarna Bank AB (publ)', 'Klarna Sammelzahlung', '-1261.69', 'Direct Debit')));
    const push = recorder();
    await runReceiptLoop(db, ctx, { today: TODAY, channels: [push.channel] });
    expect(push.sent.map((m) => m.title)).toEqual(['Beleg fehlt: Klarna Bank AB (publ)']);
    await importPayments(db, ctx, laterId, laterFile(later('2026-09-10', 'Kiosk Beispiel', '20.00', '6100000000001'), later('2026-09-30', 'Laden Beispiel', '30.00', '6100000000002')));
    const run = await runReceiptLoop(db, ctx, { today: TODAY, channels: [push.channel] });
    expect(run).toMatchObject({ notified: 0, settled: 1, open: 0 });
    expect(await listUnreadNotifications(db, ctx.workspaceId)).toEqual([]);
  });

  it('waits at most 60 days after the list: a later debit is asked about again', async () => {
    const { ctx } = await setup();
    const { payments } = await loadPayments(db, ctx.workspaceId);
    const bankId = payments.find((p) => p.amountCents === -126_169)?.accountId as string;
    await importPayments(db, ctx, bankId, file(line('2026-12-01', 'Klarna Bank AB (publ)', 'Klarna Sammelzahlung', '-80.00', 'Direct Debit')));
    const view = await loadSpending(db, ctx.workspaceId, 2026, 12);
    expect(view.overview.waitingDebits).toEqual([]);
    expect(view.overview.unclear.map((u) => u.counterparty)).toEqual(['Klarna Bank AB (publ)']);
  });

  it('resume and re-entry: read again it is the same, and a second run of the loop sends nothing', async () => {
    const { ctx } = await setup();
    const push = recorder();
    await runReceiptLoop(db, ctx, { today: TODAY, channels: [push.channel] });
    const again = await runReceiptLoop(db, ctx, { today: TODAY, channels: [push.channel] });
    expect(again).toMatchObject({ notified: 0 });
    expect(push.sent).toHaveLength(1);
    expect((await loadSpending(db, ctx.workspaceId, 2026, null)).overview.waitingDebits).toEqual([{ service: 'klarna', cents: 126_169, count: 1 }]);
  });
});
