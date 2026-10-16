import { afterAll, describe, expect, it, vi } from 'vitest';
import type { CellValue } from '@marlinjai/data-table-core';
import { saveTaxSettings } from '@/lib/meals/service';
import { createWorkspace, db, plainMealReceipt, type TestWorkspace } from '../../../../test/db-helpers';

vi.mock('@/lib/prisma', async () => ({ prisma: (await import('../../../../test/db-helpers')).db }));

import { applyAttributionToLedger, setAttribution } from '@/lib/overview/attribution';
import { plannedAssignmentCells, routeAssignmentEdit, syncAssignmentCells } from '../assignment-sync';
import { clearItemDecision, deleteVendorRule, loadStatement, saveItemDecision, saveVendorRule, type TaxContext } from '../service';

/**
 * "Zuordnung" and "Business Share %" as a view of the finance decision, against
 * a real database (`pnpm test:db`): every write of a decision or a vendor rule
 * writes the cells, an edit of the cells on a decided receipt becomes a
 * decision, and nothing of this ever reaches another company.
 */

async function workspace(): Promise<{ ws: TestWorkspace; ctx: TaxContext }> {
  const ws = await createWorkspace();
  const ctx = { workspaceId: ws.workspaceId, tenantId: ws.tenantId };
  await saveTaxSettings(db, ctx, { smallBusiness: true });
  return { ws, ctx };
}

const software = (overrides: Record<string, CellValue> = {}) => ({
  Name: 'Abo Software',
  Vendor: 'Werkzeug GmbH',
  Gross: 119,
  Net: 100,
  Date: '2025-03-10',
  Category: 'Software & Lizenzen',
  Zuordnung: 'Geschäftlich',
  'Business Share %': 100,
  Currency: 'EUR',
  'FX Rate': 1,
  ...overrides,
});

async function cells(ws: TestWorkspace, rowId: string) {
  const columns = await ws.adapter.getColumns(ws.tableId);
  const row = (await ws.adapter.getRow(rowId))!;
  const z = columns.find((c) => c.name === 'Zuordnung')!;
  const share = columns.find((c) => c.name === 'Business Share %')!;
  const option = (await ws.adapter.getSelectOptions(z.id)).find((o) => o.id === row.cells[z.id])?.name ?? null;
  return { zuordnung: option, share: row.cells[share.id] === null || row.cells[share.id] === undefined ? null : Number(row.cells[share.id]) };
}

/** The cell edit the table sends, keyed by column id, select values as option ids. */
async function edit(ws: TestWorkspace, values: { zuordnung?: string | null; share?: number | null }) {
  const columns = await ws.adapter.getColumns(ws.tableId);
  const z = columns.find((c) => c.name === 'Zuordnung')!;
  const share = columns.find((c) => c.name === 'Business Share %')!;
  const out: Record<string, CellValue> = {};
  if (values.zuordnung !== undefined) {
    out[z.id] = values.zuordnung === null ? null : (await ws.adapter.getSelectOptions(z.id)).find((o) => o.name === values.zuordnung)!.id;
  }
  if (values.share !== undefined) out[share.id] = values.share;
  return out;
}

/** What the table's write does: route the edit, write the cells, then run what follows. */
async function write(ctx: TaxContext, rowId: string, asked: Record<string, CellValue>) {
  const routed = await routeAssignmentEdit(db, ctx, rowId, asked);
  const adapter = new (await import('@marlinjai/data-table-adapter-prisma')).PrismaAdapter({ prisma: db });
  await adapter.updateRow(rowId, routed.cells);
  await routed.afterWrite();
}

async function editAndWrite(ws: TestWorkspace, ctx: TaxContext, rowId: string, values: { zuordnung?: string | null; share?: number | null }) {
  await write(ctx, rowId, await edit(ws, values));
}

/** A plain cell edit by column name (select values by option name). */
async function setCells(ws: TestWorkspace, ctx: TaxContext, rowId: string, values: Record<string, CellValue>) {
  const columns = await ws.adapter.getColumns(ws.tableId);
  const out: Record<string, CellValue> = {};
  for (const [name, value] of Object.entries(values)) {
    const col = columns.find((c) => c.name === name)!;
    out[col.id] = col.type === 'select' && typeof value === 'string' ? (await ws.adapter.getSelectOptions(col.id)).find((o) => o.name === value)!.id : value;
  }
  await write(ctx, rowId, out);
}

