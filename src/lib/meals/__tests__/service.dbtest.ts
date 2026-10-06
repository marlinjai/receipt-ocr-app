import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ContactError } from '@/lib/contacts/store';
import { MealInputError, type MealDetailsInput } from '../input';
import { mealStatus } from '../rules';
import {
  MealServiceError,
  contactStore,
  deleteGuestsForRows,
  getTaxSettings,
  loadMealRecord,
  loadMealRecords,
  saveMealDetails,
  loadLastUsedHost,
  saveTaxSettings,
  type MealContext,
} from '../service';
import { createWorkspace, db, plainMealReceipt, type TestWorkspace } from '../../../../test/db-helpers';

/**
 * The meal service against a real database: the real Prisma queries, the real
 * data-table adapter, the real migration 0008. Run with `pnpm test:db`.
 */

let ws: TestWorkspace;
let other: TestWorkspace;
let ctx: MealContext;
let otherCtx: MealContext;

beforeAll(async () => {
  ws = await createWorkspace();
  other = await createWorkspace();
  ctx = { workspaceId: ws.workspaceId, tenantId: ws.tenantId };
  otherCtx = { workspaceId: other.workspaceId, tenantId: other.tenantId };
});

afterAll(async () => {
  await db.$disconnect();
});

function details(overrides: Partial<MealDetailsInput> = {}): MealDetailsInput {
  return {
    mealType: 'business_meal_external',
    occasion: 'Abstimmung Relaunch Webshop',
    place: 'Testlokal, Musterstraße 1, 12345 Musterstadt',
    host: 'Inhaber Beispiel',
    tip: 11,
    consumption: 'dine_in',
    taxLines: null,
    guestContactIds: [],
    date: null,
    gross: null,
    ...overrides,
  };
}

describe('forward path', () => {
  it('a plain Bewirtung receipt is incomplete, and becomes complete once the details are saved', async () => {
    const rowId = await ws.addReceipt(plainMealReceipt());
    const before = await loadMealRecord(db, ws.workspaceId, rowId);
    expect(mealStatus(before!)).toEqual({
      kind: 'incomplete',
      missing: ['mealType', 'place', 'occasion', 'host', 'guests'],
    });

    const guest = await contactStore(db, ctx).create({ name: 'Erika Beispiel', companyOrRole: 'Beispiel GmbH' });
    const fixedNow = new Date('2025-03-15T09:00:00.000Z');
    const { record, changed } = await saveMealDetails(
      db, ctx, rowId, details({ guestContactIds: [guest.id] }), () => fixedNow,
    );
    expect(changed).toBe(true);
    expect(mealStatus(record)).toEqual({ kind: 'complete' });
    expect(record).toMatchObject({
      mealType: 'business_meal_external',
      occasion: 'Abstimmung Relaunch Webshop',
      tip: 11,
      consumption: 'dine_in',
      detailsAt: fixedNow.toISOString(),
      guests: [{ contactId: guest.id, name: 'Erika Beispiel', company: 'Beispiel GmbH' }],
    });

    // And it is among the workspace's meal records.
    const all = await loadMealRecords(db, ws.workspaceId);
    expect(all.find((r) => r.rowId === rowId)?.guests).toHaveLength(1);
  });

  it('writes no guest name into any cell of the row', async () => {
    const rowId = await ws.addReceipt(plainMealReceipt());
    const guest = await contactStore(db, ctx).create({ name: 'Zeno Unverwechselbar', companyOrRole: 'Zettel KG' });
    await saveMealDetails(db, ctx, rowId, details({ guestContactIds: [guest.id] }));
    const row = await ws.adapter.getRow(rowId);
    const everything = JSON.stringify(row!.cells);
    expect(everything).not.toContain('Zeno');
    expect(everything).not.toContain('Zettel KG');
  });
});

