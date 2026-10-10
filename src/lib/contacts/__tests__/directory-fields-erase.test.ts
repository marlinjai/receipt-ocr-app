import { describe, it, expect, vi } from 'vitest';
import {
  ContactError as SharedError,
  applyCustomFieldPatch,
  normalizeFieldDefinition,
  type Contact as SharedContact,
  type Contacts,
  type FieldDefinition,
} from '@marlinjai/contacts-core';
import type { PrismaClient } from '@prisma/client';

vi.mock('../db', () => ({ companyContacts: vi.fn(), contactsDb: vi.fn() }));

import {
  archiveDirectoryField,
  countDirectoryOrganizations,
  createDirectoryContact,
  createDirectoryField,
  eraseDirectoryContact,
  listDirectory,
  listDirectoryFields,
  previewEraseContact,
  updateDirectoryContact,
} from '../directory';
import { eraseConfirmation } from '../directory-messages';
import { contactsTabCount } from '../field-form';
import { SharedContactStore } from '../shared-store';
import { RETENTION_YEARS, type RegisterHasher } from '../../erasure';

const TENANT = 'tnt_a';

function row(over: Partial<SharedContact> & { id: string; kind: 'person' | 'organization'; name: string }): SharedContact {
  return {
    companyOrRole: '',
    organizationId: null,
    email: null,
    phone: null,
    note: null,
    legalForm: null,
    addressLine1: null,
    addressLine2: null,
    postalCode: null,
    city: null,
    country: null,
    vatId: null,
    preferredContact: null,
    customFields: {},
    customerNumber: null,
    version: 1,
    archived: false,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...over,
  };
}

/**
 * An in-memory stand-in for the package's per-company contacts. It uses the
 * package's own field rules, writes every field of the full record on update
 * (so a field that is not carried is wiped) and treats custom fields as a patch.
 */
function fakeContacts(initial: SharedContact[], tenantId = TENANT) {
  const rows = new Map(initial.map((c) => [c.id, { ...c }]));
  const defs: FieldDefinition[] = [];
  let nextId = 0;
  const api = {
    tenantId,
    rows,
    defs,
    list: vi.fn(async (opts: { kind?: string; includeArchived?: boolean } = {}) =>
      [...rows.values()].filter((c) => (!opts.kind || c.kind === opts.kind) && (opts.includeArchived || !c.archived)).map((c) => ({ ...c })),
    ),
    get: vi.fn(async (id: string) => (rows.get(id) ? { ...rows.get(id)! } : null)),
    getMany: vi.fn(async (ids: readonly string[]) => ids.map((id) => rows.get(id)).filter(Boolean).map((c) => ({ ...c! }))),
    create: vi.fn(async (input: Partial<SharedContact> & { kind: 'person' | 'organization'; name: string; customFields?: Record<string, unknown> }) => {
      const customFields = input.customFields ? applyCustomFieldPatch({}, input.customFields, defs) : {};
      const created = row({ ...(input as SharedContact), id: `new-${++nextId}`, customFields });
      rows.set(created.id, created);
      return { ...created };
    }),
    update: vi.fn(async (id: string, input: Partial<SharedContact> & { name: string; customFields?: Record<string, unknown> }, options: { expectedVersion?: number } = {}) => {
      const current = rows.get(id)!;
      if (options.expectedVersion !== undefined && options.expectedVersion !== current.version) {
        throw new SharedError('stale', { existing: { ...current } });
      }
      const customFields = input.customFields ? applyCustomFieldPatch(current.customFields, input.customFields, defs) : current.customFields;
      const written: SharedContact = {
        ...current,
        name: input.name,
        companyOrRole: input.companyOrRole ?? '',
        organizationId: input.organizationId ?? null,
        email: input.email ?? null,
        phone: input.phone ?? null,
        note: input.note ?? null,
        legalForm: input.legalForm ?? null,
        addressLine1: input.addressLine1 ?? null,
        addressLine2: input.addressLine2 ?? null,
        postalCode: input.postalCode ?? null,
        city: input.city ?? null,
        country: input.country ?? null,
        vatId: input.vatId ?? null,
        preferredContact: (input.preferredContact ?? null) as SharedContact['preferredContact'],
        customFields,
        version: current.version + 1,
      };
      rows.set(id, written);
      return { ...written };
    }),
    erase: vi.fn(async (id: string) => {
      const had = rows.delete(id);
      // As the package does: persons linked to an erased organization stay, unlinked.
      for (const c of rows.values()) if (c.organizationId === id) c.organizationId = null;
      return had;
    }),
    exportContact: vi.fn(async (id: string) => {
      const c = rows.get(id);
      if (!c) return null;
      return { contact: { ...c }, organization: null, members: [...rows.values()].filter((m) => m.organizationId === id).map((m) => ({ ...m })) };
    }),
    listFields: vi.fn(async (opts: { includeArchived?: boolean } = {}) => defs.filter((d) => opts.includeArchived || !d.archived).map((d) => ({ ...d }))),
    createField: vi.fn(async (input: { key: string; label: string; type: string; options?: readonly string[] | null }) => {
      const data = normalizeFieldDefinition(input);
      if (defs.some((d) => d.key === data.key)) throw new SharedError('duplicate_field', { field: data.key });
      const def: FieldDefinition = { ...data, archived: false, createdAt: new Date(0) };
      defs.push(def);
      return { ...def };
    }),
    archiveField: vi.fn(async (key: string) => {
      const def = defs.find((d) => d.key === key);
      if (!def) throw new SharedError('field_not_found', { field: key });
      def.archived = true;
      return { ...def };
    }),
  };
  return api;
}

