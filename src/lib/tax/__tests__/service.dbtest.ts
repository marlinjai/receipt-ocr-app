import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { saveTaxSettings } from '@/lib/meals/service';
import { TreatmentError } from '../decisions';
import {
  TaxServiceError,
  clearItemDecision,
  deleteDecisionsForRows,
  deleteVendorRule,
  loadStatement,
  saveItemDecision,
  saveVendorRule,
  type TaxContext,
} from '../service';
import { createWorkspace, db, plainMealReceipt, type TestWorkspace } from '../../../../test/db-helpers';

/**
 * The finance service against a real database: the real Prisma queries, the
 * real data-table adapter, the real migration 0009. Run with `pnpm test:db`.
 */

let ws: TestWorkspace;
let other: TestWorkspace;
let ctx: TaxContext;
let otherCtx: TaxContext;

const receipt = (overrides: Record<string, string | number> = {}) => ({
  Name: 'Rechnung Internet',
  Vendor: 'Netzwerk Nord GmbH',
  Gross: 39.99,
  Date: '2025-03-14',
  Category: 'Telefon & Internet',
  Zuordnung: 'Geschäftlich',
  Currency: 'EUR',
  'FX Rate': 1,
  ...overrides,
});

const HALF_AND_STUDY = {
  allocations: [{ purpose: 'business', shareBp: 5000 }, { purpose: 'study', shareBp: 3000 }],
  formLineKey: 'euer.telecom',
  employmentLineKey: 'employment.study_costs',
};

const code = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    if (e instanceof TaxServiceError || e instanceof TreatmentError) return e.code;
    throw e;
  }
  return 'no error';
};

beforeAll(async () => {
  ws = await createWorkspace();
  other = await createWorkspace();
  ctx = { workspaceId: ws.workspaceId, tenantId: ws.tenantId };
  otherCtx = { workspaceId: other.workspaceId, tenantId: other.tenantId };
  await saveTaxSettings(db, ctx, { smallBusiness: true });
  await saveTaxSettings(db, otherCtx, { smallBusiness: true });
});

afterAll(async () => {
  await db.$disconnect();
});

const line = (view: Awaited<ReturnType<typeof loadStatement>>, key: string) => view.lines.find((l) => l.key === key)?.cents ?? 0;
const item = (view: Awaited<ReturnType<typeof loadStatement>>, rowId: string) => view.items.find((i) => i.rowId === rowId)!;

describe('forward: receipt, decision, statement', () => {
  it('a receipt counts by its older columns, then by the decision made on it', async () => {
    const rowId = await ws.addReceipt(receipt());
    let view = await loadStatement(db, ws.workspaceId, 2025);
    expect(item(view, rowId)).toMatchObject({ counted: true, allocationOrigin: 'legacy_columns', hasDecision: false });
    const before = line(view, 'euer.telecom');

    expect(await saveItemDecision(db, ctx, rowId, HALF_AND_STUDY)).toEqual({ changed: true });
    view = await loadStatement(db, ws.workspaceId, 2025);
    expect(item(view, rowId)).toMatchObject({ allocationOrigin: 'item', hasDecision: true });
    // 39.99 at 50 percent is 19.995, rounded half up to 20.00; at 30 percent 12.00.
    expect(line(view, 'euer.telecom')).toBe(before - 3999 + 2000);
    expect(item(view, rowId).parts.map((p) => [p.lineKey, p.cents])).toEqual([
      ['euer.telecom', 2000],
      ['employment.study_costs', 1200],
    ]);
    const stored = await db.taxItemDecision.findUnique({ where: { rowId } });
    expect(stored).toMatchObject({ authWorkspaceId: ws.workspaceId, authTenantId: ws.tenantId });
  });

  it('a receipt nobody assigned waits in the queue and is in no total', async () => {
    const fresh = await createWorkspace();
    await saveTaxSettings(db, { workspaceId: fresh.workspaceId, tenantId: fresh.tenantId }, { smallBusiness: true });
    const rowId = await fresh.addReceipt({ Name: 'Unklar', Vendor: 'Irgendwer', Gross: 44.8, Date: '2025-11-03', Currency: 'EUR', 'FX Rate': 1 });
    const view = await loadStatement(db, fresh.workspaceId, 2025);
    expect(item(view, rowId).checks.map((c) => c.kind)).toEqual(['no_allocation']);
    expect(view).toMatchObject({ businessExpenseCents: 0, blockedItems: 1, countedItems: 0 });
  });
});

