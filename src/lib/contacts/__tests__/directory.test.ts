import { describe, it, expect, vi } from 'vitest';
import { ContactError as SharedError, type Contact as SharedContact, type Contacts } from '@marlinjai/contacts-core';
import type { PrismaClient } from '@prisma/client';
import {
  DirectoryError,
  assignDirectoryCustomerNumber,
  createDirectoryContact,
  eraseDirectoryContact,
  exportDirectoryContact,
  linkPerson,
  listDirectory,
  mergeDirectoryContacts,
  updateDirectoryContact,
} from '../directory';

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
    customerNumber: null,
    version: 1,
    archived: false,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...over,
  };
}

/**
 * An in-memory stand-in for the package's per-company contacts. Its update writes
 * every field from the input, as the package does, so a test fails if a field is
 * not carried forward.
 */
function fakeContacts(initial: SharedContact[]) {
  const rows = new Map(initial.map((c) => [c.id, { ...c }]));
  let nextId = 0;
  let counter = 0;
  const api = {
    rows,
    list: vi.fn(async (opts: { includeArchived?: boolean } = {}) => [...rows.values()].filter((c) => opts.includeArchived || !c.archived).map((c) => ({ ...c }))),
    get: vi.fn(async (id: string) => (rows.get(id) ? { ...rows.get(id)! } : null)),
    create: vi.fn(async (input: Partial<SharedContact> & { kind: 'person' | 'organization'; name: string }) => {
      const same = [...rows.values()].find((c) => c.kind === input.kind && c.name.toLowerCase() === input.name.toLowerCase() && (input.kind === 'organization' || c.companyOrRole === (input.companyOrRole ?? '')));
      if (same) throw new SharedError('duplicate', { existing: { ...same } as never });
      const created = row({ ...input, id: `new-${++nextId}` } as never);
      rows.set(created.id, created);
      return { ...created };
    }),
    update: vi.fn(async (id: string, input: Partial<SharedContact> & { name: string }, options: { expectedVersion?: number } = {}) => {
      const current = rows.get(id)!;
      if (options.expectedVersion !== undefined && options.expectedVersion !== current.version) {
        throw new SharedError('stale', { existing: { ...current } });
      }
      if (input.kind !== undefined && input.kind !== current.kind) throw new SharedError('invalid_field', { field: 'kind' });
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
        version: current.version + 1,
      };
      rows.set(id, written);
      return { ...written };
    }),
    merge: vi.fn(async (loserId: string, winnerId: string) => {
      const loser = rows.get(loserId)!;
      const winner = rows.get(winnerId)!;
      if (loser.kind !== winner.kind) throw new SharedError('merge_kind_mismatch');
      if (!winner.email && loser.email) winner.email = loser.email;
      rows.delete(loserId);
      return { ...winner };
    }),
    assignCustomerNumber: vi.fn(async (id: string) => {
      const current = rows.get(id)!;
      if (current.customerNumber === null) current.customerNumber = ++counter;
      return { ...current };
    }),
    exportContact: vi.fn(async (id: string) => (rows.has(id) ? { contact: { ...rows.get(id)! }, organization: null, members: [] } : null)),
  };
  return api;
}

/** An in-memory stand-in for the meal guest rows the merge repoints. */
function fakeDb(guests: Array<{ id: string; rowId: string; contactId: string; displayName: string }>) {
  const rows = guests.map((g) => ({ ...g }));
  const mealGuest = {
    rows,
    findMany: vi.fn(async ({ where }: { where: { contactId: string } }) => rows.filter((r) => r.contactId === where.contactId).map((r) => ({ ...r }))),
    findFirst: vi.fn(async ({ where }: { where: { rowId: string; contactId: string } }) => rows.find((r) => r.rowId === where.rowId && r.contactId === where.contactId) ?? null),
    deleteMany: vi.fn(async ({ where }: { where: { id: string } }) => {
      const i = rows.findIndex((r) => r.id === where.id);
      if (i >= 0) rows.splice(i, 1);
      return { count: i >= 0 ? 1 : 0 };
    }),
    updateMany: vi.fn(async ({ where, data }: { where: { id: string; contactId: string }; data: { contactId: string } }) => {
      const r = rows.find((x) => x.id === where.id && x.contactId === where.contactId);
      if (r) r.contactId = data.contactId;
      return { count: r ? 1 : 0 };
    }),
  };
  return { db: { mealGuest } as unknown as PrismaClient, mealGuest };
}

