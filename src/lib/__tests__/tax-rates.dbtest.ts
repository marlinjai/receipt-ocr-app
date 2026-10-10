import { afterAll, describe, expect, it } from 'vitest';
import * as F from '@/lib/extraction/__tests__/fixtures';
import { contactStore, saveMealDetails } from '@/lib/meals/service';
import { serializeTaxLines } from '@/lib/meals/rules';
import { ensureReceiptsTable } from '@/lib/receipts-table';
import { applyNewReading } from '@/lib/review/service';
import { withTaxRates } from '@/lib/tax-rates';
import { createWorkspace, db, plainMealReceipt, type TestWorkspace } from '../../../test/db-helpers';

/**
 * The rates text of a receipt against a real database: a table that existed
 * before the column gets it filled once, and every later write of the rate or
 * the tax lines keeps it in step. Run with `pnpm test:db`. Names and amounts are invented.
 */

afterAll(async () => {
  await db.$disconnect();
});

async function ratesOf(ws: TestWorkspace, rowId: string): Promise<unknown> {
  const columns = await ws.adapter.getColumns(ws.tableId);
  const row = await ws.adapter.getRow(rowId);
  return row!.cells[columns.find((c) => c.name === 'Tax Rates')!.id] ?? null;
}

describe('a table that existed before the rates text', () => {
  it('gets the column next to the number column and every receipt its text, once', async () => {
    const ws = await createWorkspace();
    // Back to how the table was: no rates column.
    const before = await ws.adapter.getColumns(ws.tableId);
    await ws.adapter.deleteColumn(before.find((c) => c.name === 'Tax Rates')!.id);

    const single = await ws.addReceipt({ Name: 'Bürobedarf', Gross: 11.9, Net: 10, 'Tax Rate': 19 });
    const withLines = await ws.addReceipt(plainMealReceipt({ 'Tax Rate': 7, 'Tax Lines': serializeTaxLines([{ rate: 7, net: 30, tax: 2.1 }, { rate: 19, net: 12, tax: 2.28 }]) }));
    // Stored by the old reader: one rate in the cell, two on the receipt, no tax lines kept.
    const oldMixed = await ws.addReceipt(plainMealReceipt({ 'OCR Text': F.FOODBAR_TWO_RATES, Date: '2025-03-21', Gross: 37.7, Net: 35.14, 'Tax Rate': 7 }));
    // The stored total is not the one the text arrives at: the text proves nothing about this row.
    const otherTotal = await ws.addReceipt(plainMealReceipt({ 'OCR Text': F.FOODBAR_TWO_RATES, Date: '2025-03-21', Gross: 50, 'Tax Rate': 7 }));
    const noRate = await ws.addReceipt({ Name: 'Nicht lesbar: scan-07.pdf' });
    const archived = await ws.addReceipt({ Name: 'Abgelegt', Gross: 10.7, 'Tax Rate': 7 });
    await ws.adapter.archiveRow(archived);

    await ensureReceiptsTable(ws.adapter, ws.workspaceId, { db, tenantId: ws.tenantId });

    const names = (await ws.adapter.getColumns(ws.tableId)).map((c) => c.name);
    expect(names.filter((n) => n === 'Tax Rates')).toHaveLength(1);
    expect(names[names.indexOf('Tax Rate') + 1]).toBe('Tax Rates');
    expect(await ratesOf(ws, single)).toBe('19 %');
    expect(await ratesOf(ws, withLines)).toBe('7 % + 19 %');
    expect(await ratesOf(ws, oldMixed)).toBe('7 % + 19 %');
    expect(await ratesOf(ws, otherTotal)).toBe('7 %');
    expect(await ratesOf(ws, noRate)).toBeNull();
    expect(await ratesOf(ws, archived)).toBe('7 %');
    // The old mixed receipt now also holds the tax groups its text was read from, so later writes agree with it.
    const columnsAfter = await ws.adapter.getColumns(ws.tableId);
    const linesId = columnsAfter.find((c) => c.name === 'Tax Lines')!.id;
    expect(JSON.parse(String((await ws.adapter.getRow(oldMixed))!.cells[linesId])).map((l: { rate: number }) => l.rate)).toEqual([7, 19]);
    expect((await ws.adapter.getRow(otherTotal))!.cells[linesId] ?? '').toBe('');

    // A second run changes nothing, also not a text a person has typed since.
    const columns = await ws.adapter.getColumns(ws.tableId);
    await ws.adapter.updateRow(single, { [columns.find((c) => c.name === 'Tax Rates')!.id]: 'von Hand' });
    await ensureReceiptsTable(ws.adapter, ws.workspaceId, { db, tenantId: ws.tenantId });
    expect(await ratesOf(ws, single)).toBe('von Hand');
  });
});

describe('a fill that was interrupted', () => {
  it('is taken up again by the next page load and writes only what is still empty', async () => {
    const ws = await createWorkspace();
    const columns = await ws.adapter.getColumns(ws.tableId);
    const ratesColumn = columns.find((c) => c.name === 'Tax Rates')!;
    const done = await ws.addReceipt({ Name: 'Schon gefüllt', Gross: 11.9, 'Tax Rate': 19, 'Tax Rates': 'von Hand' });
    const waiting = await ws.addReceipt({ Name: 'Wartet noch', Gross: 10.7, 'Tax Rate': 7 });
    // As after a restart in the middle: the column exists, the mark that it is filled does not.
    await ws.adapter.updateColumn(ratesColumn.id, { config: {} });

    await ensureReceiptsTable(ws.adapter, ws.workspaceId, { db, tenantId: ws.tenantId });
    expect(await ratesOf(ws, waiting)).toBe('7 %');
    expect(await ratesOf(ws, done)).toBe('von Hand');

    // Marked as filled: a receipt that loses its text later is not touched by a page load.
    await ws.adapter.updateRow(waiting, { [ratesColumn.id]: '' });
    await ensureReceiptsTable(ws.adapter, ws.workspaceId, { db, tenantId: ws.tenantId });
    expect(await ratesOf(ws, waiting)).toBe('');
  });
});