describe('backtrack and revise', () => {
  it('saving the same decision again writes nothing', async () => {
    const rowId = await ws.addReceipt(receipt());
    await saveItemDecision(db, ctx, rowId, HALF_AND_STUDY);
    const first = await db.taxItemDecision.findUnique({ where: { rowId } });
    expect(await saveItemDecision(db, ctx, rowId, HALF_AND_STUDY)).toEqual({ changed: false });
    const second = await db.taxItemDecision.findUnique({ where: { rowId } });
    expect(second?.updatedAt).toEqual(first?.updatedAt);
  });

  it('changing a decision changes the figure, removing it restores the earlier one exactly', async () => {
    const fresh = await createWorkspace();
    const freshCtx = { workspaceId: fresh.workspaceId, tenantId: fresh.tenantId };
    await saveTaxSettings(db, freshCtx, { smallBusiness: true });
    const rowId = await fresh.addReceipt(receipt());
    const base = (await loadStatement(db, fresh.workspaceId, 2025)).businessExpenseCents;
    expect(base).toBe(3999);

    await saveItemDecision(db, freshCtx, rowId, HALF_AND_STUDY);
    expect((await loadStatement(db, fresh.workspaceId, 2025)).businessExpenseCents).toBe(2000);
    await saveItemDecision(db, freshCtx, rowId, { allocations: [{ purpose: 'private', shareBp: 10000 }] });
    const privateView = await loadStatement(db, fresh.workspaceId, 2025);
    expect(privateView.businessExpenseCents).toBe(0);
    expect(privateView.privateCents).toBe(3999);

    expect(await clearItemDecision(db, freshCtx, rowId)).toEqual({ changed: true });
    expect((await loadStatement(db, fresh.workspaceId, 2025)).businessExpenseCents).toBe(base);
    expect(await clearItemDecision(db, freshCtx, rowId)).toEqual({ changed: false });
  });

  it('a vendor rule moves every receipt of the vendor except the individually decided ones', async () => {
    const fresh = await createWorkspace();
    const freshCtx = { workspaceId: fresh.workspaceId, tenantId: fresh.tenantId };
    await saveTaxSettings(db, freshCtx, { smallBusiness: true });
    const a = await fresh.addReceipt(receipt({ Date: '2025-01-14' }));
    const b = await fresh.addReceipt(receipt({ Date: '2025-08-14', Vendor: 'NETZWERK NORD' }));
    const decided = await fresh.addReceipt(receipt({ Date: '2025-09-14' }));
    const unrelated = await fresh.addReceipt(receipt({ Vendor: 'Anderer Laden', Date: '2025-09-15' }));
    await saveItemDecision(db, freshCtx, decided, {
      allocations: [{ purpose: 'business', shareBp: 10000 }],
      formLineKey: 'euer.work_equipment',
    });

    const rule = await saveVendorRule(db, freshCtx, { vendor: 'Netzwerk Nord GmbH', treatment: HALF_AND_STUDY });
    let view = await loadStatement(db, fresh.workspaceId, 2025);
    expect(item(view, a).allocationOrigin).toBe('vendor_rule');
    expect(item(view, b).allocationOrigin).toBe('vendor_rule');
    expect(item(view, decided).allocationOrigin).toBe('item');
    expect(item(view, unrelated).allocationOrigin).toBe('legacy_columns');
    expect(view.vendorRules).toHaveLength(1);

    // A new entry from July: the January receipt keeps the earlier treatment.
    await saveVendorRule(db, freshCtx, {
      vendor: 'Netzwerk Nord GmbH',
      effectiveFrom: '2025-07-01',
      treatment: { allocations: [{ purpose: 'business', shareBp: 10000 }], formLineKey: 'euer.telecom' },
    });
    view = await loadStatement(db, fresh.workspaceId, 2025);
    expect(item(view, a).parts.map((p) => p.cents)).toEqual([2000, 1200]);
    expect(item(view, b).parts.map((p) => p.cents)).toEqual([3999]);
    expect(view.vendorRules).toHaveLength(2);

    // Correcting the entry that applies from the beginning rewrites it in place.
    const corrected = await saveVendorRule(db, freshCtx, {
      vendor: 'Netzwerk Nord',
      treatment: { allocations: [{ purpose: 'private', shareBp: 10000 }] },
    });
    expect(corrected.id).toBe(rule.id);
    view = await loadStatement(db, fresh.workspaceId, 2025);
    expect(item(view, a)).toMatchObject({ parts: [], privateCents: 3999 });

    // Deleting the rules puts the receipts back on their own columns.
    for (const r of view.vendorRules) await deleteVendorRule(db, freshCtx, r.id);
    view = await loadStatement(db, fresh.workspaceId, 2025);
    expect(item(view, a).allocationOrigin).toBe('legacy_columns');
    expect(item(view, b).allocationOrigin).toBe('legacy_columns');
  });
});

