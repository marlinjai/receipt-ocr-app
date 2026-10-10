import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHmac } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import {
  eraseCompanyContacts,
  exportCoversRegister,
  purgeExpiredRetainedGuests,
  receiveErasureDelivery,
  retainUntilFrom,
  type ErasureCounts,
  type RegisterHasher,
} from '../erasure';

const companyContactsMock = vi.hoisted(() => vi.fn());
const migrateMock = vi.hoisted(() => vi.fn(async () => ({ applied: [], alreadyApplied: 0, unknown: [] })));
vi.mock('../contacts/db', () => ({
  companyContacts: companyContactsMock,
  contactsDb: () => ({ sql: 'sql-handle' }),
}));
vi.mock('@marlinjai/contacts-core', () => ({ migrate: migrateMock }));

const SECRET = 'test-secret-not-real';

function signed(body: string, secret = SECRET): string {
  return `sha256=${createHmac('sha256', secret).update(body, 'utf8').digest('hex')}`;
}

function delivery(payload: Record<string, unknown>) {
  return JSON.stringify({ event_id: 'evt_1', kind: 'tenant.erased', tenant_id: 'tnt_a', requested_at: '2026-10-09T00:00:00Z', ...payload });
}

const COUNTS: ErasureCounts = { guestCopies: 2, guestCopiesHeld: 0, ownContacts: 1, sharedContacts: 3, exportCoverage: 'identical' };

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
    expect(erase).toHaveBeenCalledWith('tnt_a', ['ws_1', 'ws_2']);
    expect(res).toEqual({ status: 200, body: { ok: true, erased: COUNTS } });
    expect(lines.join('\n')).toContain('evt_1');
    expect(lines.join('\n')).not.toContain('tnt_a');
  });

  it('is repeat-safe: a second identical delivery is acknowledged again', async () => {
    const erase = vi.fn(async (): Promise<ErasureCounts> => ({ guestCopies: 0, guestCopiesHeld: 0, ownContacts: 0, sharedContacts: 0, exportCoverage: 'no_export' }));
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

describe('eraseCompanyContacts (what is removed, company-scoped)', () => {
  let savedUrl: string | undefined;
  beforeEach(() => {
    savedUrl = process.env.CONTACTS_DATABASE_URL;
    delete process.env.CONTACTS_DATABASE_URL;
    companyContactsMock.mockReset();
    migrateMock.mockClear();
  });
  afterEach(() => {
    if (savedUrl === undefined) delete process.env.CONTACTS_DATABASE_URL;
    else process.env.CONTACTS_DATABASE_URL = savedUrl;
  });

  /** `exportHash`: undefined = no export on record, null = an export from before the hash existed. */
  function fakeDb(opts: { exportHash?: string | null; guestsLinked?: number; own?: number } = {}) {
    return {
      companyExport: {
        findFirst: vi.fn(async () => (opts.exportHash === undefined ? null : { registerSha256: opts.exportHash })),
      },
      mealGuest: {
        deleteMany: vi.fn(async () => ({ count: opts.guestsLinked ?? 0 })),
        updateMany: vi.fn(async () => ({ count: opts.guestsLinked ?? 0 })),
      },
      contact: { deleteMany: vi.fn(async () => ({ count: opts.own ?? 0 })) },
    } as unknown as PrismaClient & {
      companyExport: { findFirst: ReturnType<typeof vi.fn> };
      mealGuest: { deleteMany: ReturnType<typeof vi.fn>; updateMany: ReturnType<typeof vi.fn> };
      contact: { deleteMany: ReturnType<typeof vi.fn> };
    };
  }
  const now = new Date('2026-10-09T12:00:00Z');
  const registerIs = (hash: string): RegisterHasher => vi.fn(async () => hash);

  it('without an export, holds the printed copies: the contact link is cleared and a retention date is set', async () => {
    const db = fakeDb({ guestsLinked: 2, own: 1 });
    const counts = await eraseCompanyContacts(db, 'tnt_a', ['ws_1'], now, registerIs('h1'));
    expect(counts).toEqual({ guestCopies: 0, guestCopiesHeld: 2, ownContacts: 1, sharedContacts: 0, exportCoverage: 'no_export' });
    expect(db.mealGuest.deleteMany).not.toHaveBeenCalled();
    const call = db.mealGuest.updateMany.mock.calls[0][0] as { where: Record<string, unknown>; data: Record<string, unknown> };
    expect(call.where).toMatchObject({ contactId: { not: null } });
    expect(call.data).toEqual({ contactId: null, retainUntil: new Date('2036-10-09T12:00:00Z') });
  });

  it('export, then no change: the register equals the export, so the printed copies are removed', async () => {
    const db = fakeDb({ exportHash: 'h1', guestsLinked: 3 });
    const hasher = registerIs('h1');
    const counts = await eraseCompanyContacts(db, 'tnt_a', ['ws_1'], now, hasher);
    expect(counts).toMatchObject({ guestCopies: 3, guestCopiesHeld: 0, exportCoverage: 'identical' });
    expect(db.mealGuest.updateMany).not.toHaveBeenCalled();
    expect(hasher).toHaveBeenCalledWith(db, ['ws_1']);
    // The NEWEST export is the one compared.
    expect(db.companyExport.findFirst).toHaveBeenCalledWith({
      where: { authTenantId: 'tnt_a' },
      orderBy: { createdAt: 'desc' },
      select: { registerSha256: true },
    });
  });

  it('export, then a change (a correction or a new guest): the register differs, so the printed copies are held', async () => {
    const db = fakeDb({ exportHash: 'h1', guestsLinked: 3 });
    const counts = await eraseCompanyContacts(db, 'tnt_a', ['ws_1'], now, registerIs('h2'));
    expect(counts).toMatchObject({ guestCopies: 0, guestCopiesHeld: 3, exportCoverage: 'changed' });
    expect(db.mealGuest.deleteMany).not.toHaveBeenCalled();
  });

  it('an export from before the hash existed never counts: held', async () => {
    const db = fakeDb({ exportHash: null, guestsLinked: 1 });
    const hasher = registerIs('h1');
    const counts = await eraseCompanyContacts(db, 'tnt_a', ['ws_1'], now, hasher);
    expect(counts).toMatchObject({ guestCopies: 0, guestCopiesHeld: 1, exportCoverage: 'no_hash' });
    expect(hasher).not.toHaveBeenCalled();
  });

  it('when the register cannot be recomputed, holds (the safe direction) and does not fail the erasure', async () => {
    const db = fakeDb({ exportHash: 'h1', guestsLinked: 2, own: 1 });
    const failing: RegisterHasher = vi.fn(async () => {
      throw new Error('data layer unreachable');
    });
    const counts = await eraseCompanyContacts(db, 'tnt_a', ['ws_1'], now, failing);
    expect(counts).toMatchObject({ guestCopies: 0, guestCopiesHeld: 2, ownContacts: 1, exportCoverage: 'recompute_failed' });
    expect(db.mealGuest.deleteMany).not.toHaveBeenCalled();
  });

  it('without workspace ids there is nothing to compare the export with: held', async () => {
    const db = fakeDb({ exportHash: 'h1', guestsLinked: 2 });
    const hasher = registerIs('h1');
    const counts = await eraseCompanyContacts(db, 'tnt_a', [], now, hasher);
    expect(counts).toMatchObject({ guestCopies: 0, guestCopiesHeld: 2, exportCoverage: 'no_workspaces' });
    expect(hasher).not.toHaveBeenCalled();
  });

  it('repeat-safe: a second run after a hold finds no linked copy and holds nothing more', async () => {
    const first = await eraseCompanyContacts(fakeDb({ guestsLinked: 2 }), 'tnt_a', ['ws_1'], now, registerIs('h1'));
    const second = await eraseCompanyContacts(fakeDb({ guestsLinked: 0 }), 'tnt_a', ['ws_1'], now, registerIs('h1'));
    expect(first.guestCopiesHeld).toBe(2);
    expect(second).toMatchObject({ guestCopies: 0, guestCopiesHeld: 0 });
  });

  it('removes the company contacts by company and workspace', async () => {
    const db = fakeDb({ exportHash: 'h1', own: 1 });
    await eraseCompanyContacts(db, 'tnt_a', ['ws_1'], now, registerIs('h1'));
    expect(db.contact.deleteMany).toHaveBeenCalledWith({
      where: { OR: [{ authTenantId: 'tnt_a' }, { authWorkspaceId: { in: ['ws_1'] } }] },
    });
  });

  it('with a shared database, also removes the company contacts and their printed copies by contact id', async () => {
    process.env.CONTACTS_DATABASE_URL = 'postgresql://example.invalid/contacts';
    const shared = { list: vi.fn(async () => [{ id: 'c1' }, { id: 'c2' }]), eraseAll: vi.fn(async () => 2) };
    companyContactsMock.mockReturnValue(shared);
    const db = fakeDb({ exportHash: 'h1' });
    const counts = await eraseCompanyContacts(db, 'tnt_a', ['ws_1'], now, registerIs('h1'));
    expect(migrateMock).toHaveBeenCalledWith('sql-handle');
    expect(counts.sharedContacts).toBe(2);
    expect(db.mealGuest.deleteMany).toHaveBeenCalledWith({
      where: { OR: [{ authTenantId: 'tnt_a' }, { authWorkspaceId: { in: ['ws_1'] } }, { contactId: { in: ['c1', 'c2'] } }] },
    });
    expect(shared.eraseAll).toHaveBeenCalledTimes(1);
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
