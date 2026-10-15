import { afterAll, describe, expect, it } from 'vitest';
import { saveTaxSettings } from '@/lib/meals/service';
import { ReverseChargeInputError } from '../reverse-charge';
import {
  TaxServiceError,
  clearReverseCharge,
  createAsset,
  deleteDecisionsForRows,
  saveItemDecision,
  deleteReverseChargeVendorEntry,
  loadStatement,
  saveReverseCharge,
  saveStatusChange,
  saveVatSettings,
  type TaxContext,
} from '../service';
import { createWorkspace, db, plainMealReceipt, type TestWorkspace } from '../../../../test/db-helpers';

/**
 * Tax the buyer owes on services from abroad (section 13b), stored and
 * resolved against a real database (migration 0021). Run with `pnpm test:db`.
 */

async function workspace(smallBusiness = true): Promise<{ ws: TestWorkspace; ctx: TaxContext }> {
  const ws = await createWorkspace();
  const ctx = { workspaceId: ws.workspaceId, tenantId: ws.tenantId };
  await saveTaxSettings(db, ctx, { smallBusiness });
  return { ws, ctx };
}

/** A hosting invoice from a supplier abroad: 100.00 euros, no German tax on it. */
const foreign = (overrides: Record<string, string | number> = {}) => ({
  Name: 'Hosting',
  Vendor: 'Cloud Host Ltd',
  Gross: 100,
  Date: '2026-05-20',
  Category: 'Software & Lizenzen',
  Zuordnung: 'Geschäftlich',
  Currency: 'EUR',
  'FX Rate': 1,
  ...overrides,
});

const code = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    if (e instanceof TaxServiceError || e instanceof ReverseChargeInputError) return e.code;
    throw e;
  }
  return 'no error';
};

afterAll(async () => {
  await db.$disconnect();
});