describe('pick: linking a person to an organization', () => {
  it('forward: links the person and shows the organization name', async () => {
    const c = fakeContacts([row({ id: 'o1', kind: 'organization', name: 'Acme GmbH' }), row({ id: 'p1', kind: 'person', name: 'Ada' })]);
    const linked = await linkPerson(c as unknown as Contacts, 'p1', 'o1');
    expect(linked).toMatchObject({ organizationId: 'o1', organizationName: 'Acme GmbH' });
  });

  it('change an earlier input: renaming the organization shows on its linked people', async () => {
    const c = fakeContacts([row({ id: 'o1', kind: 'organization', name: 'Acme GmbH' }), row({ id: 'p1', kind: 'person', name: 'Ada' })]);
    await linkPerson(c as unknown as Contacts, 'p1', 'o1');
    await updateDirectoryContact(c as unknown as Contacts, 'o1', { name: 'Acme Holding GmbH' });
    const [person] = (await listDirectory(c as unknown as Contacts)).filter((x) => x.id === 'p1');
    expect(person.organizationName).toBe('Acme Holding GmbH');
  });

  it('several persons may share one organization', async () => {
    const c = fakeContacts([row({ id: 'o1', kind: 'organization', name: 'Acme' }), row({ id: 'p1', kind: 'person', name: 'Ada' }), row({ id: 'p2', kind: 'person', name: 'Grace' })]);
    await linkPerson(c as unknown as Contacts, 'p1', 'o1');
    await linkPerson(c as unknown as Contacts, 'p2', 'o1');
    const people = (await listDirectory(c as unknown as Contacts)).filter((x) => x.kind === 'person');
    expect(people.map((p) => p.organizationId)).toEqual(['o1', 'o1']);
  });

  it('resume: a link to a missing organization changes nothing, and linking again succeeds', async () => {
    const c = fakeContacts([row({ id: 'p1', kind: 'person', name: 'Ada' }), row({ id: 'o1', kind: 'organization', name: 'Acme' })]);
    await expect(linkPerson(c as unknown as Contacts, 'p1', 'missing')).rejects.toMatchObject({ code: 'not_found' });
    expect(c.rows.get('p1')!.organizationId).toBeNull();
    await expect(linkPerson(c as unknown as Contacts, 'p1', 'o1')).resolves.toMatchObject({ organizationId: 'o1' });
  });

  it('re-entry: linking the same pair again leaves the link as it was', async () => {
    const c = fakeContacts([row({ id: 'o1', kind: 'organization', name: 'Acme' }), row({ id: 'p1', kind: 'person', name: 'Ada' })]);
    await linkPerson(c as unknown as Contacts, 'p1', 'o1');
    await expect(linkPerson(c as unknown as Contacts, 'p1', 'o1')).resolves.toMatchObject({ organizationId: 'o1' });
  });

  it('refuses to link a person to another person', async () => {
    const c = fakeContacts([row({ id: 'p1', kind: 'person', name: 'Ada' }), row({ id: 'p2', kind: 'person', name: 'Grace' })]);
    await expect(linkPerson(c as unknown as Contacts, 'p1', 'p2')).rejects.toMatchObject({ code: 'not_organization' });
  });
});

