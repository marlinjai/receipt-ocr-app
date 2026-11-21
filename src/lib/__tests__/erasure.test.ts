import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHmac } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import {
  ErasureEventMismatchError,
  ErasureLeaseLostError,
  eraseCompanyContacts,
  exportCoversRegister,
  purgeExpiredRetainedGuests,
  receiveErasureDelivery,
  retainUntilFrom,
  settleGuestCopies,
  type ErasureCounts,
  type ErasureLease,
  type ErasureLedger,
  type RegisterHasher,
} from '../erasure';

const companyContactsMock = vi.hoisted(() => vi.fn());
const contactsDbMock = vi.hoisted(() => vi.fn());
const migrateMock = vi.hoisted(() => vi.fn(async () => ({ applied: [], alreadyApplied: 0, unknown: [] })));
vi.mock('../contacts/db', () => ({
  companyContacts: companyContactsMock,
  contactsDb: contactsDbMock,
}));
vi.mock('@marlinjai/contacts-core', () => ({ migrate: migrateMock }));

const SECRET = 'test-secret-not-real';

function signed(body: string, secret = SECRET): string {
  return `sha256=${createHmac('sha256', secret).update(body, 'utf8').digest('hex')}`;
}

function delivery(payload: Record<string, unknown>) {
  return JSON.stringify({ event_id: 'evt_1', kind: 'tenant.erased', tenant_id: 'tnt_a', requested_at: '2026-10-09T00:00:00Z', ...payload });
}

const COUNTS: ErasureCounts = { guestCopies: 2, sharedContacts: 3 };

describe('receiveErasureDelivery (the decisions, before any data is touched)', () => {
  it('refuses with 503 and erases nothing when the secret is not configured', async () => {
    const erase = vi.fn();
    const body = delivery({});
    const res = await receiveErasureDelivery({ rawBody: body, signature: signed(body), secret: undefined, erase, log: () => {} });
    expect(res.status).toBe(503);
    expect(erase).not.toHaveBeenCalled();
  });

  it('refuses an unsigned or wrongly signed delivery with 401 and erases nothing', async () => {
    const erase = vi.fn();
    const body = delivery({});
    const unsigned = await receiveErasureDelivery({ rawBody: body, signature: null, secret: SECRET, erase, log: () => {} });
    const wrong = await receiveErasureDelivery({ rawBody: body, signature: signed(body, 'other'), secret: SECRET, erase, log: () => {} });
    expect(unsigned.status).toBe(401);
    expect(wrong.status).toBe(401);
    expect(erase).not.toHaveBeenCalled();
  });

  it('answers 400 for a signed body that is not JSON, and for a missing company', async () => {
    const erase = vi.fn();
    const notJson = 'not json';
    const noTenant = delivery({ tenant_id: undefined });
    const a = await receiveErasureDelivery({ rawBody: notJson, signature: signed(notJson), secret: SECRET, erase, log: () => {} });
    const b = await receiveErasureDelivery({ rawBody: noTenant, signature: signed(noTenant), secret: SECRET, erase, log: () => {} });
    expect(a.status).toBe(400);
    expect(b.status).toBe(400);
    expect(erase).not.toHaveBeenCalled();
  });

  it('a signed body that does not say what kind of event it is answers 400 and is never taken for an erasure', async () => {
    const erase = vi.fn();
    const body = delivery({ kind: undefined });
    const res = await receiveErasureDelivery({ rawBody: body, signature: signed(body), secret: SECRET, erase, log: () => {} });
    expect(res).toEqual({ status: 400, body: { error: 'Missing event kind' } });
    expect(erase).not.toHaveBeenCalled();
  });

  it('acknowledges another event kind without erasing, so it does not wedge auth-brain', async () => {
    const erase = vi.fn();
    const body = delivery({ kind: 'user.erased' });
    const res = await receiveErasureDelivery({ rawBody: body, signature: signed(body), secret: SECRET, erase, log: () => {} });
    expect(res).toEqual({ status: 200, body: { ok: true, ignored: 'user.erased' } });
    expect(erase).not.toHaveBeenCalled();
  });

  it('erases the named company and its workspaces, then reports counts only', async () => {
    const erase = vi.fn(async () => COUNTS);
    const lines: string[] = [];
    const body = delivery({ workspace_ids: ['ws_1', 'ws_2', 7] });
    const res = await receiveErasureDelivery({ rawBody: body, signature: signed(body), secret: SECRET, erase, log: (l) => lines.push(l) });
    expect(erase).toHaveBeenCalledWith('tnt_a', ['ws_1', 'ws_2'], expect.any(Function));
    expect(res).toEqual({ status: 200, body: { ok: true, erased: COUNTS, notErased: [] } });
    expect(lines.join('\n')).toContain('evt_1');
    expect(lines.join('\n')).not.toContain('tnt_a');
  });

  it('is repeat-safe: a second identical delivery is acknowledged again', async () => {
    const erase = vi.fn(async (): Promise<ErasureCounts> => ({ guestCopies: 0, sharedContacts: 0 }));
    const body = delivery({});
    const first = await receiveErasureDelivery({ rawBody: body, signature: signed(body), secret: SECRET, erase, log: () => {} });
    const second = await receiveErasureDelivery({ rawBody: body, signature: signed(body), secret: SECRET, erase, log: () => {} });
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
  });

  it('answers 502 when erasure fails part way, without leaking the error text', async () => {
    const erase = vi.fn(async () => {
      throw new Error('connection to 10.0.0.5 refused');
    });
    const lines: string[] = [];
    const body = delivery({});
    const res = await receiveErasureDelivery({ rawBody: body, signature: signed(body), secret: SECRET, erase, log: (l) => lines.push(l) });
    expect(res.status).toBe(502);
    expect(JSON.stringify(res.body)).not.toContain('10.0.0.5');
    expect(lines.join('\n')).not.toContain('10.0.0.5');
  });
});

