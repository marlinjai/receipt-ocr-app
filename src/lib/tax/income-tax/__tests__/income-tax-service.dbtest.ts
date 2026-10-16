import { beforeAll, describe, expect, it } from 'vitest';
import { loadStatement, type TaxContext } from '../../service';
import { IncomeTaxInputError } from '../input';
import {
  IncomeTaxServiceError,
  deleteReturnItem,
  deleteWageEntry,
  loadIncomeTax,
  saveChurchMonths,
  saveFederalState,
  saveReturnItem,
  saveWageEntry,
} from '../service';
import { createWorkspace, db } from '../../../../../test/db-helpers';

/**
 * Wages, return items and church months against a real database (migration
 * 0026), with the four paths of an input flow: forward, backtrack and
 * revise, resume from what is stored, and re-entry after the year is
 * complete. Run with `pnpm test:db`.
 */

const today = new Date('2026-10-15T12:00:00Z');
const noStatement = { profitCents: null, lines: [] };

async function workspace(): Promise<TaxContext> {
  const ws = await createWorkspace();
  return { workspaceId: ws.workspaceId, tenantId: ws.tenantId };
}

const slip = (month: number, overrides: Record<string, unknown> = {}) => ({
  year: 2026,
  employer: 'Arbeitgeber',
  month,
  grossCents: 450_000,
  wageTaxCents: 70_000,
  churchTaxCents: 0,
  pensionEmployeeCents: 41_850,
  pensionEmployerCents: 41_850,
  healthEmployeeCents: 38_000,
  careEmployeeCents: 9_000,
  unemploymentEmployeeCents: 5_850,
  ...overrides,
});

const code = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    if (e instanceof IncomeTaxServiceError || e instanceof IncomeTaxInputError) return e.code;
    throw e;
  }
  return 'no error';
};

let other: TaxContext;
beforeAll(async () => {
  other = await workspace();
});

describe('income tax facts: the four paths', () => {
  it('forward: no wages is business only; one pay slip turns the estimate into wages plus business, projected to December', async () => {
    const ctx = await workspace();
    const before = await loadIncomeTax(db, ctx.workspaceId, 2026, { profitCents: 100_000, lines: [] }, today);
    expect(before.estimate.scope).toBe('business_only');
    expect(before.estimate.missing.map((m) => m.code)).toContain('wages');
    expect(before.projected).toBeNull();

    await saveWageEntry(db, ctx, null, slip(1));
    const after = await loadIncomeTax(db, ctx.workspaceId, 2026, { profitCents: 100_000, lines: [] }, today);
    expect(after.running).toBe(true);
    expect(after.estimate.scope).toBe('full');
    expect(after.projected).not.toBeNull();
    // Recorded: one month. Projected: January plus eleven months like it.
    expect(after.estimate.incomeTax.withheldCents).toBe(70_000);
    expect(after.projected!.incomeTax.withheldCents).toBe(70_000 * 12);
  });

  it('backtrack and revise: changing a pay slip changes the estimate; changing it back gives the same estimate again', async () => {
    const ctx = await workspace();
    const id = await saveWageEntry(db, ctx, null, slip(2));
    const first = await loadIncomeTax(db, ctx.workspaceId, 2026, noStatement, today);
    await saveWageEntry(db, ctx, id, slip(2, { grossCents: 900_000 }));
    const changed = await loadIncomeTax(db, ctx.workspaceId, 2026, noStatement, today);
    expect(changed.projected!.incomeTax.assessedCents).toBeGreaterThan(first.projected!.incomeTax.assessedCents as number);
    await saveWageEntry(db, ctx, id, slip(2));
    const back = await loadIncomeTax(db, ctx.workspaceId, 2026, noStatement, today);
    expect(back.estimate).toEqual(first.estimate);
    expect(back.projected).toEqual(first.projected);

    // Moving a slip onto a month that already has one is refused, not merged.
    await saveWageEntry(db, ctx, null, slip(3));
    expect(await code(saveWageEntry(db, ctx, id, slip(3)))).toBe('wage_entry_taken');
    expect(await code(saveWageEntry(db, ctx, null, slip(3)))).toBe('wage_entry_taken');
  });

  it('resume: what was entered last week is read back as it was, items and months included', async () => {
    const ctx = await workspace();
    for (const m of [1, 2, 3]) await saveWageEntry(db, ctx, null, slip(m, { churchTaxCents: 3_000 }));
    await saveReturnItem(db, ctx, null, { year: 2026, key: 'employment.home_office_days', days: 40 });
    await saveReturnItem(db, ctx, null, { year: 2026, key: 'employment.other', amountCents: 24_500, note: 'Gewerkschaft' });
    await saveFederalState(db, ctx, 'BE');
    const view = await loadIncomeTax(db, ctx.workspaceId, 2026, noStatement, today);
    expect(view.wageEntries.map((w) => w.month)).toEqual([1, 2, 3]);
    expect(view.returnItems).toHaveLength(2);
    expect(view.federalState).toBe('BE');
    // No months stated: read off the slips (church tax withheld in all three) and named as an assumption.
    expect(view.churchMonths).toBeNull();
    expect(view.churchMonthsFromPaySlips!.slice(0, 4)).toEqual([true, true, true, false]);
    expect(view.estimate.assumptions.join(' ')).toMatch(/aus den Lohnabrechnungen abgeleitet/);
    const again = await loadIncomeTax(db, ctx.workspaceId, 2026, noStatement, today);
    expect(again).toEqual(view);
  });

  it('re-entry: the annual statement replaces the pay slips once the year is over; deleting it falls back to them', async () => {
    const ctx = await workspace();
    const slips = { ...slip(1), year: 2025 };
    await saveWageEntry(db, ctx, null, slips);
    const annualId = await saveWageEntry(db, ctx, null, { ...slip(0), year: 2025, grossCents: 5_296_950, wageTaxCents: 807_176 });
    const withAnnual = await loadIncomeTax(db, ctx.workspaceId, 2025, noStatement, today);
    expect(withAnnual.running).toBe(false);
    expect(withAnnual.projected).toBeNull();
    expect(withAnnual.estimate.incomeTax.withheldCents).toBe(807_176);
    expect(withAnnual.estimate.assumptions.join(' ')).toMatch(/Lohnsteuerbescheinigung; 1 Lohnabrechnungen/);

    await deleteWageEntry(db, ctx, annualId);
    const without = await loadIncomeTax(db, ctx.workspaceId, 2025, noStatement, today);
    expect(without.estimate.incomeTax.withheldCents).toBe(70_000);

    // Church months stated, then cleared: back to what the slips say.
    await saveChurchMonths(db, ctx, { year: 2025, churchMonths: Array.from({ length: 12 }, (_, i) => i < 11) });
    expect((await loadIncomeTax(db, ctx.workspaceId, 2025, noStatement, today)).churchMonths!.filter(Boolean)).toHaveLength(11);
    await saveChurchMonths(db, ctx, { year: 2025, churchMonths: null });
    expect((await loadIncomeTax(db, ctx.workspaceId, 2025, noStatement, today)).churchMonths).toBeNull();
  });
});

