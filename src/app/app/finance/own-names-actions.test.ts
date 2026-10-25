import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The own names under Finanzen, Einstellungen: read with the write permission
 * failing closed, changed only with it, for the active company, answered with
 * the fresh statement, and a refused name returned with its code. Auth,
 * database and the statement are replaced; the service is a spy (its
 * behaviour against a real database is in the spending tests).
 */

const requireAction = vi.fn();
const requireReceiptsSession = vi.fn();
const loadOwnNames = vi.fn();
const saveOwnNames = vi.fn();
const settleAfterOwnNames = vi.fn();
const getStatement = vi.fn();

vi.mock('@/lib/auth', () => ({ auth: { requireAction: (...a: unknown[]) => requireAction(...a) } }));
vi.mock('@/lib/auth-guards', () => {
  class ReceiptsAuthError extends Error {
    constructor(readonly status: number) {
      super('auth');
    }
  }
  return { ReceiptsAuthError, requireReceiptsSession: (...a: unknown[]) => requireReceiptsSession(...a) };
});
vi.mock('@/lib/prisma', () => ({ prisma: { marker: 'prisma' } }));
vi.mock('@/lib/spending/loop-service', () => ({ settleAfterOwnNames: (...a: unknown[]) => settleAfterOwnNames(...a) }));
vi.mock('@/lib/spending/service', () => {
  class SpendingServiceError extends Error {
    constructor(readonly code: string) {
      super(code);
    }
  }
  return {
    SpendingServiceError,
    loadOwnNames: (...a: unknown[]) => loadOwnNames(...a),
    saveOwnNames: (...a: unknown[]) => saveOwnNames(...a),
  };
});
vi.mock('./actions', () => ({ getStatement: (...a: unknown[]) => getStatement(...a) }));

import { ReceiptsAuthError } from '@/lib/auth-guards';
import { SpendingServiceError } from '@/lib/spending/service';
import { changeOwnNames, getOwnNamesView } from './own-names-actions';

const A = { id: 'ws-a', slug: 'firma', role: 'member', tenantId: 't-a', tenantName: 'Firma' };
const SESSION = { userId: 'user-1', memberships: [A], activeWorkspace: A };
const STATEMENT = { year: 2026, marker: 'statement' };

beforeEach(() => {
  for (const f of [requireAction, requireReceiptsSession, loadOwnNames, saveOwnNames, settleAfterOwnNames, getStatement]) f.mockReset();
  requireReceiptsSession.mockResolvedValue(SESSION);
  requireAction.mockResolvedValue(SESSION);
  loadOwnNames.mockResolvedValue(['Erika Beispiel']);
  saveOwnNames.mockResolvedValue(['Erika Beispiel', 'Beispiel, Erika']);
  settleAfterOwnNames.mockResolvedValue(2);
  getStatement.mockResolvedValue({ ok: true, value: STATEMENT });
});

describe('getOwnNamesView', () => {
  it('reads the names of the active company and whether the person may change them', async () => {
    expect(await getOwnNamesView()).toEqual({ ok: true, value: { names: ['Erika Beispiel'], canWrite: true } });
    expect(loadOwnNames).toHaveBeenCalledWith({ marker: 'prisma' }, 'ws-a');
  });

  it('a denied or unreachable permission check shows the list read-only', async () => {
    requireAction.mockRejectedValue(new Error('unreachable'));
    expect(await getOwnNamesView()).toEqual({ ok: true, value: { names: ['Erika Beispiel'], canWrite: false } });
  });

  it('without a session it is refused, not empty', async () => {
    requireReceiptsSession.mockRejectedValue(new ReceiptsAuthError(401));
    expect(await getOwnNamesView()).toEqual({ ok: false, error: 'unauthorized' });
  });
});

describe('changeOwnNames', () => {
  it('saves for the active company, settles the messages and answers with the fresh statement', async () => {
    const result = await changeOwnNames(2026, { add: 'Beispiel, Erika' });
    expect(saveOwnNames).toHaveBeenCalledWith({ marker: 'prisma' }, { workspaceId: 'ws-a', tenantId: 't-a' }, { add: 'Beispiel, Erika' });
    expect(settleAfterOwnNames).toHaveBeenCalledWith({ marker: 'prisma' }, 'ws-a');
    expect(getStatement).toHaveBeenCalledWith(2026);
    expect(result).toEqual({ ok: true, value: { names: ['Erika Beispiel', 'Beispiel, Erika'], settledOwnName: 2, view: STATEMENT } });
  });

  it('without the write permission nothing is saved', async () => {
    requireAction.mockRejectedValue(Object.assign(new Error('forbidden'), { status: 403 }));
    expect(await changeOwnNames(2026, { add: 'X Y' })).toEqual({ ok: false, error: 'forbidden' });
    expect(saveOwnNames).not.toHaveBeenCalled();
  });

  it('a refused name comes back with its code', async () => {
    saveOwnNames.mockRejectedValue(new SpendingServiceError('name_listed'));
    expect(await changeOwnNames(2026, { add: 'Erika Beispiel' })).toEqual({ ok: false, error: 'invalid_input', detail: 'name_listed' });
    expect(getStatement).not.toHaveBeenCalled();
  });

  it('a failed settling keeps the change, and a statement that cannot be read afterwards is null, not a failure', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    settleAfterOwnNames.mockRejectedValue(new Error('db'));
    getStatement.mockResolvedValue({ ok: false, error: 'failed' });
    expect(await changeOwnNames(2026, { remove: 'Erika Beispiel' })).toEqual({
      ok: true,
      value: { names: ['Erika Beispiel', 'Beispiel, Erika'], settledOwnName: 0, view: null },
    });
  });
});
