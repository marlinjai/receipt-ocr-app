import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { saveTaxSettings } from '@/lib/meals/service';
import { LinesInputError } from '../lines';
import {
  TaxServiceError,
  clearReceiptLines,
  createAsset,
  deleteDecisionsForRows,
  loadStatement,
  saveItemDecision,
  saveLineDecision,
  saveReceiptLines,
  type TaxContext,
} from '../service';
import { createWorkspace, db, plainMealReceipt, type TestWorkspace } from '../../../../test/db-helpers';

/** Receipt lines against a real database (migration 0015). Run with `pnpm test:db`. */

let other: TestWorkspace;
let otherCtx: TaxContext;

async function workspace(): Promise<{ ws: TestWorkspace; ctx: TaxContext }> {
  const ws = await createWorkspace();
  const ctx = { workspaceId: ws.workspaceId, tenantId: ws.tenantId };
  await saveTaxSettings(db, ctx, { smallBusiness: true });
  return { ws, ctx };
}

const order = (overrides: Record<string, string | number> = {}) => ({
  Name: 'Bestellung 4711',
  Vendor: 'Versand Beispiel',
  Gross: 1100,
  Date: '2025-07-09',
  Category: 'Hardware & IT',
  Zuordnung: 'Geschäftlich',
  Currency: 'EUR',
  'FX Rate': 1,
  ...overrides,
});
const LINES = [
  { description: 'Stativ', grossCents: 90_000 },
  { description: 'Speicherkarte', grossCents: 15_000 },
  { description: 'Geschenk, privat', grossCents: 5_000 },
];

const code = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    if (e instanceof TaxServiceError || e instanceof LinesInputError) return e.code;
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
const ofRow = (view: View, rowId: string) => view.items.filter((i) => i.rowId === rowId);
const cents = (view: View, key: string) => view.lines.find((l) => l.key === key)?.cents ?? 0;

describe('splitting a receipt: forward', () => {
  it('one order becomes an asset, a small item expensed at once, and a private item', async () => {
    const { ws, ctx } = await workspace();
    const rowId = await ws.addReceipt(order());
    expect(ofRow(await loadStatement(db, ws.workspaceId, 2025), rowId)[0].checks.map((c) => c.kind)).toEqual(['needs_asset']);

    await saveReceiptLines(db, ctx, rowId, LINES);
    let view = await loadStatement(db, ws.workspaceId, 2025);
    const lines = ofRow(view, rowId);
    expect(lines.map((i) => [i.lineDescription, i.amountCents, i.lineGrossCents, i.checks.map((c) => c.kind)])).toEqual([
      ['Stativ', 90_000, 90_000, []],
      ['Speicherkarte', 15_000, 15_000, []],
      ['Geschenk, privat', 5_000, 5_000, []],
    ]);
    // 900.00 gross is within the limit for certain only up to 800.00: between 800 and 952 the net amount would tell.
    const stored = await db.taxReceiptLine.findMany({ where: { rowId }, orderBy: { position: 'asc' } });
    expect(stored[0]).toMatchObject({ authWorkspaceId: ws.workspaceId, authTenantId: ws.tenantId, position: 0 });

    // The private line gets its own decision, the tripod becomes an asset from its line alone.
    await saveLineDecision(db, ctx, lines[2].lineId!, { allocations: [{ purpose: 'private', shareBp: 10000 }] });
    await createAsset(db, ctx, { label: 'Stativ', kind: 'movable', acquisitionDate: '2025-07-09', method: 'linear', usefulLifeMonths: 60, itemIds: [lines[0].itemId] });
    view = await loadStatement(db, ws.workspaceId, 2025);
    expect(view.assets[0]).toMatchObject({ costCents: 90_000, itemIds: [lines[0].itemId], counted: true });
    // July to December: 6 of 60 months of 900.00.
    expect(cents(view, 'euer.depreciation_movable')).toBe(9_000);
    expect(cents(view, 'euer.low_value_assets')).toBe(15_000);
    expect(view.privateCents).toBe(5_000);
    expect(ofRow(view, rowId).map((i) => [i.lineDescription, i.assetId !== null, i.allocationOrigin])).toEqual([
      ['Stativ', true, 'legacy_columns'],
      ['Speicherkarte', false, 'legacy_columns'],
      ['Geschenk, privat', false, 'line'],
    ]);
  });
});

