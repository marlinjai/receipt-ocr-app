import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { saveTaxSettings } from '@/lib/meals/service';
import { AssetInputError } from '../asset-input';
import { TreatmentError } from '../decisions';
import {
  TaxServiceError,
  createAsset,
  decideForVendor,
  deleteAsset,
  deleteDecisionsForRows,
  loadStatement,
  saveItemDecision,
  setAssetDisposal,
  updateAsset,
  type TaxContext,
} from '../service';
import { createWorkspace, db, plainMealReceipt, type TestWorkspace } from '../../../../test/db-helpers';

/** The asset register against a real database (migration 0011). Run with `pnpm test:db`. */

let other: TestWorkspace;
let otherCtx: TaxContext;

async function workspace(): Promise<{ ws: TestWorkspace; ctx: TaxContext }> {
  const ws = await createWorkspace();
  const ctx = { workspaceId: ws.workspaceId, tenantId: ws.tenantId };
  await saveTaxSettings(db, ctx, { smallBusiness: true });
  return { ws, ctx };
}

const hardware = (overrides: Record<string, string | number> = {}) => ({
  Name: 'Rechnung Kamera',
  Vendor: 'Fotohaus Beispiel',
  Gross: 1500,
  Net: 1260.5,
  Date: '2025-03-10',
  Category: 'Hardware & IT',
  Zuordnung: 'Geschäftlich',
  Currency: 'EUR',
  'FX Rate': 1,
  ...overrides,
});

const camera = (rowIds: string[], overrides: Record<string, unknown> = {}) => ({
  label: 'Kamera',
  kind: 'movable',
  acquisitionDate: '2025-03-10',
  method: 'linear',
  usefulLifeMonths: 60,
  rowIds,
  ...overrides,
});

const code = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    if (e instanceof TaxServiceError || e instanceof TreatmentError || e instanceof AssetInputError) return e.code;
    throw e;
  }
  return 'no error';
};

beforeAll(async () => {
  ({ ws: other, ctx: otherCtx } = await workspace());
});

afterAll(async () => {
  await db.$disconnect();
});

type View = Awaited<ReturnType<typeof loadStatement>>;
const line = (view: View, key: string) => view.lines.find((l) => l.key === key)?.cents ?? 0;
const item = (view: View, rowId: string) => view.items.find((i) => i.rowId === rowId)!;