describe('receiveErasureDelivery (the answer says what was not erased, and every run is recorded)', () => {
  function fakeLedger(over: Partial<ErasureLedger> = {}) {
    return {
      begin: vi.fn(async (e: { workspaceIds: readonly string[] }) => ({ workspaceIds: [...e.workspaceIds] })),
      acquire: vi.fn(async (): Promise<ErasureLease | null> => LEASE),
      busy: vi.fn(async () => {}),
      release: vi.fn(async () => {}),
      complete: vi.fn(async () => {}),
      fail: vi.fn(async () => {}),
      ...over,
    } satisfies ErasureLedger;
  }
  const LEASE: ErasureLease = { token: 'lease-1', renew: vi.fn(async () => {}) };
  const FULL: ErasureCounts = {
    ...COUNTS,
    register: { tables: 2, receipts: 9, storedFiles: 7, storedFilesAlreadyGone: 0, storedFilesKept: 1, records: { receipt_reviews: 6, tax_payments: 3 }, companyExports: 1 },
    notErased: [{ what: 'stored_files_shown_elsewhere', count: 4 }, { what: 'database_backups', daysOnServer: 7, days: 30 }],
  };

  it('answers 200 with what was removed and, apart from it, what was not', async () => {
    const lines: string[] = [];
    const body = delivery({});
    const res = await receiveErasureDelivery({ rawBody: body, signature: signed(body), secret: SECRET, erase: async () => FULL, log: (l) => lines.push(l) });
    expect(res.status).toBe(200);
    expect(res.body.notErased).toEqual(FULL.notErased);
    const line = lines.join('\n');
    expect(line).toContain('removed 2 receipts tables with 9 rows, 7 stored files (0 were gone already, 1 kept because a receipt elsewhere shows them), 9 other rows and 1 export records');
    expect(line).toContain('removed 2 guest copies, 3 contacts');
    expect(line).toContain('not erased: stored_files_shown_elsewhere 4, database_backups');
  });

  it('records the start and the completion, and erases over every workspace the ledger knows', async () => {
    const ledger = fakeLedger({ begin: vi.fn(async () => ({ workspaceIds: ['ws_1', 'ws_earlier'] })) });
    const erase = vi.fn(async () => FULL);
    const body = delivery({ workspace_ids: ['ws_1'] });
    const res = await receiveErasureDelivery({ rawBody: body, signature: signed(body), secret: SECRET, erase, ledger, log: () => {} });
    expect(res.status).toBe(200);
    expect(ledger.begin).toHaveBeenCalledWith({ eventId: 'evt_1', kind: 'tenant.erased', companyId: 'tnt_a', workspaceIds: ['ws_1'] });
    expect(erase).toHaveBeenCalledWith('tnt_a', ['ws_1', 'ws_earlier'], expect.any(Function));
    expect(ledger.acquire).toHaveBeenCalledWith('evt_1');
    expect(ledger.complete).toHaveBeenCalledWith('evt_1', FULL, LEASE);
    expect(ledger.fail).not.toHaveBeenCalled();
  });

  it('a delivery without an event id is recorded under the company', async () => {
    const ledger = fakeLedger();
    const body = delivery({ event_id: undefined });
    await receiveErasureDelivery({ rawBody: body, signature: signed(body), secret: SECRET, erase: async () => COUNTS, ledger, log: () => {} });
    expect(ledger.complete).toHaveBeenCalledWith('none:tnt_a', COUNTS, LEASE);
  });

  it('a ledger that cannot record the start answers 502 and nothing is erased', async () => {
    const ledger = fakeLedger({ begin: vi.fn(async () => { throw new Error('relation erasure_events does not exist'); }) });
    const erase = vi.fn(async () => COUNTS);
    const body = delivery({});
    const res = await receiveErasureDelivery({ rawBody: body, signature: signed(body), secret: SECRET, erase, ledger, log: () => {} });
    expect(res).toEqual({ status: 502, body: { error: 'Erasure failed; will retry', reason: 'ledger_unavailable' } });
    expect(erase).not.toHaveBeenCalled();
  });

  it('an event id recorded for another company answers 409 and nothing is erased', async () => {
    const ledger = fakeLedger({ begin: vi.fn(async () => { throw new ErasureEventMismatchError(); }) });
    const erase = vi.fn(async () => COUNTS);
    const body = delivery({});
    const res = await receiveErasureDelivery({ rawBody: body, signature: signed(body), secret: SECRET, erase, ledger, log: () => {} });
    expect(res).toEqual({ status: 409, body: { error: 'Erasure refused', reason: 'event_of_another_company' } });
    expect(erase).not.toHaveBeenCalled();
  });

  it('an erasure that could not be recorded as completed is not acknowledged', async () => {
    const ledger = fakeLedger({ complete: vi.fn(async () => { throw new Error('database gone'); }) });
    const body = delivery({});
    const res = await receiveErasureDelivery({ rawBody: body, signature: signed(body), secret: SECRET, erase: async () => COUNTS, ledger, log: () => {} });
    expect(res.status).toBe(502);
    // The record failed, but the lease is given back: other erasures need not wait for it to run out.
    expect(ledger.release).toHaveBeenCalledWith('evt_1', LEASE);
  });

  it.each([
    ['StoredFileEraseError', {}, 'stored_file_not_removed', undefined, 502],
    ['StoredFileEraseError', { partial: { sharedContacts: 3 } }, 'stored_file_not_removed', { partial: { sharedContacts: 3 } }, 502],
    ['ErasureConflictError', { kind: 'rows_of_another_company', tables: ['dt_tables'] }, 'rows_of_another_company', { tables: ['dt_tables'] }, 502],
    ['ErasureConflictError', { kind: 'rows_outside_named_workspaces', tables: ['tax_payments'], workspaces: ['ws_9'] }, 'rows_outside_named_workspaces', { tables: ['tax_payments'], workspaces: ['ws_9'] }, 502],
    ['ErasureChangedError', {}, 'changed_during_run', undefined, 502],
    ['ErasureTablesBusyError', {}, 'tables_busy', undefined, 502],
    ['ErasureIncompleteError', { remaining: { dt_files: 1 }, fileReferences: [{ referenceId: 'ref_1', fileId: 'file_1' }] }, 'rows_remain', { remaining: { dt_files: 1 }, fileReferences: [{ referenceId: 'ref_1', fileId: 'file_1' }] }, 502],
    ['ErasureIncompleteError', { remaining: { tax_payments: 2 } }, 'rows_remain', { remaining: { tax_payments: 2 } }, 502],
    ['ErasureLeaseLostError', { partial: { sharedContacts: 1 } }, 'lease_lost', { partial: { sharedContacts: 1 } }, 502],
    ['TypeError', {}, 'failed', undefined, 502],
  ])('a failed run (%s) answers non-2xx with its reason code and is recorded as failed', async (name, extra, reason, detail, status) => {
    const ledger = fakeLedger();
    const erase = vi.fn(async () => {
      throw Object.assign(new Error('the file named secret.pdf of Somebody'), { name, ...extra });
    });
    const lines: string[] = [];
    const body = delivery({});
    const res = await receiveErasureDelivery({ rawBody: body, signature: signed(body), secret: SECRET, erase, ledger, log: (l) => lines.push(l) });
    expect(res).toEqual({ status, body: { error: 'Erasure failed; will retry', reason } });
    expect(ledger.fail).toHaveBeenCalledWith('evt_1', reason, detail, LEASE);
    expect(ledger.complete).not.toHaveBeenCalled();
    expect(lines.join('\n')).not.toContain('Somebody');
  });

  it('another erasure at work: 409, nothing erased, noted as busy and neither failed nor completed', async () => {
    const ledger = fakeLedger({ acquire: vi.fn(async () => null) });
    const erase = vi.fn(async () => COUNTS);
    const body = delivery({});
    const res = await receiveErasureDelivery({ rawBody: body, signature: signed(body), secret: SECRET, erase, ledger, log: () => {} });
    expect(res).toEqual({ status: 409, body: { error: 'Erasure failed; will retry', reason: 'already_running' } });
    expect(erase).not.toHaveBeenCalled();
    expect(ledger.busy).toHaveBeenCalledWith('evt_1');
    expect(ledger.fail).not.toHaveBeenCalled();
    expect(ledger.complete).not.toHaveBeenCalled();
  });

  it('the checkpoint handed to the erasure renews the lease, and a lost lease stops the run', async () => {
    const renew = vi.fn(async () => {});
    const ledger = fakeLedger({ acquire: vi.fn(async () => ({ token: 't', renew })) });
    const body = delivery({});
    await receiveErasureDelivery({
      rawBody: body, signature: signed(body), secret: SECRET, ledger, log: () => {},
      erase: async (_t, _w, checkpoint) => {
        await checkpoint();
        await checkpoint();
        return COUNTS;
      },
    });
    expect(renew).toHaveBeenCalledTimes(2);

    renew.mockRejectedValue(new ErasureLeaseLostError());
    const res = await receiveErasureDelivery({
      rawBody: body, signature: signed(body), secret: SECRET, ledger, log: () => {},
      erase: async (_t, _w, checkpoint) => {
        await checkpoint();
        return COUNTS;
      },
    });
    expect(res).toEqual({ status: 502, body: { error: 'Erasure failed; will retry', reason: 'lease_lost' } });
  });

  it('a lease that cannot be taken at all answers 502 and nothing is erased', async () => {
    const ledger = fakeLedger({ acquire: vi.fn(async () => { throw new Error('database gone'); }) });
    const erase = vi.fn(async () => COUNTS);
    const body = delivery({});
    const res = await receiveErasureDelivery({ rawBody: body, signature: signed(body), secret: SECRET, erase, ledger, log: () => {} });
    expect(res).toEqual({ status: 502, body: { error: 'Erasure failed; will retry', reason: 'ledger_unavailable' } });
    expect(erase).not.toHaveBeenCalled();
  });

  it('a ledger that cannot record the failure does not turn the 502 into an exception', async () => {
    const ledger = fakeLedger({ fail: vi.fn(async () => { throw new Error('database gone'); }) });
    const body = delivery({});
    const res = await receiveErasureDelivery({ rawBody: body, signature: signed(body), secret: SECRET, erase: async () => { throw new Error('x'); }, ledger, log: () => {} });
    expect(res.status).toBe(502);
    expect(ledger.release).toHaveBeenCalledWith('evt_1', LEASE);
  });
});