describe('income tax facts: isolation and the statement', () => {
  it('never reads or writes across workspaces', async () => {
    const ctx = await workspace();
    const wageId = await saveWageEntry(db, ctx, null, slip(4));
    const itemId = await saveReturnItem(db, ctx, null, { year: 2026, key: 'special.donations', amountCents: 5_000 });
    expect((await loadIncomeTax(db, other.workspaceId, 2026, noStatement, today)).wageEntries).toEqual([]);
    expect(await code(saveWageEntry(db, other, wageId, slip(5)))).toBe('wage_not_found');
    expect(await code(deleteWageEntry(db, other, wageId))).toBe('wage_not_found');
    expect(await code(saveReturnItem(db, other, itemId, { year: 2026, key: 'special.donations', amountCents: 1 }))).toBe('item_not_found');
    expect(await code(deleteReturnItem(db, other, itemId))).toBe('item_not_found');
    // Untouched in the owner's workspace.
    const view = await loadIncomeTax(db, ctx.workspaceId, 2026, noStatement, today);
    expect(view.wageEntries[0].month).toBe(4);
    expect(view.returnItems[0].amountCents).toBe(5_000);
    // The same employer and month may exist in another workspace.
    expect(await code(saveWageEntry(db, other, null, slip(4)))).toBe('no error');
  });

  it('stamps the company on every row', async () => {
    const ctx = await workspace();
    const wageId = await saveWageEntry(db, ctx, null, slip(6));
    await saveChurchMonths(db, ctx, { year: 2026, churchMonths: Array(12).fill(false) });
    const row = await db.taxWageStatement.findUnique({ where: { id: wageId } });
    const settings = await db.taxYearSettings.findFirst({ where: { authWorkspaceId: ctx.workspaceId } });
    expect(row!.authTenantId).toBe(ctx.tenantId);
    expect(settings!.authTenantId).toBe(ctx.tenantId);
  });

  it('keeps the own-car answer of a commute through a change', async () => {
    const ctx = await workspace();
    const id = await saveReturnItem(db, ctx, null, { year: 2026, key: 'employment.commute', days: 200, distanceKm: 30, ownCar: true });
    expect((await loadIncomeTax(db, ctx.workspaceId, 2026, noStatement, today)).returnItems[0].ownCar).toBe(true);
    await saveReturnItem(db, ctx, id, { year: 2026, key: 'employment.commute', days: 200, distanceKm: 30, ownCar: false });
    expect((await loadIncomeTax(db, ctx.workspaceId, 2026, noStatement, today)).returnItems[0].ownCar).toBe(false);
  });

  it('refuses invalid input before writing', async () => {
    const ctx = await workspace();
    expect(await code(saveWageEntry(db, ctx, null, slip(13)))).toBe('invalid_month');
    expect(await code(saveReturnItem(db, ctx, null, { year: 2026, key: 'employment.commute', days: 3 }))).toBe('invalid_distance');
    expect(await code(saveFederalState(db, ctx, 'XX'))).toBe('invalid_federal_state');
    expect(await db.taxWageStatement.count({ where: { authWorkspaceId: ctx.workspaceId } })).toBe(0);
  });

  it('is part of the finance statement of the year', async () => {
    const ctx = await workspace();
    await saveWageEntry(db, ctx, null, { ...slip(0), year: 2025 });
    const statement = await loadStatement(db, ctx.workspaceId, 2025);
    expect(statement.incomeTax.year).toBe(2025);
    expect(statement.incomeTax.wageEntries).toHaveLength(1);
    // No invoices in this workspace: the business result is unknown, said so, never zero.
    expect(statement.incomeTax.estimate.scope).toBe('without_business');
  });
});