describe('forward: receipt above the limit, asset, schedule', () => {
  it('a hardware receipt above the low-value limit waits until it becomes an asset, then depreciates', async () => {
    const { ws, ctx } = await workspace();
    const rowId = await ws.addReceipt(hardware());
    let view = await loadStatement(db, ws.workspaceId, 2025);
    expect(item(view, rowId).checks.map((c) => c.kind)).toEqual(['needs_asset']);
    expect(view.businessExpenseCents).toBe(0);

    const assetId = await createAsset(db, ctx, camera([rowId]));
    view = await loadStatement(db, ws.workspaceId, 2025);
    expect(item(view, rowId)).toMatchObject({ counted: true, parts: [], checks: [], assetId });
    // March to December: 10 of 60 months of 1,500.00.
    expect(line(view, 'euer.depreciation_movable')).toBe(25_000);
    expect(view.assets).toHaveLength(1);
    expect(view.assets[0]).toMatchObject({ id: assetId, costCents: 150_000, netCostCents: 126_050, counted: true, rowIds: [rowId] });
    expect(view.assets[0].row).toMatchObject({ bookValueStartCents: 0, additionCents: 150_000, bookValueEndCents: 125_000 });
    const stored = await db.taxAsset.findUnique({ where: { id: assetId }, include: { parts: true } });
    expect(stored).toMatchObject({ authWorkspaceId: ws.workspaceId, authTenantId: ws.tenantId });
    expect(stored?.parts[0]).toMatchObject({ authWorkspaceId: ws.workspaceId, authTenantId: ws.tenantId });

    const next = await loadStatement(db, ws.workspaceId, 2026);
    expect(line(next, 'euer.depreciation_movable')).toBe(30_000);
    expect(next.assets[0].row).toMatchObject({ bookValueStartCents: 125_000, bookValueEndCents: 95_000 });
    expect(next.assets[0].schedule.map((r) => r.year)).toEqual([2025, 2026]);
    expect(next.years).toContain(2025);
  });

  it('shipping and customs belong to the cost of the asset', async () => {
    const { ws, ctx } = await workspace();
    const purchase = await ws.addReceipt(hardware({ Name: 'Filter', Gross: 700, Net: 700, Currency: 'EUR' }));
    const customs = await ws.addReceipt(hardware({ Name: 'Einfuhrabgaben', Vendor: 'Paketdienst Beispiel', Gross: 200, Net: 200, Category: 'Sonstige Ausgaben' }));
    await createAsset(db, ctx, camera([purchase, customs], { label: 'Filtersatz', method: 'pool' }));
    const view = await loadStatement(db, ws.workspaceId, 2025);
    expect(view.assets[0]).toMatchObject({ costCents: 90_000, netCostCents: 90_000, counted: true });
    // The customs receipt is no expense of its own any more.
    expect(item(view, customs).parts).toEqual([]);
    expect(line(view, 'euer.other_unlimited')).toBe(0);
    expect(line(view, 'euer.pool_release')).toBe(18_000);
  });

  it('a laptop is written off in full in the year it was bought', async () => {
    const { ws, ctx } = await workspace();
    const rowId = await ws.addReceipt(hardware({ Name: 'Laptop', Gross: 2399, Net: 2015.97, Date: '2025-11-25' }));
    await createAsset(db, ctx, camera([rowId], { label: 'Laptop', method: 'computer_one_year', acquisitionDate: '2025-11-25', usefulLifeMonths: null }));
    expect(line(await loadStatement(db, ws.workspaceId, 2025), 'euer.depreciation_movable')).toBe(239_900);
    const next = await loadStatement(db, ws.workspaceId, 2026);
    expect(line(next, 'euer.depreciation_movable')).toBe(0);
    expect(next.assets[0].row).toMatchObject({ bookValueStartCents: 0, depreciationCents: 0 });
  });

  it('an asset from before the app keeps its reminder value and needs no receipt', async () => {
    const { ws, ctx } = await workspace();
    await createAsset(db, ctx, {
      label: 'Schreibtisch',
      kind: 'movable',
      method: 'linear',
      reminderCents: 100,
      opening: { year: 2025, bookValueCents: 100, remainingMonths: 0 },
      rowIds: [],
    });
    const view = await loadStatement(db, ws.workspaceId, 2026);
    expect(view.assets[0]).toMatchObject({ counted: true, costCents: null });
    expect(view.assets[0].row).toMatchObject({ bookValueStartCents: 100, depreciationCents: 0, bookValueEndCents: 100 });
    expect(view.lines).toEqual([]);
  });
});