describe('eraseCompanyContacts (a company erasure keeps no printed guest names)', () => {
  /** The company's contacts in the shared contacts database, the only contact store. */
  function sharedWith(ids: string[] = []) {
    return { list: vi.fn(async () => ids.map((id) => ({ id }))), eraseAll: vi.fn(async () => ids.length) };
  }
  beforeEach(() => {
    companyContactsMock.mockReset();
    companyContactsMock.mockReturnValue(sharedWith());
    contactsDbMock.mockReset();
    contactsDbMock.mockReturnValue({ sql: 'sql-handle' });
    migrateMock.mockClear();
  });

  function fakeDb(guests = 0) {
    return {
      companyExport: { findFirst: vi.fn() },
      mealGuest: {
        deleteMany: vi.fn(async () => ({ count: guests })),
        updateMany: vi.fn(async () => ({ count: 0 })),
      },
    } as unknown as PrismaClient & {
      companyExport: { findFirst: ReturnType<typeof vi.fn> };
      mealGuest: { deleteMany: ReturnType<typeof vi.fn>; updateMany: ReturnType<typeof vi.fn> };
    };
  }

  it('removes the company\'s printed copies outright: no export is looked at, nothing is held', async () => {
    const shared = sharedWith(['c1', 'c2']);
    companyContactsMock.mockReturnValue(shared);
    const db = fakeDb(3);
    const counts = await eraseCompanyContacts(db, 'tnt_a', ['ws_1']);
    expect(migrateMock).toHaveBeenCalledWith('sql-handle');
    expect(companyContactsMock).toHaveBeenCalledWith('tnt_a');
    expect(counts).toEqual({ guestCopies: 3, sharedContacts: 2, guestLinksCleared: 0 });
    // The company's own copies: its stamp, or no stamp in a named workspace. No condition on a date:
    // a copy an earlier erasure of one contact held goes with the company too.
    expect(db.mealGuest.deleteMany).toHaveBeenCalledWith({
      where: { OR: [{ authTenantId: 'tnt_a' }, { authWorkspaceId: { in: ['ws_1'] }, authTenantId: null }] },
    });
    // Whether the company ever exported is not asked: keeping its records is the company's duty.
    expect(db.companyExport.findFirst).not.toHaveBeenCalled();
    // A copy elsewhere that names one of the contacts only loses its link; no date is set on anything.
    expect(db.mealGuest.updateMany).toHaveBeenCalledTimes(1);
    expect(db.mealGuest.updateMany).toHaveBeenCalledWith({ where: { contactId: { in: ['c1', 'c2'] } }, data: { contactId: null } });
    expect(shared.eraseAll).toHaveBeenCalledTimes(1);
  });

  it('without workspace ids only the stamped copies are the company\'s', async () => {
    const db = fakeDb();
    await eraseCompanyContacts(db, 'tnt_a', []);
    expect(db.mealGuest.deleteMany).toHaveBeenCalledWith({ where: { OR: [{ authTenantId: 'tnt_a' }] } });
  });

  it('repeat-safe: a second run finds nothing', async () => {
    const db = fakeDb(0);
    expect(await eraseCompanyContacts(db, 'tnt_a', ['ws_1'])).toEqual({ guestCopies: 0, sharedContacts: 0, guestLinksCleared: 0 });
  });

  it('calls the checkpoint between its steps and stops where it rejects: before the copies go, nothing goes', async () => {
    const shared = sharedWith(['c1']);
    companyContactsMock.mockReturnValue(shared);
    const db = fakeDb();
    const checkpoint = vi.fn(async () => {
      throw new Error('lease gone');
    });
    await expect(eraseCompanyContacts(db, 'tnt_a', ['ws_1'], { checkpoint })).rejects.toThrow('lease gone');
    expect(db.mealGuest.updateMany).not.toHaveBeenCalled();
    expect(db.mealGuest.deleteMany).not.toHaveBeenCalled();
    expect(shared.eraseAll).not.toHaveBeenCalled();

    const through = vi.fn(async () => {});
    await eraseCompanyContacts(fakeDb(), 'tnt_a', ['ws_1'], { checkpoint: through });
    expect(through).toHaveBeenCalledTimes(2);
  });

  it('fails loudly when the shared contacts database is not configured, and touches nothing', async () => {
    contactsDbMock.mockImplementation(() => {
      throw new Error('CONTACTS_DATABASE_URL is not set: the shared contacts database is the only contact store');
    });
    const db = fakeDb();
    await expect(eraseCompanyContacts(db, 'tnt_a', ['ws_1'])).rejects.toThrow(/CONTACTS_DATABASE_URL/);
    expect(db.mealGuest.deleteMany).not.toHaveBeenCalled();
  });
});