describe('resume and re-entry', () => {
  it('the statement is the same on every read, and a decided receipt can be decided again', async () => {
    const rowId = await ws.addReceipt(receipt({ Date: '2026-02-01' }));
    await saveItemDecision(db, ctx, rowId, HALF_AND_STUDY);
    const first = await loadStatement(db, ws.workspaceId, 2026);
    const second = await loadStatement(db, ws.workspaceId, 2026);
    expect(second.lines).toEqual(first.lines);
    // 2026: the form's line numbers are not verified, so none are shown.
    expect(first.formLinesVerified).toBe(false);
    expect(first.lines.every((l) => l.line === null)).toBe(true);

    await saveItemDecision(db, ctx, rowId, { allocations: [{ purpose: 'business', shareBp: 10000 }], formLineKey: 'euer.telecom' });
    expect(await db.taxItemDecision.count({ where: { rowId } })).toBe(1);
    expect(item(await loadStatement(db, ws.workspaceId, 2026), rowId).parts.map((p) => p.cents)).toEqual([3999]);
  });

  it('a stored decision the code no longer understands sends the receipt back to its defaults', async () => {
    const rowId = await ws.addReceipt(receipt({ Date: '2025-05-05' }));
    await db.taxItemDecision.create({
      data: { authWorkspaceId: ws.workspaceId, rowId, allocations: [{ purpose: 'retired_purpose', shareBp: 10000 }] },
    });
    const view = await loadStatement(db, ws.workspaceId, 2025);
    expect(item(view, rowId)).toMatchObject({ allocationOrigin: 'legacy_columns', hasDecision: false, counted: true });
  });

  it('deleting a receipt takes its decision with it', async () => {
    const rowId = await ws.addReceipt(receipt());
    await saveItemDecision(db, ctx, rowId, HALF_AND_STUDY);
    await ws.adapter.deleteRow(rowId);
    await deleteDecisionsForRows(db, [rowId]);
    expect(await db.taxItemDecision.count({ where: { rowId } })).toBe(0);
  });
});

