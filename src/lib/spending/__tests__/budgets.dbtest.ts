import { afterAll, describe, expect, it } from 'vitest';
import { createAccount, importPayments, linkPayment, loadPayments, setAccountPrivate, setCounterpartyTreatment } from '@/lib/tax/payments/service';
import { receiptForLink } from '@/lib/tax/service';
import { loadSpending } from '../service';
import { BudgetServiceError, MAX_WARNINGS_PER_RUN, loadBudgets, loadBudgetsView, runBudgetWarnings, saveBudget } from '../budget-service';
import { runSpendingChecks } from '../checks';
import { listUnreadNotifications } from '../notify/service';
import type { NotificationChannel, NotificationMessage } from '../notify/port';
import { createWorkspace, db, type TestWorkspace } from '../../../../test/db-helpers';

/**
 * Budgets against a real database (migration 0027), on the four paths of a
 * stateful flow and across companies. Run with `pnpm test:db`. Every name and
 * amount is invented.
 */

const HEADER = '"Booking Date","Value Date","Partner Name","Partner Iban",Type,"Payment Reference","Account Name","Amount (EUR)","Original Amount","Original Currency","Exchange Rate"';
const line = (day: string, partner: string, amount: string) => `${day},${day},"${partner}",,Presentment,"Einkauf",Hauptkonto,${amount},,,`;
const file = (...lines: string[]) => [HEADER, ...lines].join('\n') + '\n';

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

/** Two full months of history at 200 euros of groceries each (booked on the 20th), and `march` this month. */
async function company(march: string[]): Promise<{ workspaceId: string; tenantId: string; accountId: string; ws: TestWorkspace }> {
  const ws = await createWorkspace();
  const ctx = { workspaceId: ws.workspaceId, tenantId: ws.tenantId };
  const accountId = await createAccount(db, ctx, { label: 'Girokonto', kind: 'bank' });
  await importPayments(db, ctx, accountId, file(line('2026-01-01', 'Bank Beispiel', '-1'), line('2026-01-20', 'REWE Markt', '-200'), line('2026-02-20', 'REWE Markt', '-200'), ...march));
  return { ...ctx, accountId, ws };
}

const code = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    if (e instanceof BudgetServiceError) return e.code;
    throw e;
  }
  return 'no error';
};

const groceries = async (workspaceId: string, today: string) => (await loadBudgets(db, workspaceId, today)).find((l) => l.key === 'groceries_drugstore');

afterAll(async () => {
  await db.$disconnect();
});

describe('forward', () => {
  it('takes the average as the default and warns once when it is passed', async () => {
    const ctx = await company([line('2026-03-03', 'REWE Markt', '-250')]);
    expect(await groceries(ctx.workspaceId, '2026-03-05')).toMatchObject({ limitCents: 20_000, basis: 'average', averageMonths: 2, spentCents: 25_000, level: 'passed' });
    const push = recorder();
    expect(await runBudgetWarnings(db, ctx, { today: '2026-03-05', channels: [push.channel] })).toMatchObject({ sent: 1, deferred: 0 });
    expect(push.sent[0]).toMatchObject({ kind: 'budget', subjectKey: 'budget:category:groceries_drugstore:2026-03:passed:avg', path: `/app/spending?firma=${encodeURIComponent(ctx.workspaceId)}#budgets` });
    expect(push.sent[0].body).toContain('März 2026');
  });

  it('warns "on pace" first and "passed" once more later in the month', async () => {
    const ctx = await company([line('2026-03-02', 'REWE Markt', '-100')]);
    const push = recorder();
    // Day 10: 100 spent, and earlier months spent their 200 after day 10: about 300 at the end.
    await runBudgetWarnings(db, ctx, { today: '2026-03-10', channels: [push.channel] });
    expect(push.sent.map((m) => m.subjectKey)).toEqual(['budget:category:groceries_drugstore:2026-03:on_pace:avg']);
    await importPayments(db, ctx, ctx.accountId, file(line('2026-03-12', 'REWE Markt', '-150')));
    await runBudgetWarnings(db, ctx, { today: '2026-03-12', channels: [push.channel] });
    expect(push.sent.map((m) => m.subjectKey)).toEqual(['budget:category:groceries_drugstore:2026-03:on_pace:avg', 'budget:category:groceries_drugstore:2026-03:passed:avg']);
    // The "on pace" message leaves the in-app list once "passed" replaces it.
    expect((await listUnreadNotifications(db, ctx.workspaceId)).map((n) => n.subjectKey)).toEqual(['budget:category:groceries_drugstore:2026-03:passed:avg']);
  });

  it('runs with the missing-receipt loop as one check', async () => {
    const ctx = await company([line('2026-03-03', 'REWE Markt', '-250')]);
    const push = recorder();
    const result = await runSpendingChecks(db, ctx, { today: '2026-03-05', channels: [push.channel] });
    expect(result.budgets).toMatchObject({ sent: 1 });
    // The receipts of 3 March and 20 February are missing, both within the last two weeks.
    expect(result.loop).toMatchObject({ notified: 2 });
  });

  it('sends a limited number of warnings per run and the rest on the next one', async () => {
    const shops = ['Netflix', 'Lieferando', 'IKEA', 'Deutsche Bahn', 'Hetzner Online', 'Stadtwerke Beispiel', 'Rossmann'];
    const ctx = await company(shops.map((s) => line('2026-03-03', s, '-50')));
    for (const [i, s] of shops.entries()) await saveBudget(db, ctx, { scope: 'vendor', label: s, limitCents: 1000 + i });
    const push = recorder();
    expect(await runBudgetWarnings(db, ctx, { today: '2026-03-05', channels: [push.channel] })).toMatchObject({ sent: MAX_WARNINGS_PER_RUN, deferred: shops.length - MAX_WARNINGS_PER_RUN });
    expect(await runBudgetWarnings(db, ctx, { today: '2026-03-05', channels: [push.channel] })).toMatchObject({ sent: shops.length - MAX_WARNINGS_PER_RUN, deferred: 0 });
  });
});