describe('create: organizations with address and tax details', () => {
  it('forward: stores legal form, address, VAT ID and country', async () => {
    const c = fakeContacts([]);
    const org = await createDirectoryContact(c as unknown as Contacts, {
      kind: 'organization',
      name: 'Acme GmbH',
      legalForm: 'GmbH',
      addressLine1: 'Hauptstraße 1',
      postalCode: '10115',
      city: 'Berlin',
      country: 'DE',
      vatId: 'DE123456789',
    });
    expect(org).toMatchObject({ kind: 'organization', legalForm: 'GmbH', postalCode: '10115', city: 'Berlin', country: 'DE', vatId: 'DE123456789' });
  });

  it('change an earlier input: a duplicate name is refused and names the existing contact', async () => {
    const c = fakeContacts([row({ id: 'o1', kind: 'organization', name: 'Acme GmbH' })]);
    const err = await createDirectoryContact(c as unknown as Contacts, { kind: 'organization', name: 'acme gmbh' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DirectoryError);
    expect((err as DirectoryError).code).toBe('duplicate');
    expect((err as DirectoryError).existingId).toBe('o1');
  });

  it('resume: a save based on an old version is refused as stale, and saving after a reload succeeds', async () => {
    const c = fakeContacts([row({ id: 'o1', kind: 'organization', name: 'Acme', version: 2 })]);
    await expect(updateDirectoryContact(c as unknown as Contacts, 'o1', { city: 'Köln' }, 1)).rejects.toMatchObject({ code: 'stale' });
    await expect(updateDirectoryContact(c as unknown as Contacts, 'o1', { city: 'Köln' }, 2)).resolves.toMatchObject({ city: 'Köln' });
  });

  it('re-entry: creating the same organization again is a duplicate, not a second contact', async () => {
    const c = fakeContacts([]);
    await createDirectoryContact(c as unknown as Contacts, { kind: 'organization', name: 'Acme' });
    await expect(createDirectoryContact(c as unknown as Contacts, { kind: 'organization', name: 'Acme' })).rejects.toMatchObject({ code: 'duplicate' });
    expect(c.rows.size).toBe(1);
  });

  it('keeps fields that an edit does not give, and never changes the kind', async () => {
    const c = fakeContacts([row({ id: 'o1', kind: 'organization', name: 'Acme', email: 'info@acme.test', vatId: 'DE1' })]);
    const updated = await updateDirectoryContact(c as unknown as Contacts, 'o1', { name: 'Acme AG' });
    expect(updated).toMatchObject({ name: 'Acme AG', email: 'info@acme.test', vatId: 'DE1' });
    await expect(updateDirectoryContact(c as unknown as Contacts, 'o1', { kind: 'person' })).rejects.toMatchObject({ code: 'invalid' });
  });
});

describe('merge: folding one contact into another', () => {
  const setup = () => {
    const c = fakeContacts([
      row({ id: 'win', kind: 'person', name: 'Ada', companyOrRole: 'Engines' }),
      row({ id: 'los', kind: 'person', name: 'Ada L.', companyOrRole: 'Engines', email: 'ada@example.test' }),
    ]);
    const { db, mealGuest } = fakeDb([
      { id: 'g1', rowId: 'meal-a', contactId: 'los', displayName: 'Ada L.' },
      { id: 'g2', rowId: 'meal-b', contactId: 'win', displayName: 'Ada' },
      { id: 'g3', rowId: 'meal-b', contactId: 'los', displayName: 'Ada L.' },
    ]);
    return { c, db, mealGuest };
  };

  it('forward: removes the loser, repoints its meal rows and keeps printed names', async () => {
    const { c, db, mealGuest } = setup();
    const result = await mergeDirectoryContacts(c as unknown as Contacts, db, 'los', 'win');
    expect(result).toMatchObject({ outcome: 'merged', repointed: 1, deduplicated: 1 });
    expect(c.rows.has('los')).toBe(false);
    expect(mealGuest.rows.map((r) => [r.rowId, r.contactId])).toEqual([['meal-a', 'win'], ['meal-b', 'win']]);
    expect(mealGuest.rows.map((r) => r.displayName)).toEqual(['Ada L.', 'Ada']);
    expect(result.winner.email).toBe('ada@example.test');
  });

  it('resume: when the first step already ran, the next run finishes the repoint', async () => {
    const { c, db, mealGuest } = setup();
    c.rows.delete('los');
    const result = await mergeDirectoryContacts(c as unknown as Contacts, db, 'los', 'win');
    expect(result.outcome).toBe('already_merged');
    expect(mealGuest.rows.every((r) => r.contactId === 'win')).toBe(true);
  });

  it('re-entry: a second merge reports already merged and changes nothing more', async () => {
    const { c, db, mealGuest } = setup();
    await mergeDirectoryContacts(c as unknown as Contacts, db, 'los', 'win');
    const before = JSON.stringify(mealGuest.rows);
    const again = await mergeDirectoryContacts(c as unknown as Contacts, db, 'los', 'win');
    expect(again).toMatchObject({ outcome: 'already_merged', repointed: 0, deduplicated: 0 });
    expect(JSON.stringify(mealGuest.rows)).toBe(before);
  });

  it('refuses to merge a contact into itself and a person into an organization', async () => {
    const { c, db } = setup();
    c.rows.set('org', row({ id: 'org', kind: 'organization', name: 'Acme' }));
    await expect(mergeDirectoryContacts(c as unknown as Contacts, db, 'win', 'win')).rejects.toMatchObject({ code: 'same_contact' });
    await expect(mergeDirectoryContacts(c as unknown as Contacts, db, 'win', 'org')).rejects.toMatchObject({ code: 'kind_mismatch' });
  });
});

describe('customer number and export', () => {
  it('assigns one formatted number and returns the same number on a repeat', async () => {
    const c = fakeContacts([row({ id: 'p1', kind: 'person', name: 'Ada' })]);
    const first = await assignDirectoryCustomerNumber(c as unknown as Contacts, 'p1');
    const again = await assignDirectoryCustomerNumber(c as unknown as Contacts, 'p1');
    expect(first.customerNumber).toBe('0001');
    expect(again.customerNumber).toBe('0001');
  });

  it('exports one contact and reports a missing one as not found', async () => {
    const c = fakeContacts([row({ id: 'p1', kind: 'person', name: 'Ada' })]);
    await expect(exportDirectoryContact(c as unknown as Contacts, 'p1')).resolves.toMatchObject({ contact: { id: 'p1' } });
    await expect(exportDirectoryContact(c as unknown as Contacts, 'nope')).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('erase: shown but not available yet', () => {
  it('refuses and writes nothing', () => {
    expect(() => eraseDirectoryContact()).toThrow(DirectoryError);
    expect(() => eraseDirectoryContact()).toThrow(expect.objectContaining({ code: 'unavailable' }) as never);
  });
});
