import { afterAll, describe, expect, it } from 'vitest';
import { createAccount, importPayments, setCounterpartyTreatment } from '@/lib/tax/payments/service';
import { SpendingServiceError, loadSpending, markCounterpartyOwnAccount, removeCounterpartyCategory, setCounterpartyCategory, unmarkCounterpartyOwnAccount, type SpendingContext } from '../service';
import { createWorkspace, db } from '../../../../test/db-helpers';

/** The spending overview against a real database (migration 0020). Run with `pnpm test:db`. Every name and amount is invented. */

const HEADER = '"Booking Date","Value Date","Partner Name","Partner Iban",Type,"Payment Reference","Account Name","Amount (EUR)","Original Amount","Original Currency","Exchange Rate"';
const line = (day: string, partner: string, reference: string, amount: string, type = 'Presentment') => `${day},${day},"${partner}",,${type},"${reference}",Hauptkonto,${amount},,,`;
const file = (...lines: string[]) => [HEADER, ...lines].join('\n') + '\n';

async function company(lines: string[]): Promise<SpendingContext> {
  const ws = await createWorkspace();
  const ctx = { workspaceId: ws.workspaceId, tenantId: ws.tenantId };
  const accountId = await createAccount(db, ctx, { label: 'Girokonto', kind: 'bank' });
  await importPayments(db, ctx, accountId, file(...lines));
  return ctx;
}

const code = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    if (e instanceof SpendingServiceError) return e.code;
    throw e;
  }
  return 'no error';
};

afterAll(async () => {
  await db.$disconnect();
});