async function itemOf(ctx: TaxContext, rowId: string) {
  return (await loadStatement(db, ctx.workspaceId, 2025)).items.find((i) => i.rowId === rowId)!;
}

afterAll(async () => {
  await db.$disconnect();
});

describe('a decision in the finance area writes the cells', () => {
  it('forward: deciding 40 percent business shows "Geschäftlich" 40 in the table; removing it restores the cells and the figure exactly', async () => {
    const { ws, ctx } = await workspace();
    const rowId = await ws.addReceipt(software());
    await saveItemDecision(db, ctx, rowId, { allocations: [{ purpose: 'business', shareBp: 4000 }], formLineKey: 'euer.work_equipment', note: 'Halb privat genutzt' });
    expect(await cells(ws, rowId)).toEqual({ zuordnung: 'Geschäftlich', share: 40 });
    expect((await itemOf(ctx, rowId)).decisionNote).toBe('Halb privat genutzt');

    await clearItemDecision(db, ctx, rowId);
    expect(await cells(ws, rowId)).toEqual({ zuordnung: 'Geschäftlich', share: 100 });
    expect((await itemOf(ctx, rowId)).allocations).toEqual([{ purpose: 'business', shareBp: 10000 }]);
    expect(await db.taxAssignmentOrigin.count({ where: { rowId } })).toBe(0);
  });

  it('deciding a receipt private gives it share 0', async () => {
    const { ws, ctx } = await workspace();
    const rowId = await ws.addReceipt(software());
    await saveItemDecision(db, ctx, rowId, { allocations: [{ purpose: 'private', shareBp: 10000 }] });
    expect(await cells(ws, rowId)).toEqual({ zuordnung: 'Privat', share: 0 });
  });

  it('a note alone is a change, and is kept when the treatment is saved again', async () => {
    const { ws, ctx } = await workspace();
    const rowId = await ws.addReceipt(software());
    const treatment = { allocations: [{ purpose: 'business', shareBp: 10000 }], formLineKey: 'euer.work_equipment' };
    await saveItemDecision(db, ctx, rowId, treatment);
    expect(await saveItemDecision(db, ctx, rowId, { ...treatment, note: 'Rechnung bis Jahresende nicht bezahlt' })).toEqual({ changed: true });
    expect(await saveItemDecision(db, ctx, rowId, { ...treatment, note: '  Rechnung bis Jahresende nicht bezahlt ' })).toEqual({ changed: false });
    expect((await itemOf(ctx, rowId)).decisionNote).toBe('Rechnung bis Jahresende nicht bezahlt');
  });

  it('a vendor rule writes the cells of every receipt it covers, and its removal gives them back', async () => {
    const { ws, ctx } = await workspace();
    const a = await ws.addReceipt(software());
    const b = await ws.addReceipt(software({ Date: '2025-05-01' }));
    const other = await ws.addReceipt(software({ Vendor: 'Anderer Laden' }));
    const rule = await saveVendorRule(db, ctx, { vendor: 'Werkzeug GmbH', treatment: { allocations: [{ purpose: 'study', shareBp: 10000 }], employmentLineKey: 'employment.study_costs' } });
    expect(await cells(ws, a)).toEqual({ zuordnung: 'Universität', share: 100 });
    expect(await cells(ws, b)).toEqual({ zuordnung: 'Universität', share: 100 });
    expect(await cells(ws, other)).toEqual({ zuordnung: 'Geschäftlich', share: 100 });
    await deleteVendorRule(db, ctx, rule.id);
    expect(await cells(ws, a)).toEqual({ zuordnung: 'Geschäftlich', share: 100 });
    expect(await cells(ws, b)).toEqual({ zuordnung: 'Geschäftlich', share: 100 });
  });
});