describe('backtrack and revise', () => {
  it('a limit the owner sets replaces the average, switching off silences it, and a reset brings the average back', async () => {
    const ctx = await company([line('2026-03-03', 'REWE Markt', '-250')]);
    await saveBudget(db, ctx, { scope: 'category', key: 'groceries_drugstore', limitCents: 60_000 });
    expect(await groceries(ctx.workspaceId, '2026-03-05')).toMatchObject({ limitCents: 60_000, basis: 'set', averageCents: 20_000, level: 'ok' });
    await saveBudget(db, ctx, { scope: 'category', key: 'groceries_drugstore', limitCents: null });
    expect(await groceries(ctx.workspaceId, '2026-03-05')).toMatchObject({ limitCents: null, basis: 'off' });
    const push = recorder();
    expect((await runBudgetWarnings(db, ctx, { today: '2026-03-05', channels: [push.channel] })).sent).toBe(0);
    await saveBudget(db, ctx, { scope: 'category', key: 'groceries_drugstore', reset: true });
    expect(await groceries(ctx.workspaceId, '2026-03-05')).toMatchObject({ limitCents: 20_000, basis: 'average' });
  });

  it('a raised limit clears the warning; a lowered one that is passed warns again', async () => {
    const ctx = await company([line('2026-03-03', 'REWE Markt', '-250')]);
    const push = recorder();
    await runBudgetWarnings(db, ctx, { today: '2026-03-05', channels: [push.channel] });
    await saveBudget(db, ctx, { scope: 'category', key: 'groceries_drugstore', limitCents: 90_000 });
    expect(await runBudgetWarnings(db, ctx, { today: '2026-03-05', channels: [push.channel] })).toMatchObject({ sent: 0, settled: 1 });
    expect((await listUnreadNotifications(db, ctx.workspaceId)).filter((n) => n.kind === 'budget')).toEqual([]);
    await saveBudget(db, ctx, { scope: 'category', key: 'groceries_drugstore', limitCents: 24_000 });
    expect((await runBudgetWarnings(db, ctx, { today: '2026-03-05', channels: [push.channel] })).sent).toBe(1);
    expect(push.sent.map((m) => m.subjectKey)).toEqual(['budget:category:groceries_drugstore:2026-03:passed:avg', 'budget:category:groceries_drugstore:2026-03:passed:24000']);
  });

  it('a counterparty answered as business leaves every budget', async () => {
    const ctx = await company([line('2026-03-03', 'REWE Markt', '-250')]);
    await setCounterpartyTreatment(db, ctx, { counterparty: 'REWE Markt', treatment: 'business' });
    expect(await groceries(ctx.workspaceId, '2026-03-05')).toBeUndefined();
  });

  it('refuses a wrong scope, key, name or amount', async () => {
    const ctx = await company([]);
    expect(await code(saveBudget(db, ctx, { scope: 'year', key: 'cash', limitCents: 1 }))).toBe('invalid_scope');
    expect(await code(saveBudget(db, ctx, { scope: 'category', key: 'transfers', limitCents: 1 }))).toBe('invalid_key');
    expect(await code(saveBudget(db, ctx, { scope: 'vendor', label: '  ', limitCents: 1 }))).toBe('invalid_key');
    expect(await code(saveBudget(db, ctx, { scope: 'vendor', key: 'Not Normalized', label: 'x', limitCents: 1 }))).toBe('invalid_key');
    expect(await code(saveBudget(db, ctx, { scope: 'vendor', label: 'x'.repeat(201), limitCents: 1 }))).toBe('invalid_key');
    for (const limitCents of [0, -5, 1.5, 'x', 100_000_001]) expect(await code(saveBudget(db, ctx, { scope: 'category', key: 'cash', limitCents }))).toBe('invalid_limit');
  });
});