type Guest = { id: string; rowId: string; contactId: string | null; displayName: string; displayCompany: string; retainUntil: Date | null; authTenantId: string | null };

/**
 * An in-memory stand-in for the receipts tables the erase touches.
 * `exportHash`: undefined = no export on record, null = an export from before the
 * register hash existed, a string = the register hash stored with the newest export.
 * `state.register` is the hash of the register as it is "now".
 */
function fakeDb(guests: Guest[], exportHash?: string | null) {
  const rows = guests.map((g) => ({ ...g }));
  const matches = (r: Guest, where: { OR?: Array<Record<string, unknown>>; contactId?: unknown }) => {
    const scope = where.OR ?? [];
    const inScope = scope.some((s) => {
      if ('contactId' in s) return typeof s.contactId === 'string' ? r.contactId === s.contactId : (s.contactId as { in: string[] }).in.includes(r.contactId ?? '');
      if ('authTenantId' in s) return r.authTenantId === s.authTenantId;
      return false;
    });
    const linkedOnly = where.contactId && typeof where.contactId === 'object' && 'not' in (where.contactId as object);
    return inScope && (!linkedOnly || r.contactId !== null);
  };
  const state: { exportHash: string | null | undefined; register: string; recomputeFails: boolean } = { exportHash, register: 'reg-1', recomputeFails: false };
  const hasher: RegisterHasher = async () => {
    if (state.recomputeFails) throw new Error('data layer unreachable');
    return state.register;
  };
  const db = {
    companyExport: { findFirst: vi.fn(async () => (state.exportHash === undefined ? null : { registerSha256: state.exportHash })) },
    contact: { deleteMany: vi.fn(async () => ({ count: 0 })) },
    mealGuest: {
      findMany: vi.fn(async ({ where }: { where: { contactId: string | { in: string[] } } }) =>
        rows.filter((r) => (typeof where.contactId === 'string' ? r.contactId === where.contactId : where.contactId.in.includes(r.contactId ?? ''))).map((r) => ({ ...r })),
      ),
      updateMany: vi.fn(async ({ where, data }: { where: { OR?: Array<Record<string, unknown>>; contactId?: unknown }; data: Partial<Guest> }) => {
        const hit = rows.filter((r) => (where.OR ? matches(r, where) : r.contactId === where.contactId));
        for (const r of hit) Object.assign(r, data);
        return { count: hit.length };
      }),
      deleteMany: vi.fn(async ({ where }: { where: { OR: Array<Record<string, unknown>> } }) => {
        const keep = rows.filter((r) => !matches(r, where));
        const count = rows.length - keep.length;
        rows.splice(0, rows.length, ...keep);
        return { count };
      }),
    },
  };
  return { db: db as unknown as PrismaClient, rows, state, raw: db, hasher };
}