describe('an edit of the cells in the table', () => {
  it('on a decided receipt becomes a decision (keeping its lines and note), and the finance area reads it', async () => {
    const { ws, ctx } = await workspace();
    const rowId = await ws.addReceipt(software());
    await saveItemDecision(db, ctx, rowId, { allocations: [{ purpose: 'business', shareBp: 4000 }], formLineKey: 'euer.telecom', note: 'Telefon' });
    await editAndWrite(ws, ctx, rowId, { share: 70 });
    const item = await itemOf(ctx, rowId);
    expect(item.allocations).toEqual([{ purpose: 'business', shareBp: 7000 }]);
    expect(item.formLineKey).toBe('euer.telecom');
    expect(item.decisionNote).toBe('Telefon');
    expect(await cells(ws, rowId)).toEqual({ zuordnung: 'Geschäftlich', share: 70 });
  });

  it('backtrack: changed to private and back to business, the cells and the finance area agree at every step', async () => {
    const { ws, ctx } = await workspace();
    const rowId = await ws.addReceipt(software());
    await saveItemDecision(db, ctx, rowId, { allocations: [{ purpose: 'business', shareBp: 10000 }], formLineKey: 'euer.work_equipment' });
    await editAndWrite(ws, ctx, rowId, { zuordnung: 'Privat' });
    expect(await cells(ws, rowId)).toEqual({ zuordnung: 'Privat', share: 0 });
    expect((await itemOf(ctx, rowId)).allocations).toEqual([{ purpose: 'private', shareBp: 10000 }]);
    await editAndWrite(ws, ctx, rowId, { zuordnung: 'Geschäftlich' });
    expect(await cells(ws, rowId)).toEqual({ zuordnung: 'Geschäftlich', share: 100 });
    const item = await itemOf(ctx, rowId);
    expect(item.allocations).toEqual([{ purpose: 'business', shareBp: 10000 }]);
    // The line came back from the category, since the private decision had none.
    expect(item.formLineKey).toBe('euer.work_equipment');
  });

  it('on a receipt its vendor rule decides, the edit becomes the receipt\'s own decision', async () => {
    const { ws, ctx } = await workspace();
    const rowId = await ws.addReceipt(software());
    await saveVendorRule(db, ctx, { vendor: 'Werkzeug GmbH', treatment: { allocations: [{ purpose: 'business', shareBp: 10000 }], formLineKey: 'euer.work_equipment' } });
    await editAndWrite(ws, ctx, rowId, { share: 50 });
    const item = await itemOf(ctx, rowId);
    expect(item.hasDecision).toBe(true);
    expect(item.allocations).toEqual([{ purpose: 'business', shareBp: 5000 }]);
    // Clearing does not land where only the rule decides: there is nothing of the receipt's own to clear,
    // and the cells keep showing the rule.
    const other = await ws.addReceipt(software({ Date: '2025-06-01' }));
    await editAndWrite(ws, ctx, other, { zuordnung: null });
    expect(await cells(ws, other)).toEqual({ zuordnung: 'Geschäftlich', share: 100 });
    expect((await itemOf(ctx, other)).hasDecision).toBe(false);
  });

  it('a private receipt switched to business without a share counts in full, not as private', async () => {
    const { ws, ctx } = await workspace();
    const rowId = await ws.addReceipt(software({ Zuordnung: 'Privat', 'Business Share %': 0 }));
    await editAndWrite(ws, ctx, rowId, { zuordnung: 'Geschäftlich' });
    expect(await cells(ws, rowId)).toEqual({ zuordnung: 'Geschäftlich', share: 100 });
    expect((await itemOf(ctx, rowId)).allocations).toEqual([{ purpose: 'business', shareBp: 10000 }]);
  });

  it('an edit that changes nothing on a receipt its rule decides keeps it following the rule', async () => {
    const { ws, ctx } = await workspace();
    const rowId = await ws.addReceipt(software());
    await saveVendorRule(db, ctx, { vendor: 'Werkzeug GmbH', treatment: { allocations: [{ purpose: 'business', shareBp: 5000 }], formLineKey: 'euer.work_equipment' } });
    await editAndWrite(ws, ctx, rowId, { zuordnung: 'Geschäftlich', share: 50 });
    await editAndWrite(ws, ctx, rowId, { share: null });
    expect((await itemOf(ctx, rowId)).hasDecision).toBe(false);
    expect(await cells(ws, rowId)).toEqual({ zuordnung: 'Geschäftlich', share: 50 });
  });

  it('an edit that would need a statement line the receipt has none for does not land: nothing is stored, the cells keep showing the decision', async () => {
    const { ws, ctx } = await workspace();
    const rowId = await ws.addReceipt(software({ Category: null }));
    await saveItemDecision(db, ctx, rowId, { allocations: [{ purpose: 'private', shareBp: 10000 }] });
    await editAndWrite(ws, ctx, rowId, { zuordnung: 'Geschäftlich' });
    expect((await itemOf(ctx, rowId)).allocations).toEqual([{ purpose: 'private', shareBp: 10000 }]);
    expect(await cells(ws, rowId)).toEqual({ zuordnung: 'Privat', share: 0 });
  });

  it('re-selecting what is shown for a rule with an explicit private part keeps the receipt on the rule', async () => {
    const { ws, ctx } = await workspace();
    const rowId = await ws.addReceipt(software());
    await saveVendorRule(db, ctx, { vendor: 'Werkzeug GmbH', treatment: { allocations: [{ purpose: 'business', shareBp: 5000 }, { purpose: 'private', shareBp: 5000 }], formLineKey: 'euer.work_equipment' } });
    await editAndWrite(ws, ctx, rowId, { zuordnung: 'Geschäftlich' });
    expect((await itemOf(ctx, rowId)).hasDecision).toBe(false);
  });

  it('typing back the rounded share of a decided 33.33 percent changes nothing', async () => {
    const { ws, ctx } = await workspace();
    const rowId = await ws.addReceipt(software());
    await saveItemDecision(db, ctx, rowId, { allocations: [{ purpose: 'business', shareBp: 3333 }], formLineKey: 'euer.work_equipment' });
    await editAndWrite(ws, ctx, rowId, { share: 33 });
    expect((await itemOf(ctx, rowId)).allocations).toEqual([{ purpose: 'business', shareBp: 3333 }]);
    expect(await cells(ws, rowId)).toEqual({ zuordnung: 'Geschäftlich', share: 33.33 });
  });

  it('a private share set to 0 is kept, and comes back when the receipt stops being private', async () => {
    const { ws, ctx } = await workspace();
    const rowId = await ws.addReceipt(software({ Zuordnung: 'Privat', 'Business Share %': 40 }));
    await syncAssignmentCells(db, ctx, { rowIds: [rowId] });
    expect(await cells(ws, rowId)).toEqual({ zuordnung: 'Privat', share: 0 });
    await editAndWrite(ws, ctx, rowId, { zuordnung: 'Geschäftlich' });
    expect(await cells(ws, rowId)).toEqual({ zuordnung: 'Geschäftlich', share: 40 });
    expect(await db.taxAssignmentOrigin.count({ where: { rowId } })).toBe(0);
  });

  it('a vendor rule brings only its own vendor\'s receipts in step', async () => {
    const { ws, ctx } = await workspace();
    const elsewhere = await ws.addReceipt(software({ Vendor: 'Anderer Laden', Zuordnung: 'Privat', 'Business Share %': 100 }));
    await saveVendorRule(db, ctx, { vendor: 'Werkzeug GmbH', treatment: { allocations: [{ purpose: 'private', shareBp: 10000 }] } });
    expect(await cells(ws, elsewhere)).toEqual({ zuordnung: 'Privat', share: 100 });
  });

  it('clearing the assignment of a receipt with its own decision AND a vendor rule shows the rule again', async () => {
    const { ws, ctx } = await workspace();
    const rowId = await ws.addReceipt(software());
    await saveVendorRule(db, ctx, { vendor: 'Werkzeug GmbH', treatment: { allocations: [{ purpose: 'study', shareBp: 10000 }], employmentLineKey: 'employment.study_costs' } });
    await editAndWrite(ws, ctx, rowId, { zuordnung: 'Privat' });
    expect((await itemOf(ctx, rowId)).hasDecision).toBe(true);
    await editAndWrite(ws, ctx, rowId, { zuordnung: null });
    expect((await itemOf(ctx, rowId)).hasDecision).toBe(false);
    expect(await cells(ws, rowId)).toEqual({ zuordnung: 'Universität', share: 100 });
  });

  it('clearing the assignment of a receipt with its own decision removes the decision', async () => {
    const { ws, ctx } = await workspace();
    const rowId = await ws.addReceipt(software());
    await saveItemDecision(db, ctx, rowId, { allocations: [{ purpose: 'business', shareBp: 10000 }], formLineKey: 'euer.work_equipment' });
    await editAndWrite(ws, ctx, rowId, { zuordnung: null });
    expect((await itemOf(ctx, rowId)).hasDecision).toBe(false);
    expect((await cells(ws, rowId)).zuordnung).toBeNull();
  });

  it('on an undecided receipt the cells are the source and pass through; a private one gets share 0', async () => {
    const { ws, ctx } = await workspace();
    const rowId = await ws.addReceipt(software());
    const asked = await edit(ws, { share: 30 });
    expect((await routeAssignmentEdit(db, ctx, rowId, asked)).cells).toEqual(asked);
    await editAndWrite(ws, ctx, rowId, { zuordnung: 'Privat' });
    expect(await cells(ws, rowId)).toEqual({ zuordnung: 'Privat', share: 0 });
    expect((await itemOf(ctx, rowId)).hasDecision).toBe(false);
  });

  it('on a meal the cell is the meal register\'s input and is written as given', async () => {
    const { ws, ctx } = await workspace();
    const rowId = await ws.addReceipt(plainMealReceipt());
    const asked = await edit(ws, { zuordnung: 'Privat' });
    expect((await routeAssignmentEdit(db, ctx, rowId, asked)).cells).toEqual(asked);
  });

  it('other columns pass through untouched', async () => {
    const { ws, ctx } = await workspace();
    const rowId = await ws.addReceipt(software());
    const columns = await ws.adapter.getColumns(ws.tableId);
    const name = columns.find((c) => c.name === 'Name')!;
    expect((await routeAssignmentEdit(db, ctx, rowId, { [name.id]: 'Neu' })).cells).toEqual({ [name.id]: 'Neu' });
  });
});