describe('backtrack and revise', () => {
  it('changing the method or the receipt amount changes every year; changing back restores it', async () => {
    const { ws, ctx } = await workspace();
    const rowId = await ws.addReceipt(hardware());
    const assetId = await createAsset(db, ctx, camera([rowId]));
    const before = await loadStatement(db, ws.workspaceId, 2026);

    await updateAsset(db, ctx, assetId, camera([rowId], { usefulLifeMonths: 36 }));
    // 1,500.00 over 36 months: 500.00 a year.
    expect(line(await loadStatement(db, ws.workspaceId, 2026), 'euer.depreciation_movable')).toBe(50_000);

    await updateAsset(db, ctx, assetId, camera([rowId]));
    const after = await loadStatement(db, ws.workspaceId, 2026);
    expect(after.lines).toEqual(before.lines);
    expect(after.assets[0].schedule).toEqual(before.assets[0].schedule);

    // The cost is read from the receipt: a corrected receipt moves the schedule with it.
    const grossColumn = (await ws.adapter.getColumns(ws.tableId)).find((c) => c.name === 'Gross')!;
    await ws.adapter.updateRow(rowId, { [grossColumn.id]: 1800 });
    expect(line(await loadStatement(db, ws.workspaceId, 2026), 'euer.depreciation_movable')).toBe(36_000);
  });

  it('a method the cost does not allow is reported on the asset and counts nothing', async () => {
    const { ws, ctx } = await workspace();
    const rowId = await ws.addReceipt(hardware());
    const assetId = await createAsset(db, ctx, camera([rowId], { method: 'low_value', usefulLifeMonths: null }));
    let view = await loadStatement(db, ws.workspaceId, 2025);
    expect(view.assets[0]).toMatchObject({ counted: false, row: null });
    expect(view.assets[0].checks.map((c) => c.kind)).toEqual(['asset_low_value_over_limit']);
    expect(view.businessExpenseCents).toBe(0);
    // Still reported in a later year: an unresolved asset does not drop out of sight.
    expect((await loadStatement(db, ws.workspaceId, 2026)).assets[0].checks).toHaveLength(1);

    await updateAsset(db, ctx, assetId, camera([rowId]));
    view = await loadStatement(db, ws.workspaceId, 2025);
    expect(view.assets[0]).toMatchObject({ counted: true, checks: [] });
  });

  it('removing a receipt from an asset, or the asset itself, makes the receipt ordinary again with its earlier decision', async () => {
    const { ws, ctx } = await workspace();
    const cheap = await ws.addReceipt(hardware({ Name: 'Kabel', Gross: 40, Net: 33.61 }));
    const big = await ws.addReceipt(hardware());
    await saveItemDecision(db, ctx, cheap, { allocations: [{ purpose: 'business', shareBp: 5000 }], formLineKey: 'euer.work_equipment' });
    const assetId = await createAsset(db, ctx, camera([big, cheap]));
    let view = await loadStatement(db, ws.workspaceId, 2025);
    expect(view.assets[0].costCents).toBe(154_000);
    expect(item(view, cheap).parts).toEqual([]);
    // A receipt inside an asset cannot be decided on its own.
    expect(await code(saveItemDecision(db, ctx, cheap, { allocations: [{ purpose: 'private', shareBp: 10000 }] }))).toBe('asset_row');

    await updateAsset(db, ctx, assetId, camera([big]));
    view = await loadStatement(db, ws.workspaceId, 2025);
    expect(view.assets[0].costCents).toBe(150_000);
    expect(item(view, cheap)).toMatchObject({ assetId: null, allocationOrigin: 'item' });
    expect(line(view, 'euer.work_equipment')).toBe(2_000);

    await deleteAsset(db, ctx, assetId);
    view = await loadStatement(db, ws.workspaceId, 2025);
    expect(view.assets).toEqual([]);
    expect(item(view, big).checks.map((c) => c.kind)).toEqual(['needs_asset']);
    expect(await db.taxAssetPart.count({ where: { assetId } })).toBe(0);
  });
});