const guest = (over: Partial<Guest> & { id: string; rowId: string; contactId: string | null }): Guest => ({
  displayName: 'Printed Name',
  displayCompany: 'Printed Co',
  retainUntil: null,
  authTenantId: TENANT,
  ...over,
});

const C = (c: ReturnType<typeof fakeContacts>) => c as unknown as Contacts;

describe('define field: custom fields per company', () => {
  it('forward: a defined field can be listed and filled on a contact', async () => {
    const c = fakeContacts([row({ id: 'p1', kind: 'person', name: 'Ada' })]);
    await createDirectoryField(C(c), { key: 'diet', label: 'Ernährung', type: 'select', options: ['vegan', 'alles'] });
    expect(await listDirectoryFields(C(c))).toEqual([{ key: 'diet', label: 'Ernährung', type: 'select', options: ['vegan', 'alles'], archived: false }]);
    const saved = await updateDirectoryContact(C(c), 'p1', { customFields: { diet: 'vegan' } });
    expect(saved.customFields).toEqual({ diet: 'vegan' });
  });

  it('change an earlier input: archiving a field keeps stored values and refuses new ones, naming the field', async () => {
    const c = fakeContacts([row({ id: 'p1', kind: 'person', name: 'Ada' })]);
    await createDirectoryField(C(c), { key: 'diet', label: 'Ernährung', type: 'text' });
    await updateDirectoryContact(C(c), 'p1', { customFields: { diet: 'vegan' } });
    await archiveDirectoryField(C(c), 'diet');
    expect((await listDirectory(C(c)))[0].customFields).toEqual({ diet: 'vegan' });
    await expect(updateDirectoryContact(C(c), 'p1', { customFields: { diet: 'alles' } })).rejects.toMatchObject({ code: 'field_archived', field: 'diet' });
    expect(await listDirectoryFields(C(c))).toEqual([]);
    expect((await listDirectoryFields(C(c), { includeArchived: true }))[0]).toMatchObject({ key: 'diet', archived: true });
  });

  it('resume: a refused value names its field and writes nothing; the corrected save goes through', async () => {
    const c = fakeContacts([row({ id: 'p1', kind: 'person', name: 'Ada' })]);
    await createDirectoryField(C(c), { key: 'seats', label: 'Plätze', type: 'number' });
    await expect(updateDirectoryContact(C(c), 'p1', { customFields: { seats: 'vier' } })).rejects.toMatchObject({ code: 'invalid_value', field: 'seats' });
    expect(c.rows.get('p1')).toMatchObject({ customFields: {}, version: 1 });
    await expect(updateDirectoryContact(C(c), 'p1', { customFields: { nope: 1 } })).rejects.toMatchObject({ code: 'unknown_field', field: 'nope' });
    const saved = await updateDirectoryContact(C(c), 'p1', { customFields: { seats: 4 } });
    expect(saved.customFields).toEqual({ seats: 4 });
  });

  it('re-entry: the same key again is refused (also after archiving), and archiving twice changes nothing', async () => {
    const c = fakeContacts([]);
    await createDirectoryField(C(c), { key: 'diet', label: 'Ernährung', type: 'text' });
    await expect(createDirectoryField(C(c), { key: 'diet', label: 'Anders', type: 'text' })).rejects.toMatchObject({ code: 'duplicate_field', field: 'diet' });
    await archiveDirectoryField(C(c), 'diet');
    await expect(archiveDirectoryField(C(c), 'diet')).resolves.toMatchObject({ archived: true });
    await expect(createDirectoryField(C(c), { key: 'diet', label: 'Neu', type: 'text' })).rejects.toMatchObject({ code: 'duplicate_field' });
    await expect(archiveDirectoryField(C(c), 'missing')).rejects.toMatchObject({ code: 'field_not_found' });
  });

  it('refuses a select field without options and an unknown type', async () => {
    const c = fakeContacts([]);
    await expect(createDirectoryField(C(c), { key: 'tier', label: 'Stufe', type: 'select', options: [] })).rejects.toMatchObject({ code: 'invalid', field: 'options' });
    await expect(createDirectoryField(C(c), { key: 'x1', label: 'X', type: 'formula' })).rejects.toMatchObject({ code: 'invalid', field: 'type' });
  });
});