describe('private and business parts', () => {
  it('counts only the private part of a mixed counterparty, like the overview', async () => {
    const ctx = await company([line('2026-03-03', 'REWE Markt', '-250')]);
    await setCounterpartyTreatment(db, ctx, { counterparty: 'REWE Markt', treatment: 'mixed' });
    const rowId = await ctx.ws.addReceipt({ Name: 'Bürobedarf', Vendor: 'REWE Markt', Gross: 100, Date: '2026-03-03', Currency: 'EUR', 'FX Rate': 1 });
    const march = (await loadPayments(db, ctx.workspaceId)).payments.find((p) => p.bookingDay === '2026-03-03');
    await linkPayment(db, ctx, { paymentId: march!.id, rowId, cents: 10_000 }, receiptForLink(db, ctx.workspaceId));
    const budget = await groceries(ctx.workspaceId, '2026-03-05');
    const overview = (await loadSpending(db, ctx.workspaceId, 2026, 3)).overview;
    expect(budget?.spentCents).toBe(overview.split.private + overview.split.unanswered);
    expect(budget?.spentCents).toBeLessThan(25_000);
  });

  it('counts a payment of a private account linked as business only for its private part', async () => {
    const ctx = await company([line('2026-03-03', 'REWE Markt', '-250')]);
    await setAccountPrivate(db, ctx, ctx.accountId, true);
    const rowId = await ctx.ws.addReceipt({ Name: 'Bürobedarf', Vendor: 'REWE Markt', Gross: 250, Date: '2026-03-03', Currency: 'EUR', 'FX Rate': 1 });
    const march = (await loadPayments(db, ctx.workspaceId)).payments.find((p) => p.bookingDay === '2026-03-03');
    await linkPayment(db, ctx, { paymentId: march!.id, rowId }, receiptForLink(db, ctx.workspaceId));
    const budget = await groceries(ctx.workspaceId, '2026-03-05');
    const overview = (await loadSpending(db, ctx.workspaceId, 2026, 3)).overview;
    expect(budget?.spentCents ?? 0).toBe(overview.split.private + overview.split.unanswered);
  });
});

describe('resume and re-entry', () => {
  it('a second run, as after a restart, warns nobody again; a new month warns again and clears the old one', async () => {
    const ctx = await company([line('2026-03-03', 'REWE Markt', '-250'), line('2026-04-02', 'REWE Markt', '-260')]);
    const push = recorder();
    await runBudgetWarnings(db, ctx, { today: '2026-03-05', channels: [push.channel] });
    expect((await runBudgetWarnings(db, ctx, { today: '2026-03-06', channels: [push.channel] })).sent).toBe(0);
    expect((await runBudgetWarnings(db, ctx, { today: '2026-04-03', channels: [push.channel] })).sent).toBe(1);
    expect(push.sent).toHaveLength(2);
    expect((await listUnreadNotifications(db, ctx.workspaceId)).filter((n) => n.kind === 'budget').map((n) => n.subjectKey)).toEqual([push.sent[1].subjectKey]);
  });

  it('keeps a counterparty budget, changes it, and removes it, and offers known counterparties', async () => {
    const ctx = await company([line('2026-03-03', 'Kino Beispiel', '-40')]);
    expect((await loadBudgetsView(db, ctx.workspaceId, '2026-03-05', true)).counterparties).toEqual(['Bank Beispiel', 'Kino Beispiel', 'REWE Markt']);
    await saveBudget(db, ctx, { scope: 'vendor', label: 'Kino Beispiel', limitCents: 3000 });
    let vendor = (await loadBudgets(db, ctx.workspaceId, '2026-03-05')).find((l) => l.scope === 'vendor');
    expect(vendor).toMatchObject({ key: 'kino beispiel', spentCents: 4000, level: 'passed' });
    await saveBudget(db, ctx, { scope: 'vendor', key: 'kino beispiel', label: 'Kino Beispiel', limitCents: 6000 });
    vendor = (await loadBudgets(db, ctx.workspaceId, '2026-03-05')).find((l) => l.scope === 'vendor');
    expect(vendor).toMatchObject({ limitCents: 6000, level: 'ok' });
    await saveBudget(db, ctx, { scope: 'vendor', key: 'kino beispiel', label: 'Kino Beispiel', reset: true });
    expect((await loadBudgets(db, ctx.workspaceId, '2026-03-05')).some((l) => l.scope === 'vendor')).toBe(false);
  });
});

describe('company separation', () => {
  it("one company's limits, payments and warnings never reach the other's", async () => {
    const a = await company([line('2026-03-03', 'REWE Markt', '-250')]);
    const b = await company([line('2026-03-03', 'REWE Markt', '-10')]);
    await saveBudget(db, a, { scope: 'category', key: 'groceries_drugstore', limitCents: 99_000 });
    await saveBudget(db, b, { scope: 'category', key: 'groceries_drugstore', limitCents: 500 });
    expect(await groceries(a.workspaceId, '2026-03-05')).toMatchObject({ limitCents: 99_000, spentCents: 25_000 });
    expect(await groceries(b.workspaceId, '2026-03-05')).toMatchObject({ limitCents: 500, spentCents: 1000, level: 'passed' });
    const push = recorder();
    await runBudgetWarnings(db, b, { today: '2026-03-05', channels: [push.channel] });
    expect((await listUnreadNotifications(db, b.workspaceId)).filter((n) => n.kind === 'budget')).toHaveLength(1);
    expect(await listUnreadNotifications(db, a.workspaceId)).toEqual([]);
  });
});