describe('section 13b: forward, change, re-entry', () => {
  it('small business: a receipt marked 19 percent owes 19.00 in its quarter, the expense is unchanged, and it can be taken back', async () => {
    const { ws, ctx } = await workspace(true);
    const rowId = await ws.addReceipt(foreign());
    const before = await loadStatement(db, ws.workspaceId, 2026);
    expect(before.vat.reverseChargeYear).toBeNull();

    await saveReverseCharge(db, ctx, rowId, { rateBp: 1900 });
    const after = await loadStatement(db, ws.workspaceId, 2026);
    expect(after.businessExpenseCents).toBe(before.businessExpenseCents);
    expect(after.vat.applies).toBe(false);
    expect(after.vat.reverseChargeFrequencyAssumed).toBe(true);
    expect(after.vat.reverseChargeYear?.periods.map((p) => p.dueCents)).toEqual([0, 1900, 0, 0]);
    expect(after.items.find((i) => i.rowId === rowId)).toMatchObject({ reverseCharge: { rateBp: 1900, origin: 'item' }, reverseChargeOwn: { rateBp: 1900 } });

    // Change: the reduced rate replaces the statement in place.
    await saveReverseCharge(db, ctx, rowId, { rateBp: 700 });
    expect((await loadStatement(db, ws.workspaceId, 2026)).vat.reverseChargeYear?.dueCents).toBe(700);
    expect(await db.taxReverseCharge.count({ where: { authWorkspaceId: ws.workspaceId } })).toBe(1);

    // Re-entry: taken back, the year is what it was before.
    await clearReverseCharge(db, ctx, rowId);
    const back = await loadStatement(db, ws.workspaceId, 2026);
    expect(back.vat.reverseChargeYear).toBeNull();
    expect(back.items.find((i) => i.rowId === rowId)).toMatchObject({ reverseCharge: null, reverseChargeOwn: null });
  });

  it('regular taxation: owed and deductible in the same period, the receipt counts with its whole amount', async () => {
    const { ws, ctx } = await workspace(false);
    await saveVatSettings(db, ctx, { frequency: 'monthly', method: 'issued' });
    const rowId = await ws.addReceipt(foreign());
    await saveReverseCharge(db, ctx, rowId, { rateBp: 1900 });
    const view = await loadStatement(db, ws.workspaceId, 2026);
    const may = view.vat.year?.periods[4];
    expect(may).toMatchObject({ reverseChargeVatCents: 1900, reverseChargeInputVatCents: 1900, dueCents: 0 });
    // Not blocked for a missing net amount: the invoice shows no tax, so its amount is the net amount.
    expect(view.items.find((i) => i.rowId === rowId)?.counted).toBe(true);
    expect(view.businessExpenseCents).toBe(10_000);
  });

  it('a status change inside the year: the tax is owed on both sides of it, deductible only after it', async () => {
    const { ws, ctx } = await workspace(true);
    await saveStatusChange(db, ctx, { effectiveFrom: '2026-07-01', smallBusiness: false });
    await saveVatSettings(db, ctx, { frequency: 'quarterly', method: 'issued' });
    const before = await ws.addReceipt(foreign({ Date: '2026-05-20' }));
    const afterChange = await ws.addReceipt(foreign({ Date: '2026-08-20' }));
    await saveReverseCharge(db, ctx, before, { rateBp: 1900 });
    await saveReverseCharge(db, ctx, afterChange, { rateBp: 1900 });
    const periods = (await loadStatement(db, ws.workspaceId, 2026)).vat.year?.periods ?? [];
    expect(periods[1]).toMatchObject({ reverseChargeVatCents: 1900, reverseChargeInputVatCents: 0, dueCents: 1900 });
    expect(periods[2]).toMatchObject({ reverseChargeVatCents: 1900, reverseChargeInputVatCents: 1900, dueCents: 0 });
  });

  it('for a vendor from a day on: earlier receipts stay out, one receipt can say no, and the entry can be removed', async () => {
    const { ws, ctx } = await workspace(true);
    const early = await ws.addReceipt(foreign({ Date: '2026-02-10' }));
    const late = await ws.addReceipt(foreign({ Date: '2026-05-20' }));
    const exception = await ws.addReceipt(foreign({ Date: '2026-06-20' }));

    // Stated from the early receipt with a later start: the vendor entry does
    // not cover that receipt, so the receipt keeps its own statement.
    await saveReverseCharge(db, ctx, early, { rateBp: 1900, applyToVendor: { vendor: 'Cloud Host Ltd', effectiveFrom: '2026-04-01' } });
    let view = await loadStatement(db, ws.workspaceId, 2026);
    expect(view.reverseChargeVendors).toEqual([expect.objectContaining({ label: 'Cloud Host Ltd', effectiveFrom: '2026-04-01', rateBp: 1900 })]);
    expect(view.items.find((i) => i.rowId === early)).toMatchObject({ reverseCharge: { origin: 'item' } });
    expect(view.items.find((i) => i.rowId === late)).toMatchObject({ reverseCharge: { origin: 'vendor_rule' }, reverseChargeOwn: null });

    await saveReverseCharge(db, ctx, exception, { rateBp: null });
    view = await loadStatement(db, ws.workspaceId, 2026);
    expect(view.items.find((i) => i.rowId === exception)).toMatchObject({ reverseCharge: null, reverseChargeOwn: { rateBp: null } });
    expect(view.vat.reverseChargeYear?.dueCents).toBe(3800);

    // From a receipt the new entry covers: that receipt follows the vendor and loses its own statement.
    await saveReverseCharge(db, ctx, exception, { rateBp: 1900, applyToVendor: { vendor: 'Cloud Host Ltd', effectiveFrom: '2026-04-01' } });
    view = await loadStatement(db, ws.workspaceId, 2026);
    expect(view.items.find((i) => i.rowId === exception)).toMatchObject({ reverseCharge: { origin: 'vendor_rule' }, reverseChargeOwn: null });

    await deleteReverseChargeVendorEntry(db, ctx, view.reverseChargeVendors[0].id);
    view = await loadStatement(db, ws.workspaceId, 2026);
    expect(view.reverseChargeVendors).toEqual([]);
    expect(view.vat.reverseChargeYear?.dueCents).toBe(1900);
  });
});

