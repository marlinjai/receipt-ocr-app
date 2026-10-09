import { describe, it, expect, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import {
  ContactError as SharedContactError,
  type Contact as SharedContact,
  type Contacts,
} from '@marlinjai/contacts-core';
import { ContactError } from '../store';
import { SharedContactStore, reconcileGuestCopies } from '../shared-store';

function person(over: Partial<SharedContact> = {}): SharedContact {
  return {
    id: 'c1',
    kind: 'person',
    name: 'Ada Lovelace',
    companyOrRole: 'Analytical Engines',
    organizationId: null,
    email: 'ada@example.test',
    phone: '+49 30 0000',
    note: 'Prefers morning calls',
    legalForm: null,
    addressLine1: null,
    addressLine2: null,
    postalCode: null,
    city: 'London',
    country: 'GB',
    vatId: null,
    preferredContact: null,
    customFields: {},
    customerNumber: null,
    version: 3,
    archived: false,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...over,
  };
}

/**
 * An in-memory stand-in for the package's per-company `Contacts`. Its `update`
 * writes EVERY field from the input, as the real package does, so a test fails
 * if the store forgets to carry a field across.
 */
function fakeContacts(initial: SharedContact[]) {
  const rows = new Map(initial.map((c) => [c.id, { ...c }]));
  let nextId = 0;
  const api = {
    rows,
    list: vi.fn(async (opts: { kind?: string; includeArchived?: boolean } = {}) =>
      [...rows.values()].filter(
        (c) => (!opts.kind || c.kind === opts.kind) && (opts.includeArchived || !c.archived),
      ),
    ),
    get: vi.fn(async (id: string) => rows.get(id) ?? null),
    getMany: vi.fn(async (ids: readonly string[]) => ids.map((id) => rows.get(id)).filter(Boolean)),
    create: vi.fn(async (input: { kind?: string; name: string; companyOrRole?: string | null; note?: string | null }) => {
      const same = [...rows.values()].find(
        (c) => c.kind === (input.kind ?? 'person') && c.name.toLowerCase() === input.name.toLowerCase(),
      );
      if (same) throw new SharedContactError('duplicate', { existing: same });
      const created = person({
        id: `new${++nextId}`,
        kind: (input.kind ?? 'person') as 'person',
        name: input.name,
        companyOrRole: input.companyOrRole ?? '',
        email: null,
        phone: null,
        note: input.note ?? null,
        version: 1,
      });
      rows.set(created.id, created);
      return { ...created };
    }),
    update: vi.fn(
      async (
        id: string,
        input: Partial<SharedContact> & { name: string },
        options: { expectedVersion?: number } = {},
      ) => {
        const current = rows.get(id)!;
        if (options.expectedVersion !== undefined && options.expectedVersion !== current.version) {
          throw new SharedContactError('stale', { existing: { ...current } });
        }
        const written: SharedContact = {
          ...current,
          name: input.name,
          companyOrRole: input.companyOrRole ?? '',
          note: input.note ?? null,
          organizationId: input.organizationId ?? null,
          email: input.email ?? null,
          phone: input.phone ?? null,
          legalForm: input.legalForm ?? null,
          addressLine1: input.addressLine1 ?? null,
          addressLine2: input.addressLine2 ?? null,
          postalCode: input.postalCode ?? null,
          city: input.city ?? null,
          country: input.country ?? null,
          vatId: input.vatId ?? null,
          preferredContact: input.preferredContact ?? null,
          version: current.version + 1,
        };
        rows.set(id, written);
        return { ...written };
      },
    ),
    archive: vi.fn(async (id: string) => {
      const row = { ...rows.get(id)!, archived: true };
      rows.set(id, row);
      return { ...row };
    }),
    restore: vi.fn(async (id: string) => {
      const row = { ...rows.get(id)!, archived: false };
      rows.set(id, row);
      return { ...row };
    }),
  };
  return api;
}

/** An in-memory stand-in for the `meal_guests` rows the store touches. */
function fakePrisma(copies: Array<{ contactId: string; displayName: string; displayCompany: string }>) {
  const rows = copies.map((c) => ({ ...c }));
  const mealGuest = {
    rows,
    findMany: vi.fn(async () => rows.map((r) => ({ ...r }))),
    updateMany: vi.fn(async ({ where, data }: { where: { contactId: string }; data: Record<string, string> }) => {
      let count = 0;
      for (const r of rows) {
        if (r.contactId === where.contactId) {
          Object.assign(r, data);
          count++;
        }
      }
      return { count };
    }),
  };
  return { prisma: { mealGuest } as unknown as PrismaClient, mealGuest };
}

function storeWith(contacts: SharedContact[], copies: Parameters<typeof fakePrisma>[0] = []) {
  const shared = fakeContacts(contacts);
  const guests = fakePrisma(copies);
  const store = new SharedContactStore(shared as unknown as Contacts, guests.prisma);
  return { store, shared, guests };
}

describe('SharedContactStore: picking and creating guests', () => {
  it('lists only persons, active first, and maps to the receipts shape', async () => {
    const { store } = storeWith([
      person({ id: 'p1', name: 'Ada' }),
      person({ id: 'p2', name: 'Grace', archived: true }),
      person({ id: 'o1', kind: 'organization', name: 'Analytical Engines', companyOrRole: '' }),
    ]);
    expect(await store.list()).toEqual([{ id: 'p1', name: 'Ada', companyOrRole: 'Analytical Engines', note: 'Prefers morning calls', archived: false }]);
    const all = await store.list({ includeArchived: true });
    expect(all.map((c) => c.id)).toEqual(['p1', 'p2']);
  });

  it('creates a person, never an organization', async () => {
    const { store, shared } = storeWith([]);
    const created = await store.create({ name: '  Ada   King ', companyOrRole: 'Engines', note: '' });
    expect(created).toMatchObject({ name: 'Ada King', companyOrRole: 'Engines', note: null, archived: false });
    expect(shared.create).toHaveBeenCalledWith({ kind: 'person', name: 'Ada King', companyOrRole: 'Engines', note: null });
  });

  it('reports a duplicate with the existing contact, as the receipts error', async () => {
    const { store } = storeWith([person({ id: 'p1', name: 'Ada' })]);
    const err = await store.create({ name: 'ada' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ContactError);
    expect((err as ContactError).code).toBe('duplicate');
    expect((err as ContactError).existing?.id).toBe('p1');
  });

  it('rejects an empty name before it reaches the shared database', async () => {
    const { store, shared } = storeWith([]);
    await expect(store.create({ name: '   ' })).rejects.toMatchObject({ code: 'invalid_name' });
    expect(shared.create).not.toHaveBeenCalled();
  });

  it('keeps an organization id out of the guest picker', async () => {
    const { store } = storeWith([person({ id: 'o1', kind: 'organization', name: 'Acme', companyOrRole: '' })]);
    await expect(store.getMany(['o1'])).resolves.toEqual([]);
    await expect(store.archive('o1')).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('SharedContactStore: correcting a guest (two steps)', () => {
  it('keeps the fields this app does not edit (another app may have written them)', async () => {
    const { store, shared } = storeWith([person()]);
    await store.update('c1', { name: 'Ada King', companyOrRole: 'Analytical Engines Ltd' });
    expect(shared.rows.get('c1')).toMatchObject({
      name: 'Ada King',
      companyOrRole: 'Analytical Engines Ltd',
      email: 'ada@example.test',
      phone: '+49 30 0000',
      city: 'London',
      country: 'GB',
    });
  });

  it('saves against the version it read, so a concurrent edit is refused', async () => {
    const { store, shared } = storeWith([person()]);
    await store.update('c1', { name: 'Ada King' });
    expect(shared.update).toHaveBeenCalledWith('c1', expect.any(Object), { expectedVersion: 3 });
  });

  it('corrects the printed copies by contact id alone, so every workspace follows', async () => {
    const { store, guests } = storeWith(
      [person()],
      [
        { contactId: 'c1', displayName: 'Ada Lovelace', displayCompany: 'Analytical Engines' },
        { contactId: 'c1', displayName: 'Ada Lovelace', displayCompany: 'Analytical Engines' },
      ],
    );
    await store.update('c1', { name: 'Ada King', companyOrRole: 'Engines' });
    expect(guests.mealGuest.updateMany).toHaveBeenCalledWith({
      where: { contactId: 'c1' },
      data: { displayName: 'Ada King', displayCompany: 'Engines' },
    });
    expect(guests.mealGuest.rows.every((r) => r.displayName === 'Ada King' && r.displayCompany === 'Engines')).toBe(true);
  });

  it('does not report a correction as saved when the printed copies cannot follow', async () => {
    const { store, guests } = storeWith([person()], [{ contactId: 'c1', displayName: 'Ada', displayCompany: '' }]);
    guests.mealGuest.updateMany.mockRejectedValueOnce(new Error('connection lost'));
    await expect(store.update('c1', { name: 'Ada King' })).rejects.toThrow('connection lost');
  });

  it('saving the same correction again is the retry and changes nothing else', async () => {
    const { store, shared, guests } = storeWith([person()], [{ contactId: 'c1', displayName: 'Ada', displayCompany: '' }]);
    guests.mealGuest.updateMany.mockRejectedValueOnce(new Error('connection lost'));
    await expect(store.update('c1', { name: 'Ada King' })).rejects.toThrow();
    // The contact was written in step one, so the version moved on.
    expect(shared.rows.get('c1')!.version).toBe(4);
    const retried = await store.update('c1', { name: 'Ada King' });
    expect(retried).toMatchObject({ name: 'Ada King', archived: false });
    expect(guests.mealGuest.rows[0]).toMatchObject({ displayName: 'Ada King' });
    expect(shared.rows.get('c1')!.version).toBe(5);
  });

  it('surfaces a stale save as the receipts stale error, not as success', async () => {
    const { store, shared } = storeWith([person()]);
    shared.update.mockRejectedValueOnce(new SharedContactError('stale', { existing: person({ version: 4 }) }));
    await expect(store.update('c1', { name: 'Ada King' })).rejects.toMatchObject({ code: 'stale' });
  });

  it('keeps a contact that is already on meals in two workspaces consistent after an archive', async () => {
    const { store, guests } = storeWith([person()], [{ contactId: 'c1', displayName: 'Ada Lovelace', displayCompany: 'Analytical Engines' }]);
    await store.archive('c1');
    const listed = await store.list({ includeArchived: true });
    expect(listed[0]).toMatchObject({ id: 'c1', archived: true, name: 'Ada Lovelace' });
    expect(guests.mealGuest.rows[0].displayName).toBe('Ada Lovelace');
  });
});

describe('reconcileGuestCopies (run on every contact list)', () => {
  it('repairs printed copies that drifted from their contact', async () => {
    const { prisma, mealGuest } = fakePrisma([
      { contactId: 'c1', displayName: 'Ada Lovelace', displayCompany: 'Old Co' },
      { contactId: 'c2', displayName: 'Grace', displayCompany: '' },
    ]);
    const fixed = await reconcileGuestCopies(prisma, [
      { id: 'c1', name: 'Ada Lovelace', companyOrRole: 'New Co', note: null, archived: false },
      { id: 'c2', name: 'Grace', companyOrRole: '', note: null, archived: false },
    ]);
    expect(fixed).toBe(1);
    expect(mealGuest.updateMany).toHaveBeenCalledTimes(1);
    expect(mealGuest.rows[0].displayCompany).toBe('New Co');
  });

  it('writes nothing when the copies already match (re-entry is a no-op)', async () => {
    const { prisma, mealGuest } = fakePrisma([{ contactId: 'c1', displayName: 'Ada', displayCompany: '' }]);
    const contacts = [{ id: 'c1', name: 'Ada', companyOrRole: '', note: null, archived: false }];
    expect(await reconcileGuestCopies(prisma, contacts)).toBe(0);
    expect(await reconcileGuestCopies(prisma, contacts)).toBe(0);
    expect(mealGuest.updateMany).not.toHaveBeenCalled();
  });

  it('does nothing without contacts and asks the database for no rows', async () => {
    const { prisma, mealGuest } = fakePrisma([]);
    expect(await reconcileGuestCopies(prisma, [])).toBe(0);
    expect(mealGuest.findMany).not.toHaveBeenCalled();
  });
});