describe('splitting a receipt: change, undo, re-entry', () => {
  it('changing the split keeps the lines that stay (with decision and asset) and drops the others cleanly', async () => {
    const { ws, ctx } = await workspace();
    const rowId = await ws.addReceipt(order());
    await saveReceiptLines(db, ctx, rowId, LINES);
    const before = ofRow(await loadStatement(db, ws.workspaceId, 2025), rowId);
    await saveLineDecision(db, ctx, before[2].lineId!, { allocations: [{ purpose: 'private', shareBp: 10000 }] });
    const assetId = await createAsset(db, ctx, { label: 'Stativ', kind: 'movable', acquisitionDate: '2025-07-09', method: 'linear', usefulLifeMonths: 60, itemIds: [before[0].itemId] });

    // Merge the two small lines into one new line; keep the tripod line by its id.
    await saveReceiptLines(db, ctx, rowId, [{ id: before[0].lineId, description: 'Stativ', grossCents: 90_000 }, { description: 'Zubehör', grossCents: 20_000 }]);
    const view = await loadStatement(db, ws.workspaceId, 2025);
    const after = ofRow(view, rowId);
    expect(after.map((i) => i.lineDescription)).toEqual(['Stativ', 'Zubehör']);
    expect(after[0].lineId).toBe(before[0].lineId);
    expect(view.assets[0]).toMatchObject({ id: assetId, costCents: 90_000 });
    expect(await db.taxReceiptLine.count({ where: { rowId } })).toBe(2);

    // Dropping the tripod line takes its asset part along; the asset then asks for its cost.
    await saveReceiptLines(db, ctx, rowId, [{ description: 'Alles A', grossCents: 60_000 }, { description: 'Alles B', grossCents: 50_000 }]);
    const dropped = await loadStatement(db, ws.workspaceId, 2025);
    expect(dropped.assets[0]).toMatchObject({ id: assetId, counted: false, costCents: null, itemIds: [] });
    expect(dropped.assets[0].checks.map((c) => c.kind)).toEqual(['asset_no_cost']);
  });

  it('undoing the split restores the receipt as one item with its earlier decision, exactly', async () => {
    const { ws, ctx } = await workspace();
    const rowId = await ws.addReceipt(order({ Gross: 110, Category: 'Bürobedarf' }));
    await saveItemDecision(db, ctx, rowId, { allocations: [{ purpose: 'business', shareBp: 5000 }], formLineKey: 'euer.work_equipment' });
    const before = await loadStatement(db, ws.workspaceId, 2025);
    await saveReceiptLines(db, ctx, rowId, [{ description: 'A', grossCents: 6_000 }, { description: 'B', grossCents: 5_000 }]);
    const split = await loadStatement(db, ws.workspaceId, 2025);
    // Lines follow the receipt's decision until they have their own: 50 percent each, rounded per line.
    expect(cents(split, 'euer.work_equipment')).toBe(3_000 + 2_500);
    await clearReceiptLines(db, ctx, rowId);
    const after = await loadStatement(db, ws.workspaceId, 2025);
    expect(after.lines).toEqual(before.lines);
    expect(ofRow(after, rowId)).toHaveLength(1);
    expect(await db.taxReceiptLine.count({ where: { rowId } })).toBe(0);
  });

  it('a line decision can be taken back, and the line follows its receipt again', async () => {
    const { ws, ctx } = await workspace();
    const rowId = await ws.addReceipt(order({ Gross: 110, Category: 'Bürobedarf' }));
    await saveReceiptLines(db, ctx, rowId, [{ description: 'A', grossCents: 6_000 }, { description: 'B', grossCents: 5_000 }]);
    const lineId = ofRow(await loadStatement(db, ws.workspaceId, 2025), rowId)[1].lineId!;
    await saveLineDecision(db, ctx, lineId, { allocations: [{ purpose: 'private', shareBp: 10000 }] });
    expect(cents(await loadStatement(db, ws.workspaceId, 2025), 'euer.work_equipment')).toBe(6_000);
    await saveLineDecision(db, ctx, lineId, null);
    const view = await loadStatement(db, ws.workspaceId, 2025);
    expect(cents(view, 'euer.work_equipment')).toBe(11_000);
    expect(ofRow(view, rowId)[1].allocationOrigin).toBe('legacy_columns');
  });

  it('a receipt whose total is corrected after the split is reported until the lines fit again', async () => {
    const { ws, ctx } = await workspace();
    const rowId = await ws.addReceipt(order({ Gross: 110, Category: 'Bürobedarf' }));
    await saveReceiptLines(db, ctx, rowId, [{ description: 'A', grossCents: 6_000 }, { description: 'B', grossCents: 5_000 }]);
    const grossColumn = (await ws.adapter.getColumns(ws.tableId)).find((c) => c.name === 'Gross')!;
    await ws.adapter.updateRow(rowId, { [grossColumn.id]: 120 });
    let view = await loadStatement(db, ws.workspaceId, 2025);
    expect(ofRow(view, rowId).map((i) => i.checks.map((c) => c.kind))).toEqual([['lines_do_not_sum']]);
    expect(view.businessExpenseCents).toBe(0);
    const stored = await db.taxReceiptLine.findMany({ where: { rowId }, orderBy: { position: 'asc' } });
    await saveReceiptLines(db, ctx, rowId, [{ id: stored[0].id, description: 'A', grossCents: 7_000 }, { id: stored[1].id, description: 'B', grossCents: 5_000 }]);
    view = await loadStatement(db, ws.workspaceId, 2025);
    expect(view.businessExpenseCents).toBe(12_000);
  });

  it('deleting a receipt takes its lines along', async () => {
    const { ws, ctx } = await workspace();
    const rowId = await ws.addReceipt(order());
    await saveReceiptLines(db, ctx, rowId, LINES);
    await ws.adapter.deleteRow(rowId);
    await deleteDecisionsForRows(db, [rowId]);
    expect(await db.taxReceiptLine.count({ where: { rowId } })).toBe(0);
  });
});