describe('section 13b: assets, shares, currencies and vendor entries', () => {
  it("a receipt that is part of an asset owes the tax, deductible by the asset's business share under regular taxation", async () => {
    const { ws, ctx } = await workspace(false);
    await saveVatSettings(db, ctx, { frequency: 'quarterly', method: 'issued' });
    const rowId = await ws.addReceipt(foreign({ Name: 'Software licence', Gross: 2000 }));
    await saveReverseCharge(db, ctx, rowId, { rateBp: 1900 });
    await createAsset(db, ctx, { label: 'Lizenz', kind: 'intangible', acquisitionDate: '2026-05-20', method: 'linear', usefulLifeMonths: 36, businessShareBp: 8000, itemIds: [rowId] });
    const view = await loadStatement(db, ws.workspaceId, 2026);
    expect(view.vat.reverseChargePendingItems).toBe(0);
    expect(view.vat.year?.periods[1]).toMatchObject({ reverseChargeVatCents: 38_000, reverseChargeInputVatCents: 30_400 });
    expect(view.vat.reverseChargeNonBusinessCents).toBe(7600);
  });

  it('the share outside the business is owed and reported; a receipt in another currency is counted for the note', async () => {
    const { ws, ctx } = await workspace(true);
    const halfPrivate = await ws.addReceipt(foreign());
    await saveItemDecision(db, ctx, halfPrivate, { allocations: [{ purpose: 'business', shareBp: 5000 }], formLineKey: 'euer.it_running', employmentLineKey: null });
    const usd = await ws.addReceipt(foreign({ Currency: 'USD', 'FX Rate': 0.9, Gross: 50 }));
    await saveReverseCharge(db, ctx, halfPrivate, { rateBp: 1900 });
    await saveReverseCharge(db, ctx, usd, { rateBp: 1900 });
    const view = await loadStatement(db, ws.workspaceId, 2026);
    // 19.00 on the half-private receipt, 8.55 on 45.00 euros.
    expect(view.vat.reverseChargeYear?.dueCents).toBe(1900 + 855);
    expect(view.vat.reverseChargeNonBusinessCents).toBe(950);
    expect(view.vat.reverseChargeForeignCurrencyItems).toBe(1);
  });

  it('choosing for one receipt exactly what its vendor entry gives does not pin it', async () => {
    const { ws, ctx } = await workspace(true);
    const first = await ws.addReceipt(foreign());
    const second = await ws.addReceipt(foreign({ Date: '2026-06-20' }));
    await saveReverseCharge(db, ctx, first, { rateBp: 1900, applyToVendor: { vendor: 'Cloud Host Ltd' } });
    await saveReverseCharge(db, ctx, second, { rateBp: 1900 });
    expect(await db.taxReverseCharge.count({ where: { authWorkspaceId: ws.workspaceId, scope: 'row' } })).toBe(0);
    // An unmarked receipt without a vendor entry, saved as "no 13b": nothing stored either.
    const plain = await ws.addReceipt(foreign({ Vendor: 'Anderer Anbieter' }));
    await saveReverseCharge(db, ctx, plain, { rateBp: null });
    expect(await db.taxReverseCharge.count({ where: { authWorkspaceId: ws.workspaceId, scope: 'row' } })).toBe(0);
    // A different choice is the receipt's own and pins it.
    await saveReverseCharge(db, ctx, second, { rateBp: 700 });
    expect(await db.taxReverseCharge.count({ where: { authWorkspaceId: ws.workspaceId, scope: 'row' } })).toBe(1);
  });

  it('a receipt that is on the meal line only through a stored vendor rule is refused', async () => {
    const { ws, ctx } = await workspace(true);
    const rowId = await ws.addReceipt(foreign({ Vendor: 'Restaurant Beispiel' }));
    // The rule form never offers the meal line; an older stored rule can still hold it.
    await db.taxVendorRule.create({
      data: { authWorkspaceId: ws.workspaceId, authTenantId: ws.tenantId, vendorKey: 'restaurant beispiel', vendorLabel: 'Restaurant Beispiel', allocations: [{ purpose: 'business', shareBp: 10_000 }], formLineKey: 'euer.meals' },
    });
    expect(await code(saveReverseCharge(db, ctx, rowId, { rateBp: 1900 }))).toBe('meal_row');
    expect(await db.taxReverseCharge.count({ where: { authWorkspaceId: ws.workspaceId } })).toBe(0);
  });
});