describe('backtrack and revise', () => {
  it('saving the same input again writes nothing, not even the timestamp', async () => {
    const rowId = await ws.addReceipt(plainMealReceipt());
    const guest = await contactStore(db, ctx).create({ name: 'Max Muster', companyOrRole: 'Muster AG' });
    const first = await saveMealDetails(
      db, ctx, rowId, details({ guestContactIds: [guest.id] }), () => new Date('2025-03-15T09:00:00.000Z'),
    );
    const again = await saveMealDetails(
      db, ctx, rowId, details({ guestContactIds: [guest.id] }), () => new Date('2026-01-01T00:00:00.000Z'),
    );
    expect(again.changed).toBe(false);
    expect(again.record.detailsAt).toBe(first.record.detailsAt);
  });

  it('changing an input changes the stored facts and the timestamp', async () => {
    const rowId = await ws.addReceipt(plainMealReceipt());
    const guest = await contactStore(db, ctx).create({ name: 'Paula Probe', companyOrRole: '' });
    await saveMealDetails(db, ctx, rowId, details({ guestContactIds: [guest.id] }), () => new Date('2025-03-15T09:00:00.000Z'));
    const revised = await saveMealDetails(
      db, ctx, rowId, details({ guestContactIds: [guest.id], tip: 5 }), () => new Date('2025-03-16T09:00:00.000Z'),
    );
    expect(revised.changed).toBe(true);
    expect(revised.record.tip).toBe(5);
    expect(revised.record.detailsAt).toBe('2025-03-16T09:00:00.000Z');
  });

  it('removing all guests makes the meal incomplete again; adding them back completes it', async () => {
    const rowId = await ws.addReceipt(plainMealReceipt());
    const guest = await contactStore(db, ctx).create({ name: 'Greta Gast', companyOrRole: 'Gast und Söhne' });
    await saveMealDetails(db, ctx, rowId, details({ guestContactIds: [guest.id] }));
    const cleared = await saveMealDetails(db, ctx, rowId, details({ guestContactIds: [] }));
    expect(mealStatus(cleared.record)).toEqual({ kind: 'incomplete', missing: ['guests'] });
    const restored = await saveMealDetails(db, ctx, rowId, details({ guestContactIds: [guest.id] }));
    expect(mealStatus(restored.record)).toEqual({ kind: 'complete' });
  });

  it('reclassifying the row away from Bewirtung keeps the details; switching back restores the entry', async () => {
    const rowId = await ws.addReceipt(plainMealReceipt());
    const guest = await contactStore(db, ctx).create({ name: 'Rita Rückweg', companyOrRole: '' });
    await saveMealDetails(db, ctx, rowId, details({ guestContactIds: [guest.id] }));

    const columns = await ws.adapter.getColumns(ws.tableId);
    const categoryCol = columns.find((c) => c.name === 'Category')!;
    const options = await ws.adapter.getSelectOptions(categoryCol.id);
    const optionId = (name: string) => options.find((o) => o.name === name)!.id;

    await ws.adapter.updateRow(rowId, { [categoryCol.id]: optionId('Reisekosten') });
    const away = await loadMealRecord(db, ws.workspaceId, rowId);
    expect(mealStatus(away!)).toEqual({ kind: 'not_a_meal' });
    expect(away!.occasion).toBe('Abstimmung Relaunch Webshop');
    expect(away!.guests).toHaveLength(1);
    expect((await loadMealRecords(db, ws.workspaceId)).some((r) => r.rowId === rowId)).toBe(false);

    await ws.adapter.updateRow(rowId, { [categoryCol.id]: optionId('Bewirtung') });
    const back = await loadMealRecord(db, ws.workspaceId, rowId);
    expect(mealStatus(back!)).toEqual({ kind: 'complete' });
  });

  it('the guest order is kept as entered and can be changed', async () => {
    const rowId = await ws.addReceipt(plainMealReceipt());
    const store = contactStore(db, ctx);
    const a = await store.create({ name: 'Anton Erster', companyOrRole: '' });
    const b = await store.create({ name: 'Berta Zweite', companyOrRole: '' });
    const first = await saveMealDetails(db, ctx, rowId, details({ guestContactIds: [b.id, a.id] }));
    expect(first.record.guests.map((g) => g.name)).toEqual(['Berta Zweite', 'Anton Erster']);
    const swapped = await saveMealDetails(db, ctx, rowId, details({ guestContactIds: [a.id, b.id] }));
    expect(swapped.changed).toBe(true);
    expect(swapped.record.guests.map((g) => g.name)).toEqual(['Anton Erster', 'Berta Zweite']);
  });
});