describe('disposal and re-entry', () => {
  it('a sale splits the year into depreciation, remaining book value and revenue, and can be taken back', async () => {
    const { ws, ctx } = await workspace();
    const rowId = await ws.addReceipt(hardware());
    const assetId = await createAsset(db, ctx, camera([rowId]));
    const untouched = await loadStatement(db, ws.workspaceId, 2026);

    await setAssetDisposal(db, ctx, assetId, { date: '2026-07-01', kind: 'sold', proceedsCents: 90_000 });
    const sold = await loadStatement(db, ws.workspaceId, 2026);
    expect(line(sold, 'euer.depreciation_movable')).toBe(15_000);
    expect(line(sold, 'euer.remaining_book_value')).toBe(110_000);
    expect(line(sold, 'euer.asset_disposal')).toBe(90_000);
    expect(sold.businessRevenueCents).toBe(90_000);
    // Gone from the register the year after.
    expect((await loadStatement(db, ws.workspaceId, 2027)).assets[0].row).toBeNull();

    await setAssetDisposal(db, ctx, assetId, null);
    const restored = await loadStatement(db, ws.workspaceId, 2026);
    expect(restored.lines).toEqual(untouched.lines);
  });

  it('a disposal dated before the purchase is reported, not computed', async () => {
    const { ws, ctx } = await workspace();
    const assetId = await createAsset(db, ctx, camera([await ws.addReceipt(hardware())]));
    await setAssetDisposal(db, ctx, assetId, { date: '2025-01-05', kind: 'scrapped' });
    const view = await loadStatement(db, ws.workspaceId, 2025);
    expect(view.assets[0].checks.map((c) => c.kind)).toEqual(['asset_disposal_before_acquisition']);
    expect(view.businessExpenseCents).toBe(0);
  });

  it('a deleted receipt leaves the asset asking for its cost instead of taking it along', async () => {
    const { ws, ctx } = await workspace();
    const rowId = await ws.addReceipt(hardware());
    const assetId = await createAsset(db, ctx, camera([rowId]));
    await ws.adapter.deleteRow(rowId);
    await deleteDecisionsForRows(db, [rowId]);
    const view = await loadStatement(db, ws.workspaceId, 2025);
    expect(view.assets[0]).toMatchObject({ id: assetId, counted: false, costCents: null, rowIds: [] });
    expect(view.assets[0].checks.map((c) => c.kind)).toEqual(['asset_no_cost']);
  });
});

