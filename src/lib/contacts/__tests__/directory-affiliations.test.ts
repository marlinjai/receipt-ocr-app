import { describe, expect, it } from 'vitest';
import { ContactError as SharedError, type Affiliation, type Contacts } from '@marlinjai/contacts-core';
import {
  DirectoryError,
  addDirectoryAffiliation,
  endDirectoryAffiliation,
  listDirectoryAffiliations,
  removeDirectoryAffiliation,
  setPrimaryDirectoryAffiliation,
  updateDirectoryAffiliation,
} from '../directory';
import { directoryMessage } from '../directory-messages';

/**
 * The directory's affiliation functions against an in-memory stand-in for the package that follows its rules
 * (kinds, one open row per pair, one primary, stale). The real package is exercised in directory-affiliations.dbtest.ts.
 */
function fake(kinds: Record<string, { kind: 'person' | 'organization'; name: string }>) {
  const rows = new Map<string, Affiliation>();
  let n = 0;
  const api = {
    rows,
    getMany: async (ids: readonly string[]) => ids.filter((id) => kinds[id]).map((id) => ({ id, ...kinds[id] })),
    listAffiliations: async (o: { includeEnded?: boolean } = {}) => [...rows.values()].filter((a) => o.includeEnded || a.endedOn === null),
    getAffiliation: async (id: string) => rows.get(id) ?? null,
    addAffiliation: async (i: { personId: string; organizationId: string; role?: string | null; startedOn?: string | null }) => {
      if (kinds[i.personId]?.kind !== 'person' || kinds[i.organizationId]?.kind !== 'organization') throw new SharedError('invalid_affiliation');
      const open = [...rows.values()].find((a) => a.personId === i.personId && a.organizationId === i.organizationId && a.endedOn === null);
      if (open) throw new SharedError('duplicate_affiliation', { affiliation: open });
      const hasPrimary = [...rows.values()].some((a) => a.personId === i.personId && a.primary && a.endedOn === null);
      const a: Affiliation = {
        id: `a${++n}`, personId: i.personId, organizationId: i.organizationId, role: i.role ?? '', startedOn: i.startedOn ?? null,
        endedOn: null, primary: !hasPrimary, version: 1, createdAt: new Date(0), updatedAt: new Date(0),
      };
      rows.set(a.id, a);
      return { ...a };
    },
    updateAffiliation: async (id: string, patch: { role?: string | null; endedOn?: string | null }, o: { expectedVersion?: number } = {}) => {
      const a = rows.get(id)!;
      if (o.expectedVersion !== undefined && o.expectedVersion !== a.version) throw new SharedError('stale', { affiliation: a });
      const next = { ...a, role: patch.role ?? a.role, endedOn: patch.endedOn === undefined ? a.endedOn : patch.endedOn, version: a.version + 1 };
      rows.set(id, next);
      return { ...next };
    },
    endAffiliation: async (id: string, endedOn?: string) => {
      const a = rows.get(id)!;
      const next = { ...a, endedOn: endedOn ?? '2026-11-11', primary: false, version: a.version + 1 };
      rows.set(id, next);
      return { ...next };
    },
    removeAffiliation: async (id: string) => rows.delete(id),
    setPrimaryAffiliation: async (id: string) => {
      const a = rows.get(id)!;
      if (a.endedOn !== null) throw new SharedError('invalid_affiliation');
      for (const [k, v] of rows) if (v.personId === a.personId) rows.set(k, { ...v, primary: k === id });
      return { ...rows.get(id)! };
    },
  };
  return api as unknown as Contacts & typeof api;
}

const KINDS = {
  p1: { kind: 'person' as const, name: 'Ada' },
  p2: { kind: 'person' as const, name: 'Grace' },
  o1: { kind: 'organization' as const, name: 'Acme GmbH' },
  o2: { kind: 'organization' as const, name: 'Globex AG' },
};