describe('resume', () => {
  it('a partial save persists and reads back as incomplete with exactly the missing facts', async () => {
    const rowId = await ws.addReceipt(plainMealReceipt());
    await saveMealDetails(db, ctx, rowId, details({ occasion: '', host: '', guestContactIds: [] }));
    const resumed = await loadMealRecord(db, ws.workspaceId, rowId);
    expect(resumed).toMatchObject({ mealType: 'business_meal_external', place: 'Testlokal, Musterstraße 1, 12345 Musterstadt', tip: 11 });
    expect(mealStatus(resumed!)).toEqual({ kind: 'incomplete', missing: ['occasion', 'host', 'guests'] });
  });

  it('a receipt whose date and amount were not read can have them entered in the form', async () => {
    const rowId = await ws.addReceipt(plainMealReceipt({ Gross: null, Date: null }));
    const guest = await contactStore(db, ctx).create({ name: 'Dora Datum', companyOrRole: '' });
    const saved = await saveMealDetails(
      db, ctx, rowId, details({ guestContactIds: [guest.id], date: '2025-06-01', gross: 48.5 }),
    );
    expect(saved.record).toMatchObject({ date: '2025-06-01', gross: 48.5 });
    expect(mealStatus(saved.record)).toEqual({ kind: 'complete' });
  });
});

describe('re-entry', () => {
  it('editing a completed entry updates it in place: still one row, one guest list', async () => {
    const rowId = await ws.addReceipt(plainMealReceipt());
    const store = contactStore(db, ctx);
    const a = await store.create({ name: 'Emil Einmal', companyOrRole: '' });
    const b = await store.create({ name: 'Nora Nochmal', companyOrRole: '' });
    await saveMealDetails(db, ctx, rowId, details({ guestContactIds: [a.id] }));
    await saveMealDetails(db, ctx, rowId, details({ guestContactIds: [a.id, b.id], occasion: 'Abnahme Fotoproduktion' }));
    const guests = await db.mealGuest.findMany({ where: { rowId } });
    expect(guests).toHaveLength(2);
    const record = await loadMealRecord(db, ws.workspaceId, rowId);
    expect(record!.occasion).toBe('Abnahme Fotoproduktion');
  });

  it('deleting a receipt row removes its guests', async () => {
    const rowId = await ws.addReceipt(plainMealReceipt());
    const guest = await contactStore(db, ctx).create({ name: 'Lea Löschung', companyOrRole: '' });
    await saveMealDetails(db, ctx, rowId, details({ guestContactIds: [guest.id] }));
    await ws.adapter.deleteRow(rowId);
    await deleteGuestsForRows(db, [rowId]);
    expect(await db.mealGuest.count({ where: { rowId } })).toBe(0);
  });
});

describe('receipt files', () => {
  it('a file attached to the row arrives on the meal record, single and listed (the export depends on it)', async () => {
    const rowId = await ws.addReceipt(plainMealReceipt());
    const columns = await ws.adapter.getColumns(ws.tableId);
    const imageCol = columns.find((c) => c.name === 'Receipt Image')!;
    await ws.adapter.addFileReference({
      rowId,
      columnId: imageCol.id,
      fileId: '11111111-2222-4333-8444-555555555555',
      fileUrl: '/api/files/11111111-2222-4333-8444-555555555555',
      originalName: 'beleg.jpg',
      mimeType: 'image/jpeg',
      metadata: { source: 'test' },
    });
    const expected = [
      {
        fileId: '11111111-2222-4333-8444-555555555555',
        fileUrl: '/api/files/11111111-2222-4333-8444-555555555555',
        mimeType: 'image/jpeg',
        originalName: 'beleg.jpg',
      },
    ];
    expect((await loadMealRecord(db, ws.workspaceId, rowId))!.files).toEqual(expected);
    const listed = (await loadMealRecords(db, ws.workspaceId)).find((r) => r.rowId === rowId);
    expect(listed!.files).toEqual(expected);
  });
});