describe('settleGuestCopies (the rule when ONE contact is erased and the company goes on)', () => {
  function fakeDb(count = 2) {
    return {
      mealGuest: { deleteMany: vi.fn(async () => ({ count })), updateMany: vi.fn(async () => ({ count })) },
    } as unknown as PrismaClient & { mealGuest: { deleteMany: ReturnType<typeof vi.fn>; updateMany: ReturnType<typeof vi.fn> } };
  }
  const now = new Date('2026-10-09T12:00:00Z');
  const scope = [{ contactId: 'c1' }];

  it('covered by an identical export: the copies are removed, but never one that is already held', async () => {
    const db = fakeDb();
    expect(await settleGuestCopies(db, scope, true, now)).toEqual({ removed: 2, held: 0 });
    expect(db.mealGuest.deleteMany).toHaveBeenCalledWith({ where: { OR: scope, retainUntil: null } });
    expect(db.mealGuest.updateMany).not.toHaveBeenCalled();
  });

  it('not covered: the copies are held, the link cleared and the date set ten years out; a copy without a contact or with a date is left alone', async () => {
    const db = fakeDb();
    expect(await settleGuestCopies(db, scope, false, now)).toEqual({ removed: 0, held: 2 });
    expect(db.mealGuest.deleteMany).not.toHaveBeenCalled();
    expect(db.mealGuest.updateMany).toHaveBeenCalledWith({
      where: { OR: scope, retainUntil: null, contactId: { not: null } },
      data: { contactId: null, retainUntil: new Date('2036-10-09T12:00:00Z') },
    });
  });

  it('an empty scope touches nothing', async () => {
    const db = fakeDb();
    expect(await settleGuestCopies(db, [], true, now)).toEqual({ removed: 0, held: 0 });
    expect(db.mealGuest.deleteMany).not.toHaveBeenCalled();
  });
});