describe('directory affiliations', () => {
  it('forward: a person is affiliated with two businesses, a role at each, and the list carries the names', async () => {
    const c = fake(KINDS);
    await addDirectoryAffiliation(c, { personId: 'p1', organizationId: 'o1', role: 'Leitung' });
    await addDirectoryAffiliation(c, { personId: 'p1', organizationId: 'o2', role: 'Beirat' });
    await addDirectoryAffiliation(c, { personId: 'p2', organizationId: 'o1' });
    const list = await listDirectoryAffiliations(c);
    expect(list.map((a) => [a.personName, a.organizationName, a.role, a.primary])).toEqual([
      ['Ada', 'Acme GmbH', 'Leitung', true],
      ['Ada', 'Globex AG', 'Beirat', false],
      ['Grace', 'Acme GmbH', '', true],
    ]);
  });

  it('refuses a person-to-person pair and a duplicate open pair, with the codes the screen has wording for', async () => {
    const c = fake(KINDS);
    await expect(addDirectoryAffiliation(c, { personId: 'p1', organizationId: 'p2' })).rejects.toMatchObject({ code: 'invalid_affiliation' });
    await addDirectoryAffiliation(c, { personId: 'p1', organizationId: 'o1' });
    await expect(addDirectoryAffiliation(c, { personId: 'p1', organizationId: 'o1' })).rejects.toMatchObject({ code: 'duplicate_affiliation' });
    for (const code of ['invalid_affiliation', 'duplicate_affiliation']) {
      expect(directoryMessage(code)).not.toBe(directoryMessage('unknown-code'));
    }
  });

  it('backtrack: changing the role, then ending and re-adding the same business, keeps the history and opens a new row', async () => {
    const c = fake(KINDS);
    const a = await addDirectoryAffiliation(c, { personId: 'p1', organizationId: 'o1', role: 'Einkauf' });
    const changed = await updateDirectoryAffiliation(c, a.id, { role: 'Leitung' }, a.version);
    expect(changed).toMatchObject({ role: 'Leitung', version: a.version + 1 });
    const ended = await endDirectoryAffiliation(c, a.id, { expectedVersion: changed.version });
    expect(ended.endedOn).not.toBeNull();
    const again = await addDirectoryAffiliation(c, { personId: 'p1', organizationId: 'o1', role: 'Geschäftsführung' });
    expect(again.id).not.toBe(a.id);
    expect((await listDirectoryAffiliations(c)).length).toBe(2);
  });

  it('stale: a change based on an older version is refused, never overwrites, for every write', async () => {
    const c = fake(KINDS);
    const a = await addDirectoryAffiliation(c, { personId: 'p1', organizationId: 'o1', role: 'A' });
    await updateDirectoryAffiliation(c, a.id, { role: 'B' }, a.version);
    await expect(updateDirectoryAffiliation(c, a.id, { role: 'C' }, a.version)).rejects.toMatchObject({ code: 'stale' });
    await expect(endDirectoryAffiliation(c, a.id, { expectedVersion: a.version })).rejects.toMatchObject({ code: 'stale' });
    await expect(removeDirectoryAffiliation(c, a.id, a.version)).rejects.toMatchObject({ code: 'stale' });
    await expect(setPrimaryDirectoryAffiliation(c, a.id, a.version)).rejects.toMatchObject({ code: 'stale' });
    expect(c.rows.get(a.id)!.role).toBe('B');
  });

  it('unknown ids are not_found, ending an ended row changes nothing, removing a missing row is false', async () => {
    const c = fake(KINDS);
    await expect(updateDirectoryAffiliation(c, 'nope', { role: 'x' })).rejects.toMatchObject({ code: 'not_found' });
    const a = await addDirectoryAffiliation(c, { personId: 'p1', organizationId: 'o1' });
    const ended = await endDirectoryAffiliation(c, a.id);
    expect(await endDirectoryAffiliation(c, a.id)).toMatchObject({ endedOn: ended.endedOn, version: ended.version });
    expect(await removeDirectoryAffiliation(c, 'nope')).toBe(false);
    expect(DirectoryError).toBeDefined();
  });

  it('makes another open affiliation the primary one', async () => {
    const c = fake(KINDS);
    await addDirectoryAffiliation(c, { personId: 'p1', organizationId: 'o1' });
    const second = await addDirectoryAffiliation(c, { personId: 'p1', organizationId: 'o2' });
    await setPrimaryDirectoryAffiliation(c, second.id);
    expect((await listDirectoryAffiliations(c)).map((a) => [a.organizationName, a.primary])).toEqual([
      ['Acme GmbH', false],
      ['Globex AG', true],
    ]);
  });
});