describe('section 13b: refusals, isolation and clean-up', () => {
  it('refuses a rate the law does not have, a bad start day, a vendor without a name, a meal and a missing row; writes nothing', async () => {
    const { ws, ctx } = await workspace(true);
    const rowId = await ws.addReceipt(foreign());
    expect(await code(saveReverseCharge(db, ctx, rowId, { rateBp: 1600 }))).toBe('invalid_reverse_charge_rate');
    expect(await code(saveReverseCharge(db, ctx, rowId, { rateBp: 1900, applyToVendor: { vendor: 'Cloud Host Ltd', effectiveFrom: '2026-02-30' } }))).toBe(
      'invalid_reverse_charge_date',
    );
    expect(await code(saveReverseCharge(db, ctx, rowId, { rateBp: 1900, applyToVendor: { vendor: '' } }))).toBe('no_vendor');
    const meal = await ws.addReceipt(plainMealReceipt());
    expect(await code(saveReverseCharge(db, ctx, meal, { rateBp: 1900 }))).toBe('meal_row');
    expect(await code(saveReverseCharge(db, ctx, 'no-such-row', { rateBp: 1900 }))).toBe('row_not_found');
    expect(await db.taxReverseCharge.count({ where: { authWorkspaceId: ws.workspaceId } })).toBe(0);
  });

  it('another workspace can neither write to a receipt nor see or remove an entry', async () => {
    const { ws, ctx } = await workspace(true);
    const { ws: otherWs, ctx: otherCtx } = await workspace(true);
    const rowId = await ws.addReceipt(foreign());
    expect(await code(saveReverseCharge(db, otherCtx, rowId, { rateBp: 1900 }))).toBe('row_not_found');
    await saveReverseCharge(db, ctx, rowId, { rateBp: 1900, applyToVendor: { vendor: 'Cloud Host Ltd' } });
    const entryId = (await loadStatement(db, ws.workspaceId, 2026)).reverseChargeVendors[0].id;
    expect((await loadStatement(db, otherWs.workspaceId, 2026)).reverseChargeVendors).toEqual([]);
    expect(await code(deleteReverseChargeVendorEntry(db, otherCtx, entryId))).toBe('rule_not_found');
    // Clearing a row of another workspace touches nothing here.
    await saveReverseCharge(db, ctx, rowId, { rateBp: 700 });
    await clearReverseCharge(db, otherCtx, rowId);
    expect(await db.taxReverseCharge.count({ where: { authWorkspaceId: ws.workspaceId, scope: 'row' } })).toBe(1);
  });

  it('a deleted receipt takes its own statement with it, the vendor entry stays', async () => {
    const { ws, ctx } = await workspace(true);
    const rowId = await ws.addReceipt(foreign());
    await saveReverseCharge(db, ctx, rowId, { rateBp: null });
    await saveReverseCharge(db, ctx, await ws.addReceipt(foreign()), { rateBp: 1900, applyToVendor: { vendor: 'Cloud Host Ltd' } });
    await ws.adapter.deleteRow(rowId);
    await deleteDecisionsForRows(db, [rowId]);
    expect(await db.taxReverseCharge.count({ where: { authWorkspaceId: ws.workspaceId, scope: 'row' } })).toBe(0);
    expect(await db.taxReverseCharge.count({ where: { authWorkspaceId: ws.workspaceId, scope: 'vendor' } })).toBe(1);
  });
});
