import { afterAll, describe, expect, it, vi } from 'vitest';
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
    // The lines had brought the number column to their first rate, 7: without lines the row says that single rate.
    expect(await ratesOf(ws, rowId)).toBe('7 %');
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

describe('one order of rates, also for receipts stored before it', () => {
  async function valueOf(ws: TestWorkspace, rowId: string, name: string): Promise<unknown> {
    const columns = await ws.adapter.getColumns(ws.tableId);
    return (await ws.adapter.getRow(rowId))!.cells[columns.find((c) => c.name === name)!.id] ?? null;
  }

  it('a table filled in the old order gets one more pass: a text the old order made is rewritten, a typed one stays', async () => {
    const ws = await createWorkspace();
    // 7 percent 100.00/7.00 (107.00) and 19 percent 99.00/18.81 (117.81): by net 7 came first, by the bill 19 does.
    const lines = serializeTaxLines([{ rate: 7, net: 100, tax: 7 }, { rate: 19, net: 99, tax: 18.81 }]);
    const old = await ws.addReceipt(plainMealReceipt({ 'Tax Rate': 19, 'Tax Lines': lines, 'Tax Rates': '7 % + 19 %' }));
    const typed = await ws.addReceipt(plainMealReceipt({ 'Tax Rate': 19, 'Tax Lines': lines, 'Tax Rates': 'von Hand' }));
    const right = await ws.addReceipt({ Name: 'Bürobedarf', Gross: 11.9, 'Tax Rate': 19, 'Tax Rates': '19 %' });
    // As a table filled before: only the first marker.
    const ratesColumn = (await ws.adapter.getColumns(ws.tableId)).find((c) => c.name === 'Tax Rates')!;
    await ws.adapter.updateColumn(ratesColumn.id, { config: { taxRatesFilled: true } });

    await ensureReceiptsTable(ws.adapter, ws.workspaceId, { db, tenantId: ws.tenantId });
    expect(await ratesOf(ws, old)).toBe('19 % + 7 %');
    expect(await ratesOf(ws, typed)).toBe('von Hand');
    expect(await ratesOf(ws, right)).toBe('19 %');

    // Done once: a text set back to the old order later is left as it is.
    await ws.adapter.updateRow(old, { [ratesColumn.id]: '7 % + 19 %' });
    await ensureReceiptsTable(ws.adapter, ws.workspaceId, { db, tenantId: ws.tenantId });
    expect(await ratesOf(ws, old)).toBe('7 % + 19 %');
  });

  it('the meal form: new tax lines bring the number column with them', async () => {
    const ws = await createWorkspace();
    const ctx = { workspaceId: ws.workspaceId, tenantId: ws.tenantId };
    const rowId = await ws.addReceipt(plainMealReceipt({ 'Tax Rate': 19 }));
    const guest = await contactStore(db, ctx).create({ name: 'Erika Beispiel', companyOrRole: 'Beispiel GmbH' });
    await saveMealDetails(db, ctx, rowId, {
      mealType: 'business_meal_external', occasion: 'Abstimmung Relaunch Webshop', place: 'Testlokal, Musterstraße 1, 12345 Musterstadt',
      host: 'Inhaber Beispiel', tip: null, consumption: 'dine_in', guestContactIds: [guest.id], date: null, gross: null,
      taxLines: [{ rate: 7, net: 60, tax: 4.2 }, { rate: 19, net: 30, tax: 5.7 }],
    });
    expect(await valueOf(ws, rowId, 'Tax Rate')).toBe(7);
    expect(await ratesOf(ws, rowId)).toBe('7 % + 19 %');
  });

  it('a rate taken from the review list without lines of its own clears stored lines that start with another rate', async () => {
    const ws = await createWorkspace();
    const ctx = { workspaceId: ws.workspaceId, tenantId: ws.tenantId };
    // The text proves 19 percent on the whole bill; the stored lines (typed or read by a model) say 7 percent.
    const text = 'Musterladen\nNetto 100,00\nMwSt 19% 19,00\nSumme 119,00';
    const rowId = await ws.addReceipt({ Name: 'Einkauf', Vendor: 'Musterladen', 'OCR Text': text, Gross: 119, Net: 111.21, 'Tax Rate': 7, Category: 'Bürobedarf', 'Tax Lines': serializeTaxLines([{ rate: 7, net: 111.21, tax: 7.79 }]) });
    await applyNewReading(db, ctx, rowId, ['net', 'taxRate']);
    expect(await valueOf(ws, rowId, 'Tax Rate')).toBe(19);
    expect(await ratesOf(ws, rowId)).toBe('19 %');
  });
});