describe('edit with fields: nothing is wiped by an edit of something else', () => {
  const seeded = async () => {
    const c = fakeContacts([
      row({ id: 'p1', kind: 'person', name: 'Ada', companyOrRole: 'Engines', email: 'ada@example.test', preferredContact: 'phone' }),
      row({ id: 'o1', kind: 'organization', name: 'Acme GmbH', preferredContact: 'post' }),
    ]);
    await createDirectoryField(C(c), { key: 'diet', label: 'Ernährung', type: 'text' });
    await updateDirectoryContact(C(c), 'p1', { customFields: { diet: 'vegan' } });
    await updateDirectoryContact(C(c), 'o1', { customFields: { diet: 'alles' } });
    return c;
  };

  it('forward: an edit of the name keeps custom field values and the preferred contact method (directory)', async () => {
    const c = await seeded();
    const saved = await updateDirectoryContact(C(c), 'o1', { name: 'Acme Holding GmbH' });
    expect(saved).toMatchObject({ name: 'Acme Holding GmbH', preferredContact: 'post', customFields: { diet: 'alles' } });
  });

  it('forward: a guest correction keeps custom field values and the preferred contact method (guest list store)', async () => {
    const c = await seeded();
    const { db } = fakeDb([guest({ id: 'g1', rowId: 'r1', contactId: 'p1' })]);
    const store = new SharedContactStore(C(c), db);
    await store.update('p1', { name: 'Ada King', companyOrRole: 'Engines' });
    expect(c.rows.get('p1')).toMatchObject({ name: 'Ada King', preferredContact: 'phone', customFields: { diet: 'vegan' }, email: 'ada@example.test' });
  });

  it('change an earlier input: changing one custom field leaves the others and the contact method alone', async () => {
    const c = await seeded();
    await createDirectoryField(C(c), { key: 'seats', label: 'Plätze', type: 'number' });
    await updateDirectoryContact(C(c), 'p1', { customFields: { seats: 2 } });
    const saved = await updateDirectoryContact(C(c), 'p1', { preferredContact: 'email' });
    expect(saved).toMatchObject({ preferredContact: 'email', customFields: { diet: 'vegan', seats: 2 } });
    const cleared = await updateDirectoryContact(C(c), 'p1', { customFields: { diet: null } });
    expect(cleared.customFields).toEqual({ seats: 2 });
  });

  it('resume: a stale save is refused and writes nothing; saving on the fresh version works', async () => {
    const c = await seeded();
    const before = { ...c.rows.get('p1')! };
    await expect(updateDirectoryContact(C(c), 'p1', { preferredContact: 'none' }, 1)).rejects.toMatchObject({ code: 'stale' });
    expect(c.rows.get('p1')).toEqual(before);
    await expect(updateDirectoryContact(C(c), 'p1', { preferredContact: 'none' }, before.version)).resolves.toMatchObject({ preferredContact: 'none' });
  });

  it('re-entry: saving the same values again leaves the same state', async () => {
    const c = await seeded();
    const first = await updateDirectoryContact(C(c), 'p1', { preferredContact: 'email', customFields: { diet: 'vegan' } });
    const second = await updateDirectoryContact(C(c), 'p1', { preferredContact: 'email', customFields: { diet: 'vegan' } });
    expect(second).toMatchObject({ preferredContact: first.preferredContact, customFields: first.customFields });
  });

  it('creates an organization with custom fields and a preferred contact method', async () => {
    const c = fakeContacts([]);
    await createDirectoryField(C(c), { key: 'tier', label: 'Stufe', type: 'select', options: ['A', 'B'] });
    const created = await createDirectoryContact(C(c), { kind: 'organization', name: 'Acme', preferredContact: 'email', customFields: { tier: 'B' } });
    expect(created).toMatchObject({ preferredContact: 'email', customFields: { tier: 'B' } });
  });
});