describe('contacts', () => {
  it('refuses a duplicate name plus company, case-insensitively, and hands back the existing contact', async () => {
    const store = contactStore(db, ctx);
    const first = await store.create({ name: 'Doppel Gänger', companyOrRole: 'Zwilling GmbH' });
    await expect(store.create({ name: '  doppel   gänger ', companyOrRole: 'ZWILLING GMBH' })).rejects.toMatchObject({
      code: 'duplicate',
      existing: { id: first.id },
    });
    // Same name at another company is a different person.
    await expect(store.create({ name: 'Doppel Gänger', companyOrRole: 'Andere AG' })).resolves.toMatchObject({
      name: 'Doppel Gänger',
    });
  });

  it('two contacts without a company cannot share a name (empty string, not NULL)', async () => {
    const store = contactStore(db, ctx);
    await store.create({ name: 'Ohne Firma' });
    await expect(store.create({ name: 'Ohne Firma' })).rejects.toBeInstanceOf(ContactError);
  });

  it('rejects an empty name', async () => {
    await expect(contactStore(db, ctx).create({ name: '   ' })).rejects.toMatchObject({ code: 'invalid_name' });
  });

  it('correcting a contact updates the printed copy on existing meals', async () => {
    const rowId = await ws.addReceipt(plainMealReceipt());
    const store = contactStore(db, ctx);
    const guest = await store.create({ name: 'Tipfehler Meier', companyOrRole: 'Alt GmbH' });
    await saveMealDetails(db, ctx, rowId, details({ guestContactIds: [guest.id] }));
    await store.update(guest.id, { name: 'Tippfehler Meier', companyOrRole: 'Neu GmbH' });
    const record = await loadMealRecord(db, ws.workspaceId, rowId);
    expect(record!.guests).toEqual([{ contactId: guest.id, name: 'Tippfehler Meier', company: 'Neu GmbH' }]);
  });

  it('archiving hides a contact from the picker but keeps it on old meals; it cannot be newly added', async () => {
    const oldRow = await ws.addReceipt(plainMealReceipt());
    const newRow = await ws.addReceipt(plainMealReceipt());
    const store = contactStore(db, ctx);
    const guest = await store.create({ name: 'Alma Archiv', companyOrRole: '' });
    await saveMealDetails(db, ctx, oldRow, details({ guestContactIds: [guest.id] }));
    await store.archive(guest.id);

    expect((await store.list()).some((c) => c.id === guest.id)).toBe(false);
    expect((await store.list({ includeArchived: true })).find((c) => c.id === guest.id)?.archived).toBe(true);

    const old = await loadMealRecord(db, ws.workspaceId, oldRow);
    expect(mealStatus(old!)).toEqual({ kind: 'complete' });
    // Editing the old meal with the archived guest still on it works.
    await expect(
      saveMealDetails(db, ctx, oldRow, details({ guestContactIds: [guest.id], tip: 3 })),
    ).resolves.toMatchObject({ changed: true });
    // Adding the archived contact to another meal does not.
    await expect(saveMealDetails(db, ctx, newRow, details({ guestContactIds: [guest.id] }))).rejects.toMatchObject({
      code: 'archived_contact',
    });

    await store.restore(guest.id);
    await expect(saveMealDetails(db, ctx, newRow, details({ guestContactIds: [guest.id] }))).resolves.toMatchObject({
      changed: true,
    });
  });
});

