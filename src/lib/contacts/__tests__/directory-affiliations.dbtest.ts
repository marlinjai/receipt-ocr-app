import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../../../test/db-helpers';
import { ensureContactsLayout } from '../../../../test/contacts-db';
import { companyContacts, contactsDb } from '../db';
import {
  addDirectoryAffiliation,
  createDirectoryContact,
  endDirectoryAffiliation,
  eraseDirectoryContact,
  exportDirectoryContact,
  listDirectory,
  listDirectoryAffiliations,
  mergeDirectoryContacts,
  removeDirectoryAffiliation,
  setPrimaryDirectoryAffiliation,
  updateDirectoryAffiliation,
  updateDirectoryContact,
} from '../directory';

/**
 * Affiliations through the directory against the real contacts database (contacts-core 0.5.0 layout):
 * the four paths (forward, backtrack, resume, re-entry), stale and duplicate refusals, the legacy text that
 * is never turned into a role, and erase of a person and of a business.
 */

const company = () => `test-aff-${randomUUID()}`;

beforeAll(async () => {
  await ensureContactsLayout();
});

afterAll(async () => {
  await contactsDb().close();
  await db.$disconnect();
});

async function setup() {
  const contacts = companyContacts(company());
  const acme = await createDirectoryContact(contacts, { kind: 'organization', name: 'Acme GmbH' });
  const globex = await createDirectoryContact(contacts, { kind: 'organization', name: 'Globex AG' });
  const ada = await createDirectoryContact(contacts, { kind: 'person', name: 'Ada Beispiel', companyOrRole: 'Einkauf' });
  const grace = await createDirectoryContact(contacts, { kind: 'person', name: 'Grace Beispiel' });
  return { contacts, acme, globex, ada, grace };
}