describe('edits of vendor, date or category', () => {
  it('a receipt whose date moves before the rule\'s start leaves the rule, and its cells come back', async () => {
    const { ws, ctx } = await workspace();
    const rowId = await ws.addReceipt(software({ Date: '2025-06-01' }));
    await saveVendorRule(db, ctx, { vendor: 'Werkzeug GmbH', effectiveFrom: '2025-05-01', treatment: { allocations: [{ purpose: 'private', shareBp: 10000 }] } });
    expect(await cells(ws, rowId)).toEqual({ zuordnung: 'Privat', share: 0 });
    await setCells(ws, ctx, rowId, { Date: '2025-04-01' });
    expect(await cells(ws, rowId)).toEqual({ zuordnung: 'Geschäftlich', share: 100 });
    await setCells(ws, ctx, rowId, { Date: '2025-07-01' });
    expect(await cells(ws, rowId)).toEqual({ zuordnung: 'Privat', share: 0 });
  });

  it('a receipt a rule made private that becomes a meal is judged by the register from its own cell again', async () => {
    const { ws, ctx } = await workspace();
    const rowId = await ws.addReceipt(software());
    await saveVendorRule(db, ctx, { vendor: 'Werkzeug GmbH', treatment: { allocations: [{ purpose: 'private', shareBp: 10000 }] } });
    await setCells(ws, ctx, rowId, { Category: 'Bewirtung' });
    expect(await cells(ws, rowId)).toEqual({ zuordnung: 'Geschäftlich', share: 100 });
    expect(await db.taxAssignmentOrigin.count({ where: { rowId } })).toBe(0);
  });
});