describe('workspace isolation', () => {
  it('a row of another workspace does not exist for this one, for reads and writes', async () => {
    const foreignRow = await other.addReceipt(plainMealReceipt());
    expect(await loadMealRecord(db, ws.workspaceId, foreignRow)).toBeNull();
    await expect(saveMealDetails(db, ctx, foreignRow, details())).rejects.toMatchObject({ code: 'row_not_found' });
    // Untouched in its own workspace.
    const own = await loadMealRecord(db, other.workspaceId, foreignRow);
    expect(own!.occasion).toBe('');
  });

  it('meal records never include another workspace', async () => {
    const mine = await ws.addReceipt(plainMealReceipt());
    const theirs = await other.addReceipt(plainMealReceipt());
    const ids = (await loadMealRecords(db, ws.workspaceId)).map((r) => r.rowId);
    expect(ids).toContain(mine);
    expect(ids).not.toContain(theirs);
  });

  it('a contact of another workspace cannot be read, changed, archived or put on a meal', async () => {
    const foreign = await contactStore(db, otherCtx).create({ name: 'Fremde Firma Kontakt', companyOrRole: 'Fremd AG' });
    const store = contactStore(db, ctx);
    expect(await store.getMany([foreign.id])).toEqual([]);
    expect((await store.list({ includeArchived: true })).some((c) => c.id === foreign.id)).toBe(false);
    await expect(store.update(foreign.id, { name: 'Gekapert' })).rejects.toMatchObject({ code: 'not_found' });
    await expect(store.archive(foreign.id)).rejects.toMatchObject({ code: 'not_found' });

    const rowId = await ws.addReceipt(plainMealReceipt());
    await expect(saveMealDetails(db, ctx, rowId, details({ guestContactIds: [foreign.id] }))).rejects.toMatchObject({
      code: 'unknown_contact',
    });
    // And the same name can exist in both workspaces independently.
    await expect(store.create({ name: 'Fremde Firma Kontakt', companyOrRole: 'Fremd AG' })).resolves.toBeTruthy();
  });

  it('the section 19 answer is per workspace and starts unanswered', async () => {
    expect(await getTaxSettings(db, ws.workspaceId)).toEqual({ smallBusiness: null, hostAddressThresholdEur: 250 });
    await saveTaxSettings(db, ctx, { smallBusiness: true });
    expect((await getTaxSettings(db, ws.workspaceId)).smallBusiness).toBe(true);
    expect((await getTaxSettings(db, other.workspaceId)).smallBusiness).toBeNull();
    await saveTaxSettings(db, ctx, { smallBusiness: false });
    expect((await getTaxSettings(db, ws.workspaceId)).smallBusiness).toBe(false);
  });

  it('the host-name threshold can be changed and survives a later answer without it', async () => {
    const fresh = await createWorkspace();
    const freshCtx = { workspaceId: fresh.workspaceId, tenantId: fresh.tenantId };
    await saveTaxSettings(db, freshCtx, { smallBusiness: true, hostAddressThresholdEur: 300 });
    await saveTaxSettings(db, freshCtx, { smallBusiness: false });
    expect(await getTaxSettings(db, fresh.workspaceId)).toEqual({ smallBusiness: false, hostAddressThresholdEur: 300 });
    await expect(
      saveTaxSettings(db, freshCtx, { smallBusiness: true, hostAddressThresholdEur: -5 }),
    ).rejects.toThrow('invalid_threshold');
  });

  it('the last used host is found per workspace, newest first', async () => {
    const fresh = await createWorkspace();
    const freshCtx = { workspaceId: fresh.workspaceId, tenantId: fresh.tenantId };
    expect(await loadLastUsedHost(db, fresh.workspaceId)).toBe('');
    const first = await fresh.addReceipt(plainMealReceipt());
    const second = await fresh.addReceipt(plainMealReceipt());
    await fresh.addReceipt(plainMealReceipt()); // never annotated
    await saveMealDetails(db, freshCtx, first, details({ host: 'Erste Gastgeberin' }), () => new Date('2025-01-01T10:00:00Z'));
    await saveMealDetails(db, freshCtx, second, details({ host: 'Zweiter Gastgeber' }), () => new Date('2025-02-01T10:00:00Z'));
    expect(await loadLastUsedHost(db, fresh.workspaceId)).toBe('Zweiter Gastgeber');
    expect(await loadLastUsedHost(db, other.workspaceId)).not.toBe('Zweiter Gastgeber');
  });
});

describe('input validation', () => {
  it('rejects a negative tip, an impossible date and an unknown meal type', async () => {
    const rowId = await ws.addReceipt(plainMealReceipt());
    await expect(saveMealDetails(db, ctx, rowId, details({ tip: -1 }))).rejects.toBeInstanceOf(MealInputError);
    await expect(saveMealDetails(db, ctx, rowId, details({ date: '2025-02-30' }))).rejects.toMatchObject({ code: 'invalid_date' });
    await expect(
      saveMealDetails(db, ctx, rowId, details({ mealType: 'banquet' as never })),
    ).rejects.toMatchObject({ code: 'invalid_meal_type' });
    await expect(saveMealDetails(db, ctx, 'no-such-row', details())).rejects.toBeInstanceOf(MealServiceError);
  });
});