describe('erase one contact: the same rule as the company erasure', () => {
  const NOW = new Date('2026-10-10T00:00:00Z');
  const WS = ['ws_1'];
  type Fake = ReturnType<typeof fakeDb>;
  const erase = (c: ReturnType<typeof fakeContacts>, f: Fake, id: string, now = NOW, workspaces: string[] = WS) =>
    eraseDirectoryContact(C(c), f.db, id, workspaces, now, f.hasher);
  const preview = (c: ReturnType<typeof fakeContacts>, f: Fake, id: string) => previewEraseContact(C(c), f.db, id, WS, f.hasher);
  const two = () => fakeContacts([row({ id: 'p1', kind: 'person', name: 'Ada' }), row({ id: 'p2', kind: 'person', name: 'Grace' })]);

  it('forward, no export: the contact goes, printed names are held with the link cleared', async () => {
    const c = two();
    const f = fakeDb([guest({ id: 'g1', rowId: 'r1', contactId: 'p1' }), guest({ id: 'g2', rowId: 'r2', contactId: 'p1' }), guest({ id: 'g3', rowId: 'r1', contactId: 'p2' })]);
    const result = await erase(c, f, 'p1');
    expect(result).toEqual({ outcome: 'erased', printedNamesRemoved: 0, printedNamesHeld: 2, coverage: 'no_export' });
    expect(c.rows.has('p1')).toBe(false);
    const held = f.rows.filter((r) => r.id !== 'g3');
    expect(held.every((r) => r.contactId === null && r.displayName === 'Printed Name')).toBe(true);
    expect(held[0].retainUntil!.getUTCFullYear()).toBe(NOW.getUTCFullYear() + RETENTION_YEARS);
    expect(f.rows.find((r) => r.id === 'g3')).toMatchObject({ contactId: 'p2', retainUntil: null });
  });

  it('forward, export then no change: the register equals the export, so the printed names are removed', async () => {
    const c = two();
    const f = fakeDb([guest({ id: 'g1', rowId: 'r1', contactId: 'p1' }), guest({ id: 'g3', rowId: 'r1', contactId: 'p2' })], 'reg-1');
    const result = await erase(c, f, 'p1');
    expect(result).toEqual({ outcome: 'erased', printedNamesRemoved: 1, printedNamesHeld: 0, coverage: 'identical' });
    expect(f.rows.map((r) => r.id)).toEqual(['g3']);
  });

  it('export, then a guest correction: the export no longer equals the register, so the printed names are held', async () => {
    const c = two();
    const f = fakeDb([guest({ id: 'g1', rowId: 'r1', contactId: 'p1' })], 'reg-1');
    f.state.register = 'reg-after-correction';
    const result = await erase(c, f, 'p1');
    expect(result).toMatchObject({ printedNamesRemoved: 0, printedNamesHeld: 1, coverage: 'changed' });
    expect(f.rows[0]).toMatchObject({ contactId: null, displayName: 'Printed Name' });
  });

  it('export, then a new meal guest: held as well', async () => {
    const c = two();
    const f = fakeDb([guest({ id: 'g1', rowId: 'r1', contactId: 'p1' })], 'reg-1');
    f.rows.push(guest({ id: 'g2', rowId: 'r2', contactId: 'p1' }));
    f.state.register = 'reg-with-new-guest';
    await expect(erase(c, f, 'p1')).resolves.toMatchObject({ printedNamesRemoved: 0, printedNamesHeld: 2, coverage: 'changed' });
  });

  it('an export from before the hash existed, a failed recompute and an unknown scope all hold', async () => {
    const old = fakeDb([guest({ id: 'g1', rowId: 'r1', contactId: 'p1' })], null);
    await expect(erase(two(), old, 'p1')).resolves.toMatchObject({ printedNamesHeld: 1, coverage: 'no_hash' });

    const failing = fakeDb([guest({ id: 'g1', rowId: 'r1', contactId: 'p1' })], 'reg-1');
    failing.state.recomputeFails = true;
    await expect(erase(two(), failing, 'p1')).resolves.toMatchObject({ outcome: 'erased', printedNamesHeld: 1, coverage: 'recompute_failed' });

    const noScope = fakeDb([guest({ id: 'g1', rowId: 'r1', contactId: 'p1' })], 'reg-1');
    await expect(erase(two(), noScope, 'p1', NOW, [])).resolves.toMatchObject({ printedNamesHeld: 1, coverage: 'no_workspaces' });
  });

  it('change an earlier input: an export taken between two erasures decides the second one only', async () => {
    const c = two();
    const f = fakeDb([guest({ id: 'g1', rowId: 'r1', contactId: 'p1' }), guest({ id: 'g2', rowId: 'r1', contactId: 'p2' })]);
    await erase(c, f, 'p1');
    // A new export of the register as it now is.
    f.state.exportHash = f.state.register;
    await erase(c, f, 'p2');
    expect(f.rows).toHaveLength(1);
    expect(f.rows[0]).toMatchObject({ id: 'g1', contactId: null });
  });

  it('resume: a run that stopped after the printed names is completed by the next run, without restarting the hold', async () => {
    const c = fakeContacts([row({ id: 'p1', kind: 'person', name: 'Ada' })]);
    const f = fakeDb([guest({ id: 'g1', rowId: 'r1', contactId: 'p1' })]);
    c.erase.mockRejectedValueOnce(new Error('connection lost'));
    await expect(erase(c, f, 'p1')).rejects.toThrow('connection lost');
    expect(c.rows.has('p1')).toBe(true);
    const heldUntil = f.rows[0].retainUntil;
    const later = new Date('2027-01-01T00:00:00Z');
    await expect(erase(c, f, 'p1', later)).resolves.toMatchObject({ outcome: 'erased', printedNamesHeld: 0 });
    expect(c.rows.has('p1')).toBe(false);
    expect(f.rows[0].retainUntil).toEqual(heldUntil);
  });

  it('re-entry: erasing again reports already erased and touches nothing', async () => {
    const c = fakeContacts([row({ id: 'p1', kind: 'person', name: 'Ada' })]);
    const f = fakeDb([guest({ id: 'g1', rowId: 'r1', contactId: 'p1' })]);
    await erase(c, f, 'p1');
    f.raw.mealGuest.updateMany.mockClear();
    f.raw.mealGuest.deleteMany.mockClear();
    await expect(erase(c, f, 'p1')).resolves.toEqual({ outcome: 'already_erased', printedNamesRemoved: 0, printedNamesHeld: 0, coverage: 'no_export' });
    expect(f.raw.mealGuest.updateMany).not.toHaveBeenCalled();
    expect(f.raw.mealGuest.deleteMany).not.toHaveBeenCalled();
  });

  it('an id that is not a contact of this company never reaches the meals', async () => {
    const c = fakeContacts([row({ id: 'p1', kind: 'person', name: 'Ada' })]);
    const f = fakeDb([guest({ id: 'g9', rowId: 'r9', contactId: 'foreign', authTenantId: 'tnt_other' })], 'reg-1');
    await expect(erase(c, f, 'foreign')).resolves.toMatchObject({ outcome: 'already_erased' });
    expect(f.rows).toHaveLength(1);
    expect(f.raw.mealGuest.deleteMany).not.toHaveBeenCalled();
    await expect(preview(c, f, 'foreign')).resolves.toEqual({ exists: false, meals: 0, printedNames: 'held', coverage: 'no_export', linkedPersons: 0 });
    expect(f.raw.mealGuest.findMany).not.toHaveBeenCalled();
  });

  it('an organization is erased and its linked persons stay, unlinked', async () => {
    const c = fakeContacts([
      row({ id: 'o1', kind: 'organization', name: 'Acme' }),
      row({ id: 'p1', kind: 'person', name: 'Ada', organizationId: 'o1' }),
      row({ id: 'p2', kind: 'person', name: 'Grace', organizationId: 'o1' }),
    ]);
    const f = fakeDb([]);
    await expect(preview(c, f, 'o1')).resolves.toMatchObject({ exists: true, meals: 0, linkedPersons: 2 });
    await erase(c, f, 'o1');
    expect([...c.rows.values()].map((p) => [p.id, p.organizationId])).toEqual([['p1', null], ['p2', null]]);
  });

  it('the preview counts meals once each and says which outcome applies and why; it writes nothing', async () => {
    const c = fakeContacts([row({ id: 'p1', kind: 'person', name: 'Ada' })]);
    const f = fakeDb([guest({ id: 'g1', rowId: 'r1', contactId: 'p1' }), guest({ id: 'g2', rowId: 'r2', contactId: 'p1' })]);
    const before = JSON.stringify(f.rows);
    await expect(preview(c, f, 'p1')).resolves.toEqual({ exists: true, meals: 2, printedNames: 'held', coverage: 'no_export', linkedPersons: 0 });
    f.state.exportHash = 'reg-1';
    await expect(preview(c, f, 'p1')).resolves.toMatchObject({ printedNames: 'removed', coverage: 'identical' });
    f.state.register = 'reg-2';
    await expect(preview(c, f, 'p1')).resolves.toMatchObject({ printedNames: 'held', coverage: 'changed' });
    expect(JSON.stringify(f.rows)).toBe(before);
    expect(c.rows.has('p1')).toBe(true);
  });
});