describe('unhappy paths and isolation', () => {
  it('rejects lines that do not add up, a single line, a meal and a receipt inside an asset, and writes nothing', async () => {
    const { ws, ctx } = await workspace();
    const rowId = await ws.addReceipt(order());
    expect(await code(saveReceiptLines(db, ctx, rowId, LINES.slice(0, 2)))).toBe('lines_do_not_sum');
    expect(await code(saveReceiptLines(db, ctx, rowId, [{ description: 'Alles', grossCents: 110_000 }]))).toBe('lines_required');
    expect(await code(saveReceiptLines(db, ctx, rowId, [{ id: 'not-a-line', description: 'A', grossCents: 60_000 }, { description: 'B', grossCents: 50_000 }]))).toBe('line_not_found');
    expect(await db.taxReceiptLine.count({ where: { rowId } })).toBe(0);

    const meal = await ws.addReceipt(plainMealReceipt());
    expect(await code(saveReceiptLines(db, ctx, meal, [{ description: 'A', grossCents: 6_000 }, { description: 'B', grossCents: 5_900 }]))).toBe('meal_row');

    await createAsset(db, ctx, { label: 'Alles', kind: 'movable', acquisitionDate: '2025-07-09', method: 'linear', usefulLifeMonths: 60, itemIds: [rowId] });
    expect(await code(saveReceiptLines(db, ctx, rowId, LINES))).toBe('asset_row');
  });

  it('a line is in one asset only, and a receipt is in an asset whole or by lines, never both', async () => {
    const { ws, ctx } = await workspace();
    const rowId = await ws.addReceipt(order());
    await saveReceiptLines(db, ctx, rowId, LINES);
    const lines = ofRow(await loadStatement(db, ws.workspaceId, 2025), rowId);
    const asset = (itemIds: string[]) => ({ label: 'Anlage', kind: 'movable', acquisitionDate: '2025-07-09', method: 'linear', usefulLifeMonths: 60, itemIds });
    await createAsset(db, ctx, asset([lines[0].itemId]));
    expect(await code(createAsset(db, ctx, asset([lines[0].itemId])))).toBe('row_in_other_asset');
    expect(await code(createAsset(db, ctx, asset([rowId])))).toBe('row_in_other_asset');
    expect(await code(createAsset(db, ctx, asset([`${rowId}#no-such-line`])))).toBe('line_not_found');
    // A line inside an asset cannot be decided on its own.
    expect(await code(saveLineDecision(db, ctx, lines[0].lineId!, { allocations: [{ purpose: 'private', shareBp: 10000 }] }))).toBe('asset_row');
  });

  it('lines of another workspace do not exist here', async () => {
    const { ctx } = await workspace();
    const foreignRow = await other.addReceipt(order());
    await saveReceiptLines(db, otherCtx, foreignRow, LINES);
    const foreignLine = (await db.taxReceiptLine.findFirst({ where: { rowId: foreignRow } }))!;
    expect(await code(saveReceiptLines(db, ctx, foreignRow, LINES))).toBe('row_not_found');
    expect(await code(clearReceiptLines(db, ctx, foreignRow))).toBe('row_not_found');
    expect(await code(saveLineDecision(db, ctx, foreignLine.id, null))).toBe('line_not_found');
    expect(await db.taxReceiptLine.count({ where: { rowId: foreignRow } })).toBe(3);
  });
});