describe('spending overview', () => {
  it('reads one company only: its payments and its answers, never the other company\'s', async () => {
    const personal = await company([line('2026-03-02', 'REWE Markt', 'Einkauf', '-42.10'), line('2026-03-05', 'Zyx Handel', 'Bestellung', '-19.99')]);
    const business = await company([line('2026-03-03', 'Hetzner Online', 'Server', '-30'), line('2026-03-06', 'Zyx Handel', 'Bestellung', '-500')]);

    await setCounterpartyCategory(db, business, { counterparty: 'Zyx Handel', category: 'software_ai_hosting' });

    const own = await loadSpending(db, personal.workspaceId, 2026, null);
    expect(own.overview.totalCents).toBe(4210 + 1999);
    expect(own.overview.payments.map((p) => p.counterparty).sort()).toEqual(['REWE Markt', 'Zyx Handel']);
    // The other company's answer for the same counterparty does not reach this one.
    expect(own.answers).toEqual([]);
    expect(own.overview.unclear.map((u) => u.counterpartyKey)).toEqual(['zyx handel']);

    const other = await loadSpending(db, business.workspaceId, 2026, null);
    expect(other.overview.totalCents).toBe(3000 + 50_000);
    expect(other.overview.payments.some((p) => p.counterparty === 'REWE Markt')).toBe(false);
    expect(other.overview.byCategory.find((c) => c.category === 'software_ai_hosting')?.cents).toBe(53_000);
  });

  it('keeps an answer, changes it, and takes it back', async () => {
    const ctx = await company([line('2026-04-02', 'Zyx Handel', 'Bestellung', '-20')]);
    await setCounterpartyCategory(db, ctx, { counterparty: 'Zyx Handel', category: 'shopping_household' });
    expect((await loadSpending(db, ctx.workspaceId, 2026, 4)).overview.byCategory.find((c) => c.category === 'shopping_household')?.cents).toBe(2000);

    await setCounterpartyCategory(db, ctx, { counterparty: 'ZYX HANDEL', category: 'leisure_sport' });
    const changed = await loadSpending(db, ctx.workspaceId, 2026, 4);
    expect(changed.answers).toEqual([{ counterpartyKey: 'zyx handel', label: 'ZYX HANDEL', category: 'leisure_sport' }]);
    expect(changed.overview.byCategory.find((c) => c.category === 'leisure_sport')?.cents).toBe(2000);

    await removeCounterpartyCategory(db, ctx, 'zyx handel');
    const back = await loadSpending(db, ctx.workspaceId, 2026, 4);
    expect(back.answers).toEqual([]);
    expect(back.overview.unclear).toHaveLength(1);

    // Taken back by the stored key too, and only in this company.
    const other = await company([line('2026-04-02', 'Zyx Handel', 'Bestellung', '-20')]);
    await setCounterpartyCategory(db, ctx, { counterparty: 'Zyx Handel', category: 'cash' });
    await setCounterpartyCategory(db, other, { counterparty: 'Zyx Handel', category: 'cash' });
    await removeCounterpartyCategory(db, ctx, 'zyx handel');
    expect((await loadSpending(db, ctx.workspaceId, 2026, null)).answers).toEqual([]);
    expect((await loadSpending(db, other.workspaceId, 2026, null)).answers).toHaveLength(1);
  });

  it('offers the year asked for even when it has no payments', async () => {
    const ctx = await company([line('2026-04-02', 'Zyx Handel', 'Bestellung', '-20')]);
    const view = await loadSpending(db, ctx.workspaceId, 2019, null, new Date('2026-06-01T12:00:00Z'));
    expect(view.years).toEqual([2026, 2019]);
    expect(view.overview.totalCents).toBe(0);
  });

  it('refuses a missing counterparty, an unknown category, and "unclear" as an answer', async () => {
    const ctx = await company([line('2026-04-02', 'Zyx Handel', 'Bestellung', '-20')]);
    expect(await code(setCounterpartyCategory(db, ctx, { counterparty: '  ', category: 'cash' }))).toBe('counterparty_required');
    expect(await code(setCounterpartyCategory(db, ctx, { counterparty: 'Zyx Handel', category: 'yachts' }))).toBe('invalid_category');
    expect(await code(setCounterpartyCategory(db, ctx, { counterparty: 'Zyx Handel', category: 'unclear' }))).toBe('invalid_category');
  });

  it('follows the payments tab: an own-account answer leaves spending, a private answer moves the split', async () => {
    const ctx = await company([line('2026-05-02', 'Tagesgeld Beispiel', 'Sparen', '-1000'), line('2026-05-03', 'REWE Markt', 'Einkauf', '-10')]);
    await setCounterpartyTreatment(db, ctx, { counterparty: 'Tagesgeld Beispiel', treatment: 'own_account' });
    await setCounterpartyTreatment(db, ctx, { counterparty: 'REWE Markt', treatment: 'private' });
    const view = await loadSpending(db, ctx.workspaceId, 2026, null);
    expect(view.overview.totalCents).toBe(1000);
    expect(view.overview.ownTransfers).toEqual({ cents: 100_000, count: 1 });
    expect(view.overview.split).toEqual({ private: 1000, business: 0, unanswered: 0 });
  });

  it('marks an own account, takes it back, and never overwrites a business or private answer', async () => {
    const ctx = await company([line('2026-06-02', 'Karte Beispiel', 'Abrechnung', '-300'), line('2026-06-03', 'Zyx Handel', 'Bestellung', '-50')]);
    await markCounterpartyOwnAccount(db, ctx, 'Karte Beispiel');
    let view = await loadSpending(db, ctx.workspaceId, 2026, null);
    expect(view.overview.totalCents).toBe(5000);
    expect(view.ownAccounts).toEqual([{ counterpartyKey: 'karte beispiel', label: 'Karte Beispiel' }]);
    // Saying it twice changes nothing.
    await markCounterpartyOwnAccount(db, ctx, 'Karte Beispiel');

    await unmarkCounterpartyOwnAccount(db, ctx, 'karte beispiel');
    view = await loadSpending(db, ctx.workspaceId, 2026, null);
    expect(view.overview.totalCents).toBe(35_000);
    expect(view.ownAccounts).toEqual([]);

    await setCounterpartyTreatment(db, ctx, { counterparty: 'Zyx Handel', treatment: 'business' });
    expect(await code(markCounterpartyOwnAccount(db, ctx, 'Zyx Handel'))).toBe('treatment_exists');
    expect(await code(unmarkCounterpartyOwnAccount(db, ctx, 'zyx handel'))).toBe('not_own_account');
    expect((await loadSpending(db, ctx.workspaceId, 2026, null)).overview.split.business).toBe(5000);
  });

  it('says when a company has no payments at all', async () => {
    const ws = await createWorkspace();
    const view = await loadSpending(db, ws.workspaceId, 2026, null);
    expect(view.noPayments).toBe(true);
    expect(view.overview.totalCents).toBe(0);
  });
});