describe('unhappy paths', () => {
  it('rejects invalid treatments and writes nothing', async () => {
    const rowId = await ws.addReceipt(receipt());
    expect(await code(saveItemDecision(db, ctx, rowId, { allocations: [{ purpose: 'business', shareBp: 12000 }] }))).toBe('invalid_allocation');
    expect(
      await code(
        saveItemDecision(db, ctx, rowId, {
          allocations: [{ purpose: 'business', shareBp: 7000 }, { purpose: 'study', shareBp: 4000 }],
          formLineKey: 'euer.telecom',
          employmentLineKey: 'employment.study_costs',
        }),
      ),
    ).toBe('allocation_exceeds_whole');
    expect(await code(saveItemDecision(db, ctx, rowId, { allocations: [{ purpose: 'business', shareBp: 5000 }] }))).toBe('form_line_required');
    expect(await db.taxItemDecision.count({ where: { rowId } })).toBe(0);
  });

  it('a business meal cannot be decided here; the register decides it', async () => {
    const rowId = await ws.addReceipt(plainMealReceipt());
    expect(await code(saveItemDecision(db, ctx, rowId, HALF_AND_STUDY))).toBe('meal_row');
    const view = await loadStatement(db, ws.workspaceId, 2025);
    expect(item(view, rowId)).toMatchObject({ isMeal: true, counted: false });
    expect(item(view, rowId).checks.map((c) => c.kind)).toEqual(['meal_incomplete']);
  });

  it('a vendor rule needs a vendor and a real date', async () => {
    expect(await code(saveVendorRule(db, ctx, { vendor: '  ', treatment: HALF_AND_STUDY }))).toBe('no_vendor');
    expect(await code(saveVendorRule(db, ctx, { vendor: 'Netzwerk Nord', effectiveFrom: '2025-02-30', treatment: HALF_AND_STUDY }))).toBe('invalid_date');
  });

  it('a foreign-currency receipt without a rate is open, with a rate it is counted as an estimate', async () => {
    const fresh = await createWorkspace();
    await saveTaxSettings(db, { workspaceId: fresh.workspaceId, tenantId: fresh.tenantId }, { smallBusiness: true });
    const noRate = await fresh.addReceipt(receipt({ Currency: 'USD', Gross: 100, 'FX Rate': 0 }));
    const withRate = await fresh.addReceipt(receipt({ Currency: 'USD', Gross: 100, 'FX Rate': 0.8437 }));
    const view = await loadStatement(db, fresh.workspaceId, 2025);
    expect(item(view, noRate).checks.map((c) => c.kind)).toEqual(['no_exchange_rate']);
    expect(item(view, withRate)).toMatchObject({ counted: true, amountCents: 8437 });
    expect(item(view, withRate).checks).toEqual([{ itemId: withRate, kind: 'amount_estimated', blocking: false }]);
    expect(view.businessExpenseCents).toBe(8437);
  });

  it('with the section 19 question unanswered nothing is computed', async () => {
    const fresh = await createWorkspace();
    const rowId = await fresh.addReceipt(receipt());
    const view = await loadStatement(db, fresh.workspaceId, 2025);
    expect(view.smallBusiness).toBeNull();
    expect(item(view, rowId).checks.map((c) => c.kind)).toEqual(['small_business_unanswered']);
    expect(view.businessExpenseCents).toBe(0);
  });

  it('a workspace without a Receipts table reads as empty, not as an error', async () => {
    const view = await loadStatement(db, 'test-ws-never-initialized', 2025);
    expect(view).toMatchObject({ initialized: false, items: [], lines: [], businessExpenseCents: 0 });
  });
});

describe('workspace isolation', () => {
  it('a row of another workspace does not exist here, for reads and for writes', async () => {
    const foreign = await other.addReceipt(receipt({ Vendor: 'Fremder Laden' }));
    const mine = await loadStatement(db, ws.workspaceId, 2025);
    expect(mine.items.some((i) => i.rowId === foreign)).toBe(false);
    expect(await code(saveItemDecision(db, ctx, foreign, HALF_AND_STUDY))).toBe('row_not_found');
    expect(await db.taxItemDecision.count({ where: { rowId: foreign } })).toBe(0);

    // The owner's decision is not removable from the other workspace either.
    await saveItemDecision(db, otherCtx, foreign, HALF_AND_STUDY);
    expect(await clearItemDecision(db, ctx, foreign)).toEqual({ changed: false });
    expect(await db.taxItemDecision.count({ where: { rowId: foreign } })).toBe(1);
  });

  it('vendor rules stay in their workspace', async () => {
    const rule = await saveVendorRule(db, otherCtx, { vendor: 'Fremder Laden', treatment: HALF_AND_STUDY });
    expect((await loadStatement(db, ws.workspaceId, 2025)).vendorRules.some((r) => r.id === rule.id)).toBe(false);
    expect(await code(deleteVendorRule(db, ctx, rule.id))).toBe('rule_not_found');
    expect(await db.taxVendorRule.count({ where: { id: rule.id } })).toBe(1);
  });
});