describe('later writes keep the text in step', () => {
  it('the meal form: tax lines typed there are what the row says; without lines, its single rate', async () => {
    const ws = await createWorkspace();
    const ctx = { workspaceId: ws.workspaceId, tenantId: ws.tenantId };
    const rowId = await ws.addReceipt(plainMealReceipt({ 'Tax Rate': 19 }));
    const guest = await contactStore(db, ctx).create({ name: 'Erika Beispiel', companyOrRole: 'Beispiel GmbH' });
    const details = {
      mealType: 'business_meal_external' as const,
      occasion: 'Abstimmung Relaunch Webshop',
      place: 'Testlokal, Musterstraße 1, 12345 Musterstadt',
      host: 'Inhaber Beispiel',
      tip: null,
      consumption: 'dine_in' as const,
      guestContactIds: [guest.id],
      date: null,
      gross: null,
    };
    await saveMealDetails(db, ctx, rowId, { ...details, taxLines: [{ rate: 7, net: 60, tax: 4.2 }, { rate: 19, net: 30, tax: 5.7 }] });
    expect(await ratesOf(ws, rowId)).toBe('7 % + 19 %');
    await saveMealDetails(db, ctx, rowId, { ...details, taxLines: null });
    expect(await ratesOf(ws, rowId)).toBe('19 %');
  });

  it('the meal form saved without touching the tax lines leaves the text alone, also one typed by hand', async () => {
    const ws = await createWorkspace();
    const ctx = { workspaceId: ws.workspaceId, tenantId: ws.tenantId };
    const rowId = await ws.addReceipt(plainMealReceipt({ 'Tax Rate': 7, 'Tax Rates': 'von Hand' }));
    const guest = await contactStore(db, ctx).create({ name: 'Erika Beispiel', companyOrRole: 'Beispiel GmbH' });
    await saveMealDetails(db, ctx, rowId, {
      mealType: 'business_meal_external', occasion: 'Abstimmung Relaunch Webshop', place: 'Testlokal, Musterstraße 1, 12345 Musterstadt',
      host: 'Inhaber Beispiel', tip: null, consumption: 'dine_in', taxLines: null, guestContactIds: [guest.id], date: null, gross: null,
    });
    expect(await ratesOf(ws, rowId)).toBe('von Hand');
  });

  it('a new reading of a stored receipt that prints two rates says both', async () => {
    const ws = await createWorkspace();
    const ctx = { workspaceId: ws.workspaceId, tenantId: ws.tenantId };
    // Wrong amounts from the old reader, so the new reading has something to change.
    const rowId = await ws.addReceipt(plainMealReceipt({ Vendor: 'Fantastic Foodbar', 'OCR Text': F.FOODBAR_TWO_RATES, Date: '2025-03-21', Gross: 37.7, Net: 31.68, 'Tax Rate': 19 }));
    const written = await applyNewReading(db, ctx, rowId, ['net', 'taxRate']);
    expect(written).toEqual(expect.arrayContaining(['net', 'taxRate']));
    expect(await ratesOf(ws, rowId)).toBe('7 % + 19 %');

    // The same on a receipt that is no meal: it keeps the printed tax groups as well.
    const plain = await ws.addReceipt({ Name: 'Einkauf', Vendor: 'Fantastic Foodbar', 'OCR Text': F.FOODBAR_TWO_RATES, Date: '2025-03-21', Gross: 37.7, Net: 31.68, 'Tax Rate': 19, Category: 'Bürobedarf' });
    await applyNewReading(db, ctx, plain, ['net', 'taxRate']);
    expect(await ratesOf(ws, plain)).toBe('7 % + 19 %');
  });

  it('a rate typed into the grid: the text follows, unless the receipt has tax lines that say more', async () => {
    const ws = await createWorkspace();
    const columns = await ws.adapter.getColumns(ws.tableId);
    const rateId = columns.find((c) => c.name === 'Tax Rate')!.id;
    const edit = async (rowId: string, rate: number | null) => {
      const stored = (await ws.adapter.getRow(rowId))!;
      await ws.adapter.updateRow(rowId, withTaxRates(columns, { [rateId]: rate }, stored.cells));
    };
    const plain = await ws.addReceipt({ Name: 'Bürobedarf', Gross: 11.9, 'Tax Rate': 19 });
    await edit(plain, 7);
    expect(await ratesOf(ws, plain)).toBe('7 %');
    await edit(plain, null);
    expect(await ratesOf(ws, plain)).toBe('');
    const mixed = await ws.addReceipt(plainMealReceipt({ 'Tax Rate': 7, 'Tax Lines': serializeTaxLines([{ rate: 7, net: 30, tax: 2.1 }, { rate: 19, net: 12, tax: 2.28 }]) }));
    await edit(mixed, 19);
    expect(await ratesOf(ws, mixed)).toBe('7 % + 19 %');
  });
});