describe('unhappy paths', () => {
  it('a receipt without an amount makes the cost unknown rather than too low', async () => {
    const { ws, ctx } = await workspace();
    const a = await ws.addReceipt(hardware());
    const b = await ws.addReceipt({ Name: 'Unlesbar', Vendor: 'Fotohaus Beispiel', Date: '2025-03-10', Currency: 'EUR', 'FX Rate': 1 });
    await createAsset(db, ctx, camera([a, b]));
    const view = await loadStatement(db, ws.workspaceId, 2025);
    expect(view.assets[0]).toMatchObject({ costCents: null, counted: false });
    expect(view.assets[0].checks.map((c) => c.kind)).toEqual(['asset_no_cost']);
  });

  it('near the limit without a net amount the asset asks for it', async () => {
    const { ws, ctx } = await workspace();
    const rowId = await ws.addReceipt(hardware({ Gross: 900, Net: 0 }));
    const receiptView = await loadStatement(db, ws.workspaceId, 2025);
    expect(item(receiptView, rowId).checks.map((c) => c.kind)).toEqual(['net_amount_needed']);
    await createAsset(db, ctx, camera([rowId], { method: 'low_value', usefulLifeMonths: null }));
    expect((await loadStatement(db, ws.workspaceId, 2025)).assets[0].checks.map((c) => c.kind)).toEqual(['asset_net_unknown']);
  });

  it('a receipt belongs to one asset only, and a meal to none', async () => {
    const { ws, ctx } = await workspace();
    const rowId = await ws.addReceipt(hardware());
    await createAsset(db, ctx, camera([rowId]));
    expect(await code(createAsset(db, ctx, camera([rowId], { label: 'Zweite Anlage' })))).toBe('row_in_other_asset');
    const meal = await ws.addReceipt(plainMealReceipt());
    expect(await code(createAsset(db, ctx, camera([meal])))).toBe('meal_row');
    expect(await db.taxAsset.count({ where: { authWorkspaceId: ws.workspaceId } })).toBe(1);
  });

  it('several small items on one receipt stay on the low-value line by an explicit statement, and only there', async () => {
    const { ws, ctx } = await workspace();
    const rowId = await ws.addReceipt(hardware({ Name: 'Zubehör, vier Teile', Gross: 1100, Net: 924.37 }));
    expect(item(await loadStatement(db, ws.workspaceId, 2025), rowId).checks.map((c) => c.kind)).toEqual(['needs_asset']);

    const treatment = { allocations: [{ purpose: 'business', shareBp: 10000 }], formLineKey: 'euer.low_value_assets' };
    await saveItemDecision(db, ctx, rowId, { ...treatment, severalLowValueItems: true });
    let view = await loadStatement(db, ws.workspaceId, 2025);
    expect(item(view, rowId)).toMatchObject({ counted: true, checks: [], severalLowValueItems: true });
    expect(line(view, 'euer.low_value_assets')).toBe(110_000);

    // Taking the statement back brings the check back.
    expect(await saveItemDecision(db, ctx, rowId, treatment)).toEqual({ changed: true });
    view = await loadStatement(db, ws.workspaceId, 2025);
    expect(item(view, rowId).checks.map((c) => c.kind)).toEqual(['needs_asset']);
    expect(line(view, 'euer.low_value_assets')).toBe(0);
  });

  it('the several-items statement survives making the treatment the vendor rule', async () => {
    const { ws, ctx } = await workspace();
    const rowId = await ws.addReceipt(hardware({ Name: 'Zubehör, vier Teile', Gross: 1100, Net: 924.37 }));
    const other = await ws.addReceipt(hardware({ Name: 'Kabel', Gross: 40, Net: 33.61, Date: '2025-04-01' }));
    const result = await decideForVendor(db, ctx, rowId, {
      vendor: 'Fotohaus Beispiel',
      treatment: { allocations: [{ purpose: 'business', shareBp: 10000 }], formLineKey: 'euer.low_value_assets', severalLowValueItems: true },
    });
    expect(result.receiptFollowsRule).toBe(false);
    expect(result.rule.severalLowValueItems).toBe(false);
    const view = await loadStatement(db, ws.workspaceId, 2025);
    // The receipt that was decided keeps its statement and counts ...
    expect(item(view, rowId)).toMatchObject({ counted: true, checks: [], allocationOrigin: 'item', severalLowValueItems: true });
    // ... the vendor's other receipt follows the rule, without the statement.
    expect(item(view, other)).toMatchObject({ allocationOrigin: 'vendor_rule', severalLowValueItems: false });
    expect(line(view, 'euer.low_value_assets')).toBe(110_000 + 4_000);
  });

  it('rejects a malformed asset and writes nothing', async () => {
    const { ws, ctx } = await workspace();
    const rowId = await ws.addReceipt(hardware());
    expect(await code(createAsset(db, ctx, camera([rowId], { label: '' })))).toBe('label_required');
    expect(await code(createAsset(db, ctx, camera([])))).toBe('receipts_required');
    expect(await db.taxAsset.count({ where: { authWorkspaceId: ws.workspaceId } })).toBe(0);
  });
});

describe('workspace isolation', () => {
  it('an asset cannot be built from, seen in, changed or deleted from another workspace', async () => {
    const { ws, ctx } = await workspace();
    const foreignRow = await other.addReceipt(hardware());
    expect(await code(createAsset(db, ctx, camera([foreignRow])))).toBe('row_not_found');

    const foreignAsset = await createAsset(db, otherCtx, camera([foreignRow]));
    expect((await loadStatement(db, ws.workspaceId, 2025)).assets).toEqual([]);
    expect(await code(updateAsset(db, ctx, foreignAsset, camera([foreignRow])))).toBe('asset_not_found');
    expect(await code(setAssetDisposal(db, ctx, foreignAsset, { date: '2026-01-01', kind: 'scrapped' }))).toBe('asset_not_found');
    expect(await code(deleteAsset(db, ctx, foreignAsset))).toBe('asset_not_found');
    expect(await db.taxAsset.count({ where: { id: foreignAsset, disposalDate: null } })).toBe(1);
  });
});