describe('re-entry', () => {
  it('decide, remove, decide again: the kept values stay the ones from before the first decision', async () => {
    const { ws, ctx } = await workspace();
    const rowId = await ws.addReceipt(software({ 'Business Share %': 80 }));
    const half = { allocations: [{ purpose: 'business', shareBp: 5000 }], formLineKey: 'euer.work_equipment' };
    await saveItemDecision(db, ctx, rowId, half);
    await clearItemDecision(db, ctx, rowId);
    expect(await cells(ws, rowId)).toEqual({ zuordnung: 'Geschäftlich', share: 80 });
    await saveItemDecision(db, ctx, rowId, { ...half, allocations: [{ purpose: 'business', shareBp: 2000 }] });
    await saveItemDecision(db, ctx, rowId, half);
    await clearItemDecision(db, ctx, rowId);
    expect(await cells(ws, rowId)).toEqual({ zuordnung: 'Geschäftlich', share: 80 });
  });

  it('a save without a note keeps the stored note; an empty note removes it', async () => {
    const { ws, ctx } = await workspace();
    const rowId = await ws.addReceipt(software());
    const treatment = { allocations: [{ purpose: 'business', shareBp: 10000 }], formLineKey: 'euer.work_equipment' };
    await saveItemDecision(db, ctx, rowId, { ...treatment, note: 'Begründung' });
    await saveItemDecision(db, ctx, rowId, { ...treatment, allocations: [{ purpose: 'business', shareBp: 9000 }] });
    expect((await itemOf(ctx, rowId)).decisionNote).toBe('Begründung');
    await saveItemDecision(db, ctx, rowId, { ...treatment, note: '' });
    expect((await itemOf(ctx, rowId)).decisionNote).toBeNull();
  });

  it('a renamed assignment option refuses a finance save before anything is stored', async () => {
    const { ws, ctx } = await workspace();
    const rowId = await ws.addReceipt(software());
    const columns = await ws.adapter.getColumns(ws.tableId);
    const z = columns.find((c) => c.name === 'Zuordnung')!;
    const option = (await ws.adapter.getSelectOptions(z.id)).find((o) => o.name === 'Universität')!;
    await ws.adapter.updateSelectOption(option.id, { name: 'Uni' });
    await expect(saveItemDecision(db, ctx, rowId, { allocations: [{ purpose: 'private', shareBp: 10000 }] })).rejects.toMatchObject({ code: 'assignment_columns_missing' });
    expect(await db.taxItemDecision.count({ where: { rowId } })).toBe(0);
  });
});

