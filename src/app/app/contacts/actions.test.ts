import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The affiliation server actions: reads need a receipts session, every write needs the receipts write right, the
 * company always comes from the session, and failures come back as codes (a thrown error loses its message in a
 * production build). Auth and the contacts store are replaced; the rules of the package are in the database tests.
 */

const requireAction = vi.fn();
const requireReceiptsSession = vi.fn();
const store = {
  listAffiliations: vi.fn(async () => []),
  getAffiliation: vi.fn(),
  addAffiliation: vi.fn(),
  updateAffiliation: vi.fn(),
  endAffiliation: vi.fn(),
  removeAffiliation: vi.fn(),
  setPrimaryAffiliation: vi.fn(),
  getMany: vi.fn(async () => []),
};
const companyContacts = vi.fn((_tenantId: string) => store);

vi.mock('@/lib/auth', () => ({ auth: { requireAction: (...a: unknown[]) => requireAction(...a) } }));
vi.mock('@/lib/auth-guards', () => {
  class ReceiptsAuthError extends Error {
    constructor(readonly status: number) {
      super('auth');
    }
  }
  return { ReceiptsAuthError, requireReceiptsSession: (...a: unknown[]) => requireReceiptsSession(...a) };
});
vi.mock('@/lib/contacts/db', () => ({ companyContacts: (t: string) => companyContacts(t) }));
vi.mock('@/lib/prisma', () => ({ prisma: {} }));

import { ReceiptsAuthError } from '@/lib/auth-guards';
import {
  addAffiliationAction,
  endAffiliationAction,
  listAffiliationsAction,
  removeAffiliationAction,
  setPrimaryAffiliationAction,
  updateAffiliationAction,
} from './actions';

const WS = { id: 'ws-a', slug: 'a', role: 'member', tenantId: 't-a' };
const SESSION = { memberships: [WS], activeWorkspace: WS };
const AFFILIATION = { id: 'a1', personId: 'p', organizationId: 'o', role: '', startedOn: null, endedOn: null, primary: true, version: 2, createdAt: new Date(0), updatedAt: new Date(0) };

beforeEach(() => {
  vi.clearAllMocks();
  requireAction.mockResolvedValue(SESSION);
  requireReceiptsSession.mockResolvedValue(SESSION);
  store.getAffiliation.mockResolvedValue(AFFILIATION);
  store.addAffiliation.mockResolvedValue(AFFILIATION);
  store.updateAffiliation.mockResolvedValue(AFFILIATION);
  store.endAffiliation.mockResolvedValue({ ...AFFILIATION, endedOn: '2026-11-11' });
  store.setPrimaryAffiliation.mockResolvedValue(AFFILIATION);
  store.removeAffiliation.mockResolvedValue(true);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('affiliation actions: rights', () => {
  it('a read needs only a receipts session, and never asks for the write right', async () => {
    const r = await listAffiliationsAction();
    expect(r).toEqual({ ok: true, value: [] });
    expect(requireReceiptsSession).toHaveBeenCalled();
    expect(requireAction).not.toHaveBeenCalled();
    expect(companyContacts).toHaveBeenCalledWith('t-a');
  });

  it('every write asks for receipts.row.write and writes nothing when it is refused', async () => {
    requireAction.mockRejectedValue(new ReceiptsAuthError(403));
    const results = await Promise.all([
      addAffiliationAction({ personId: 'p', organizationId: 'o' }),
      updateAffiliationAction('a1', { role: 'x' }, 2),
      endAffiliationAction('a1', 2),
      removeAffiliationAction('a1', 2),
      setPrimaryAffiliationAction('a1', 2),
    ]);
    for (const r of results) expect(r).toEqual({ ok: false, error: 'forbidden' });
    expect(requireAction).toHaveBeenCalledTimes(5);
    expect(requireAction).toHaveBeenCalledWith('receipts.row.write');
    for (const fn of [store.addAffiliation, store.updateAffiliation, store.endAffiliation, store.removeAffiliation, store.setPrimaryAffiliation]) {
      expect(fn).not.toHaveBeenCalled();
    }
  });

  it('an expired session is unauthorized for reads and writes', async () => {
    requireReceiptsSession.mockRejectedValue(new ReceiptsAuthError(401));
    requireAction.mockRejectedValue(new ReceiptsAuthError(401));
    expect(await listAffiliationsAction()).toEqual({ ok: false, error: 'unauthorized' });
    expect(await addAffiliationAction({ personId: 'p', organizationId: 'o' })).toEqual({ ok: false, error: 'unauthorized' });
  });

  it('the company is the session\'s, never a value from the caller', async () => {
    await addAffiliationAction({ personId: 'p', organizationId: 'o', role: ' Leitung ', tenantId: 'other' } as never);
    expect(companyContacts).toHaveBeenCalledWith('t-a');
    expect(store.addAffiliation).toHaveBeenCalledWith({ personId: 'p', organizationId: 'o', role: ' Leitung ', startedOn: null });
  });
});

describe('affiliation actions: the version the screen read', () => {
  it('a change made since is refused as stale and nothing is written', async () => {
    const stale = await updateAffiliationAction('a1', { role: 'x' }, 1);
    expect(stale).toEqual({ ok: false, error: 'stale' });
    expect(await endAffiliationAction('a1', 1)).toEqual({ ok: false, error: 'stale' });
    expect(await removeAffiliationAction('a1', 1)).toEqual({ ok: false, error: 'stale' });
    expect(await setPrimaryAffiliationAction('a1', 1)).toEqual({ ok: false, error: 'stale' });
    for (const fn of [store.updateAffiliation, store.endAffiliation, store.removeAffiliation, store.setPrimaryAffiliation]) {
      expect(fn).not.toHaveBeenCalled();
    }
  });

  it('with the current version the write goes through and a missing row is not_found', async () => {
    expect(await updateAffiliationAction('a1', { role: 'x' }, 2)).toMatchObject({ ok: true });
    expect(store.updateAffiliation).toHaveBeenCalledWith('a1', { role: 'x' }, { expectedVersion: 2 });
    store.getAffiliation.mockResolvedValue(null);
    expect(await updateAffiliationAction('gone', { role: 'x' }, 1)).toEqual({ ok: false, error: 'not_found' });
  });

  it('an unexpected failure is a code, not a thrown error', async () => {
    store.addAffiliation.mockRejectedValue(new Error('connection lost'));
    expect(await addAffiliationAction({ personId: 'p', organizationId: 'o' })).toEqual({ ok: false, error: 'failed' });
  });
});