describe('confirmation wording before an erase', () => {
  it('says the printed names stay ten years when no export exists, and when they would be removed instead', () => {
    const text = eraseConfirmation({ meals: 2, printedNames: 'held', coverage: 'no_export', linkedPersons: 0 }, 'person');
    expect(text).toContain('2 Bewirtungen');
    expect(text).toContain('bleiben zehn Jahre erhalten');
    expect(text).toContain('weil noch kein Export vorliegt');
    expect(text).toContain('nur, wenn das aktuelle Verzeichnis mit dem letzten Export übereinstimmt');
    expect(text).toContain('endgültig gelöscht');
  });

  it('says why the names are held when the register changed after the last export', () => {
    const text = eraseConfirmation({ meals: 1, printedNames: 'held', coverage: 'changed', linkedPersons: 0 }, 'person');
    expect(text).toContain('seit dem letzten Export geändert');
    expect(text).toContain('bleiben zehn Jahre erhalten');
    expect(text).not.toContain('werden jetzt entfernt');
  });

  it('says the printed names are removed only because the register is unchanged since the last export, and counts one meal in the singular', () => {
    const text = eraseConfirmation({ meals: 1, printedNames: 'removed', coverage: 'identical', linkedPersons: 0 }, 'person');
    expect(text).toContain('1 Bewirtung.');
    expect(text).toContain('werden jetzt entfernt');
    expect(text).toContain('seit dem letzten Export dieses Kontos unverändert');
  });

  it('mentions neither outcome when no meal names the contact, and the linked persons of an organization', () => {
    const none = eraseConfirmation({ meals: 0, printedNames: 'held', linkedPersons: 0 }, 'person');
    expect(none).toContain('keiner Bewirtung');
    expect(none).not.toContain('zehn Jahre');
    expect(eraseConfirmation({ meals: 0, printedNames: 'held', linkedPersons: 1 }, 'organization')).toContain('1 verknüpfte Person bleibt bestehen und wird nur von der Organisation gelöst');
    expect(eraseConfirmation({ meals: 0, printedNames: 'held', linkedPersons: 3 }, 'organization')).toContain('3 verknüpfte Personen bleiben bestehen und werden nur von der Organisation gelöst');
  });
});

describe('Kontakte tab badge and guest picker', () => {
  it('one person and two organizations: the badge reads 3 and the guest picker offers 1', async () => {
    const c = fakeContacts([
      row({ id: 'p1', kind: 'person', name: 'Ada' }),
      row({ id: 'o1', kind: 'organization', name: 'Acme' }),
      row({ id: 'o2', kind: 'organization', name: 'Globex' }),
    ]);
    const { db } = fakeDb([]);
    const guestPicker = await new SharedContactStore(C(c), db).list({ includeArchived: true });
    const organizations = await countDirectoryOrganizations(C(c));
    expect(guestPicker.map((p) => p.id)).toEqual(['p1']);
    expect(organizations).toBe(2);
    expect(contactsTabCount(guestPicker, organizations)).toBe(3);
    expect((await listDirectory(C(c))).length).toBe(contactsTabCount(guestPicker, organizations));
  });

  it('an archived organization is not counted, matching the list', async () => {
    const c = fakeContacts([row({ id: 'o1', kind: 'organization', name: 'Acme', archived: true }), row({ id: 'o2', kind: 'organization', name: 'Globex' })]);
    expect(await countDirectoryOrganizations(C(c))).toBe(1);
  });
});