describe('the one order, after the third review', () => {
  async function valueOf(ws: TestWorkspace, rowId: string, name: string): Promise<unknown> {
    const columns = await ws.adapter.getColumns(ws.tableId);
    return (await ws.adapter.getRow(rowId))!.cells[columns.find((c) => c.name === name)!.id] ?? null;
  }
  const asOldTable = async (ws: TestWorkspace) => {
    const ratesColumn = (await ws.adapter.getColumns(ws.tableId)).find((c) => c.name === 'Tax Rates')!;
    await ws.adapter.updateColumn(ratesColumn.id, { config: { taxRatesFilled: true } });
    return ratesColumn;
  };

  it('the pass also sets the number where an old reading put the rate of the largest single line', async () => {
    const ws = await createWorkspace();
    // Two 7 percent lines (53.50 and 42.80, 96.30 in all) and one 19 percent line (95.20): the old reader took 19.
    const lines = serializeTaxLines([{ rate: 7, net: 50, tax: 3.5 }, { rate: 7, net: 40, tax: 2.8 }, { rate: 19, net: 80, tax: 15.2 }]);
    const rowId = await ws.addReceipt({ Name: 'Einkauf', Gross: 191.5, 'Tax Rate': 19, 'Tax Lines': lines, 'Tax Rates': '7 % + 19 %' });
    // A rate a person typed that is neither the old pick nor the old text's first rate stays.
    const typed = await ws.addReceipt({ Name: 'Einkauf', Gross: 191.5, 'Tax Rate': 0, 'Tax Lines': lines, 'Tax Rates': '7 % + 19 %' });
    await asOldTable(ws);
    await ensureReceiptsTable(ws.adapter, ws.workspaceId, { db, tenantId: ws.tenantId });
    expect(await valueOf(ws, rowId, 'Tax Rate')).toBe(7);
    expect(await ratesOf(ws, rowId)).toBe('7 % + 19 %');
    expect(await valueOf(ws, typed, 'Tax Rate')).toBe(0);
  });

  it('an interrupted pass is taken up again and sets its marker only after a complete run', async () => {
    const ws = await createWorkspace();
    const lines = serializeTaxLines([{ rate: 7, net: 100, tax: 7 }, { rate: 19, net: 99, tax: 18.81 }]);
    const first = await ws.addReceipt(plainMealReceipt({ 'Tax Rate': 7, 'Tax Lines': lines, 'Tax Rates': '7 % + 19 %' }));
    const second = await ws.addReceipt(plainMealReceipt({ 'Tax Rate': 7, 'Tax Lines': lines, 'Tax Rates': '7 % + 19 %' }));
    const ratesColumn = await asOldTable(ws);
    // Every look at the clock is a minute later than the one before: the pass runs out of its budget before the first row.
    const real = Date.now;
    let calls = 0;
    const spy = vi.spyOn(Date, 'now').mockImplementation(() => real() + ++calls * 60_000);
    try {
      await ensureReceiptsTable(ws.adapter, ws.workspaceId, { db, tenantId: ws.tenantId });
    } finally {
      spy.mockRestore();
    }
    const config = (await ws.adapter.getColumns(ws.tableId)).find((c) => c.id === ratesColumn.id)!.config as Record<string, unknown>;
    expect(config.taxRatesOrdered).toBeUndefined();
    // The next page load finishes it.
    await ensureReceiptsTable(ws.adapter, ws.workspaceId, { db, tenantId: ws.tenantId });
    expect(await ratesOf(ws, first)).toBe('19 % + 7 %');
    expect(await ratesOf(ws, second)).toBe('19 % + 7 %');
    expect(await valueOf(ws, first, 'Tax Rate')).toBe(19);
  });

  it('taking the total in the review list takes the rate read with it, so the two columns agree', async () => {
    const ws = await createWorkspace();
    const ctx = { workspaceId: ws.workspaceId, tenantId: ws.tenantId };
    const rowId = await ws.addReceipt({ Name: 'Einkauf', Vendor: 'Fantastic Foodbar', 'OCR Text': F.FOODBAR_TWO_RATES, Date: '2025-03-21', Gross: 30, Net: 25.21, 'Tax Rate': 19, Category: 'Bürobedarf' });
    const written = await applyNewReading(db, ctx, rowId, ['gross']);
    expect(written).toEqual(expect.arrayContaining(['gross', 'taxRate']));
    const rate = await valueOf(ws, rowId, 'Tax Rate');
    expect(String(await ratesOf(ws, rowId)).startsWith(`${rate} %`)).toBe(true);
  });

  it('a meal\'s typed lines stay when the reading brings a rate without lines; the rate is then not written', async () => {
    const ws = await createWorkspace();
    const ctx = { workspaceId: ws.workspaceId, tenantId: ws.tenantId };
    // Net, tax and total stated next to their labels at a rate that is no German one: a rate, no printed groups.
    const text = 'Musterladen\nNetto 100,00\nMwSt 8,00\nSumme 108,00';
    const typedLines = serializeTaxLines([{ rate: 7, net: 100.93, tax: 7.07 }]);
    const rowId = await ws.addReceipt(plainMealReceipt({ 'OCR Text': text, Gross: 108, Net: 100.93, 'Tax Rate': 7, 'Tax Lines': typedLines }));
    await applyNewReading(db, ctx, rowId, ['net', 'taxRate']);
    expect(await valueOf(ws, rowId, 'Tax Lines')).toBe(typedLines);
    expect(await valueOf(ws, rowId, 'Tax Rate')).toBe(7);
    // The net the reading proves is taken; the rate and the lines are the person's.
    expect(await valueOf(ws, rowId, 'Net')).toBe(100);
  });
});