describe('directory affiliations against the real contacts database', () => {
  it('forward: one person in two businesses with a role at each, one business with two people', async () => {
    const { contacts, acme, globex, ada, grace } = await setup();
    await addDirectoryAffiliation(contacts, { personId: ada.id, organizationId: acme.id, role: 'Leitung', startedOn: '2024-01-01' });
    await addDirectoryAffiliation(contacts, { personId: ada.id, organizationId: globex.id, role: 'Beirat' });
    await addDirectoryAffiliation(contacts, { personId: grace.id, organizationId: acme.id, role: 'Einkauf' });
    const list = await listDirectoryAffiliations(contacts);
    expect(list.filter((a) => a.personId === ada.id).map((a) => [a.organizationName, a.role, a.primary])).toEqual([
      ['Acme GmbH', 'Leitung', true],
      ['Globex AG', 'Beirat', false],
    ]);
    expect(list.filter((a) => a.organizationId === acme.id).map((a) => a.personName).sort()).toEqual(['Ada Beispiel', 'Grace Beispiel']);
    // The old single link still shows the primary business in the list.
    expect((await listDirectory(contacts)).find((c) => c.id === ada.id)).toMatchObject({ organizationId: acme.id, organizationName: 'Acme GmbH' });
  });

  it('the legacy text stays exactly as it was and is never copied into a role; adopting it is a separate, explicit write', async () => {
    const { contacts, acme, ada } = await setup();
    const a = await addDirectoryAffiliation(contacts, { personId: ada.id, organizationId: acme.id });
    expect(a.role).toBe('');
    expect((await listDirectory(contacts)).find((c) => c.id === ada.id)?.companyOrRole).toBe('Einkauf');
    const adopted = await updateDirectoryAffiliation(contacts, a.id, { role: 'Einkauf' }, a.version);
    expect(adopted.role).toBe('Einkauf');
    // Editing the person's other details later does not touch the affiliation or the link.
    await updateDirectoryContact(contacts, ada.id, { phone: '+49 30 1234' });
    const after = (await listDirectoryAffiliations(contacts)).find((x) => x.id === a.id)!;
    expect(after).toMatchObject({ role: 'Einkauf', primary: true, endedOn: null });
    expect((await listDirectory(contacts)).find((c) => c.id === ada.id)).toMatchObject({ organizationId: acme.id, companyOrRole: 'Einkauf' });
  });

  it('backtrack: change the role, end it, add the same business again; the history keeps both rows', async () => {
    const { contacts, acme, ada } = await setup();
    const a = await addDirectoryAffiliation(contacts, { personId: ada.id, organizationId: acme.id, role: 'Einkauf' });
    const changed = await updateDirectoryAffiliation(contacts, a.id, { role: 'Leitung' }, a.version);
    const ended = await endDirectoryAffiliation(contacts, a.id, { expectedVersion: changed.version, endedOn: '2025-06-30' });
    expect(ended).toMatchObject({ role: 'Leitung', endedOn: '2025-06-30', primary: false });
    expect((await listDirectory(contacts)).find((c) => c.id === ada.id)?.organizationId).toBeNull();
    const again = await addDirectoryAffiliation(contacts, { personId: ada.id, organizationId: acme.id, role: 'Geschäftsführung' });
    expect(again).toMatchObject({ primary: true, endedOn: null });
    const all = (await listDirectoryAffiliations(contacts)).filter((x) => x.personId === ada.id);
    expect(all.map((x) => [x.role, x.endedOn])).toEqual(expect.arrayContaining([['Leitung', '2025-06-30'], ['Geschäftsführung', null]]));
  });

  it('resume: a fresh read (new page load) shows exactly what is stored, ended rows included', async () => {
    const { contacts, acme, globex, ada } = await setup();
    const first = await addDirectoryAffiliation(contacts, { personId: ada.id, organizationId: acme.id, role: 'A' });
    await addDirectoryAffiliation(contacts, { personId: ada.id, organizationId: globex.id, role: 'B' });
    await endDirectoryAffiliation(contacts, first.id);
    const reloaded = companyContacts(contacts.tenantId);
    const list = await listDirectoryAffiliations(reloaded);
    expect(list.map((a) => [a.organizationName, a.role, a.endedOn !== null, a.primary]).sort()).toEqual(
      [
        ['Acme GmbH', 'A', true, false],
        ['Globex AG', 'B', false, true],
      ].sort(),
    );
  });

  it('refuses a duplicate open pair, a stale save and a wrong kind with the package codes; nothing is overwritten', async () => {
    const { contacts, acme, ada, grace } = await setup();
    const a = await addDirectoryAffiliation(contacts, { personId: ada.id, organizationId: acme.id, role: 'A' });
    await expect(addDirectoryAffiliation(contacts, { personId: ada.id, organizationId: acme.id })).rejects.toMatchObject({ code: 'duplicate_affiliation' });
    await expect(addDirectoryAffiliation(contacts, { personId: ada.id, organizationId: grace.id })).rejects.toMatchObject({ code: 'invalid_affiliation' });
    await updateDirectoryAffiliation(contacts, a.id, { role: 'B' }, a.version);
    await expect(updateDirectoryAffiliation(contacts, a.id, { role: 'C' }, a.version)).rejects.toMatchObject({ code: 'stale' });
    expect((await listDirectoryAffiliations(contacts)).find((x) => x.id === a.id)?.role).toBe('B');
  });

  it('another company can neither see nor change these affiliations', async () => {
    const { contacts, acme, ada } = await setup();
    const a = await addDirectoryAffiliation(contacts, { personId: ada.id, organizationId: acme.id });
    const other = companyContacts(company());
    expect(await listDirectoryAffiliations(other)).toEqual([]);
    await expect(updateDirectoryAffiliation(other, a.id, { role: 'x' })).rejects.toMatchObject({ code: 'not_found' });
    await expect(endDirectoryAffiliation(other, a.id)).rejects.toMatchObject({ code: 'not_found' });
    expect(await removeDirectoryAffiliation(other, a.id)).toBe(false);
    await expect(addDirectoryAffiliation(other, { personId: ada.id, organizationId: acme.id })).rejects.toMatchObject({ code: 'not_found' });
  });

  it('primary: changing it moves the old single link along; ending the primary promotes the next', async () => {
    const { contacts, acme, globex, ada } = await setup();
    await addDirectoryAffiliation(contacts, { personId: ada.id, organizationId: acme.id });
    const second = await addDirectoryAffiliation(contacts, { personId: ada.id, organizationId: globex.id });
    await setPrimaryDirectoryAffiliation(contacts, second.id);
    expect((await listDirectory(contacts)).find((c) => c.id === ada.id)?.organizationId).toBe(globex.id);
    await endDirectoryAffiliation(contacts, second.id);
    expect((await listDirectory(contacts)).find((c) => c.id === ada.id)?.organizationId).toBe(acme.id);
  });

  it('erasing a person removes their affiliations and keeps the business and its other people', async () => {
    const { contacts, acme, ada, grace } = await setup();
    await addDirectoryAffiliation(contacts, { personId: ada.id, organizationId: acme.id });
    await addDirectoryAffiliation(contacts, { personId: grace.id, organizationId: acme.id });
    await eraseDirectoryContact(contacts, db, ada.id, []);
    const left = await listDirectoryAffiliations(contacts);
    expect(left.map((a) => a.personId)).toEqual([grace.id]);
    expect((await exportDirectoryContact(contacts, acme.id)).members.map((m) => m.id)).toEqual([grace.id]);
  });

  it('erasing a business removes its affiliations, keeps the people and their other affiliations', async () => {
    const { contacts, acme, globex, ada, grace } = await setup();
    await addDirectoryAffiliation(contacts, { personId: ada.id, organizationId: acme.id });
    await addDirectoryAffiliation(contacts, { personId: ada.id, organizationId: globex.id, role: 'Beirat' });
    await addDirectoryAffiliation(contacts, { personId: grace.id, organizationId: acme.id });
    await eraseDirectoryContact(contacts, db, acme.id, []);
    const left = await listDirectoryAffiliations(contacts);
    expect(left.map((a) => [a.personId, a.organizationName, a.role])).toEqual([[ada.id, 'Globex AG', 'Beirat']]);
    expect((await listDirectory(contacts)).filter((c) => c.kind === 'person')).toHaveLength(2);
    expect((await listDirectory(contacts)).find((c) => c.id === ada.id)?.organizationId).toBe(globex.id);
  });

  it('merging two persons keeps every business with its role and creates no duplicate', async () => {
    const { contacts, acme, globex, ada, grace } = await setup();
    await addDirectoryAffiliation(contacts, { personId: ada.id, organizationId: acme.id, role: 'A' });
    await addDirectoryAffiliation(contacts, { personId: grace.id, organizationId: acme.id, role: 'G' });
    await addDirectoryAffiliation(contacts, { personId: grace.id, organizationId: globex.id, role: 'G2' });
    await mergeDirectoryContacts(contacts, db, grace.id, ada.id);
    const open = (await listDirectoryAffiliations(contacts)).filter((a) => a.endedOn === null);
    expect(open.map((a) => [a.organizationName, a.role]).sort()).toEqual([['Acme GmbH', 'A'], ['Globex AG', 'G2']]);
  });
});