describe('exportCoversRegister (does the company hold the register as it is now)', () => {
  const dbWith = (row: { registerSha256: string | null } | null) =>
    ({ companyExport: { findFirst: vi.fn(async () => row) } }) as unknown as PrismaClient;

  it('is covered only when the recomputed hash equals the newest export', async () => {
    expect(await exportCoversRegister(dbWith({ registerSha256: 'a' }), 't', ['w'], async () => 'a')).toEqual({ covered: true, reason: 'identical' });
    expect(await exportCoversRegister(dbWith({ registerSha256: 'a' }), 't', ['w'], async () => 'b')).toEqual({ covered: false, reason: 'changed' });
  });

  it('every other case is not covered, each with its own reason code', async () => {
    const never: RegisterHasher = async () => {
      throw new Error('boom');
    };
    expect(await exportCoversRegister(dbWith(null), 't', ['w'], async () => 'a')).toEqual({ covered: false, reason: 'no_export' });
    expect(await exportCoversRegister(dbWith({ registerSha256: null }), 't', ['w'], async () => 'a')).toEqual({ covered: false, reason: 'no_hash' });
    expect(await exportCoversRegister(dbWith({ registerSha256: 'a' }), 't', [], async () => 'a')).toEqual({ covered: false, reason: 'no_workspaces' });
    expect(await exportCoversRegister(dbWith({ registerSha256: 'a' }), 't', ['w'], never)).toEqual({ covered: false, reason: 'recompute_failed' });
  });
});

describe('retention', () => {
  it('sets the hold ten years out, on the calendar', () => {
    expect(retainUntilFrom(new Date('2026-02-28T08:00:00Z')).toISOString()).toBe('2036-02-28T08:00:00.000Z');
  });

  it('purges only held copies past their date, never a copy that still has a contact', async () => {
    const deleteMany = vi.fn(async () => ({ count: 4 }));
    const db = { mealGuest: { deleteMany } } as unknown as PrismaClient;
    const now = new Date('2036-10-10T00:00:00Z');
    expect(await purgeExpiredRetainedGuests(db, now)).toBe(4);
    expect(deleteMany).toHaveBeenCalledWith({ where: { contactId: null, retainUntil: { lt: now } } });
  });
});