describe('company isolation', () => {
  it('a decision of one company never writes cells or decisions of another', async () => {
    const one = await workspace();
    const two = await workspace();
    const mine = await one.ws.addReceipt(software());
    const theirs = await two.ws.addReceipt(software());
    await saveVendorRule(db, one.ctx, { vendor: 'Werkzeug GmbH', treatment: { allocations: [{ purpose: 'private', shareBp: 10000 }] } });
    expect(await cells(one.ws, mine)).toEqual({ zuordnung: 'Privat', share: 0 });
    expect(await cells(two.ws, theirs)).toEqual({ zuordnung: 'Geschäftlich', share: 100 });
    // A row of another company is unknown to this company's sync and routing.
    expect(await plannedAssignmentCells(db, one.ctx.workspaceId, { rowIds: [theirs] })).toEqual([]);
    const asked = await edit(two.ws, { share: 10 });
    expect((await routeAssignmentEdit(db, one.ctx, theirs, asked)).cells).toEqual(asked);
    expect(await db.taxItemDecision.count({ where: { rowId: theirs } })).toBe(0);
  });
});

describe('the one-time sync and the overview\'s per-vendor share', () => {
  it('resume: a sync over cells that disagree writes them once, a second run plans nothing, and no figure moves', async () => {
    const { ws, ctx } = await workspace();
    const decided = await ws.addReceipt(software());
    const privat = await ws.addReceipt(software({ Zuordnung: 'Privat', 'Business Share %': 100 }));
    // A decision stored the way it was before this change: the cells were not touched.
    await db.taxItemDecision.create({ data: { authWorkspaceId: ctx.workspaceId, authTenantId: ctx.tenantId, rowId: decided, allocations: [{ purpose: 'study', shareBp: 2000 }], employmentLineKey: 'employment.study_costs' } });
    const before = await loadStatement(db, ctx.workspaceId, 2025);
    expect(await syncAssignmentCells(db, ctx)).toEqual({ written: 2, failed: [] });
    expect(await cells(ws, decided)).toEqual({ zuordnung: 'Universität', share: 20 });
    expect(await cells(ws, privat)).toEqual({ zuordnung: 'Privat', share: 0 });
    expect(await syncAssignmentCells(db, ctx)).toEqual({ written: 0, failed: [] });
    expect(await db.taxAssignmentOrigin.findUnique({ where: { rowId: decided } })).toMatchObject({ zuordnung: 'Geschäftlich', sharePercent: 100 });
    const after = await loadStatement(db, ctx.workspaceId, 2025);
    expect([after.businessExpenseCents, after.employmentCostCents, after.countedItems]).toEqual([before.businessExpenseCents, before.employmentCostCents, before.countedItems]);
  });

  it('"apply to ledger" leaves decided and private receipts alone', async () => {
    const { ws, ctx } = await workspace();
    const decided = await ws.addReceipt(software());
    const privat = await ws.addReceipt(software({ Zuordnung: 'Privat', 'Business Share %': 0 }));
    const open = await ws.addReceipt(software());
    await saveItemDecision(db, ctx, decided, { allocations: [{ purpose: 'business', shareBp: 10000 }], formLineKey: 'euer.work_equipment' });
    await setAttribution(ctx.workspaceId, [{ vendor: 'Werkzeug', share: 30 }], 100, ctx.tenantId);
    expect(await applyAttributionToLedger(ctx.workspaceId)).toBe(1);
    expect(await cells(ws, decided)).toEqual({ zuordnung: 'Geschäftlich', share: 100 });
    expect(await cells(ws, privat)).toEqual({ zuordnung: 'Privat', share: 0 });
    expect(await cells(ws, open)).toEqual({ zuordnung: 'Geschäftlich', share: 30 });
  });
});
