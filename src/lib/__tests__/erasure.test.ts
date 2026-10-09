import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHmac } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { eraseCompanyContacts, receiveErasureDelivery, type ErasureCounts } from '../erasure';

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

const COUNTS: ErasureCounts = { guestCopies: 2, ownContacts: 1, sharedContacts: 3 };

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
    const erase = vi.fn(async () => ({ guestCopies: 0, ownContacts: 0, sharedContacts: 0 }));
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
    companyContactsMock.mockReset();
    migrateMock.mockClear();
  });
  afterEach(() => {
    if (savedUrl === undefined) delete process.env.CONTACTS_DATABASE_URL;
    else process.env.CONTACTS_DATABASE_URL = savedUrl;
  });

  function fakeDb(counts = { guest: 2, own: 1 }) {
    return {
      mealGuest: { deleteMany: vi.fn(async () => ({ count: counts.guest })) },
      contact: { deleteMany: vi.fn(async () => ({ count: counts.own })) },
    } as unknown as PrismaClient & {
      mealGuest: { deleteMany: ReturnType<typeof vi.fn> };
      contact: { deleteMany: ReturnType<typeof vi.fn> };
    };
  }

  it('without a shared database, removes by company and workspace only', async () => {
    delete process.env.CONTACTS_DATABASE_URL;
    const db = fakeDb();
    const counts = await eraseCompanyContacts(db, 'tnt_a', ['ws_1']);
    expect(counts).toEqual({ guestCopies: 2, ownContacts: 1, sharedContacts: 0 });
    expect(companyContactsMock).not.toHaveBeenCalled();
    expect(migrateMock).not.toHaveBeenCalled();
    expect(db.mealGuest.deleteMany).toHaveBeenCalledWith({
      where: { OR: [{ authTenantId: 'tnt_a' }, { authWorkspaceId: { in: ['ws_1'] } }] },
    });
  });

  it('with a shared database, also removes the company contacts and their printed copies by contact id', async () => {
    process.env.CONTACTS_DATABASE_URL = 'postgresql://example.invalid/contacts';
    const shared = {
      list: vi.fn(async () => [{ id: 'c1' }, { id: 'c2' }]),
      eraseAll: vi.fn(async () => 2),
    };
    companyContactsMock.mockReturnValue(shared);
    const db = fakeDb();
    const counts = await eraseCompanyContacts(db, 'tnt_a', []);
    expect(migrateMock).toHaveBeenCalledWith('sql-handle');
    expect(companyContactsMock).toHaveBeenCalledWith('tnt_a');
    expect(counts.sharedContacts).toBe(2);
    expect(db.mealGuest.deleteMany).toHaveBeenCalledWith({
      where: { OR: [{ authTenantId: 'tnt_a' }, { contactId: { in: ['c1', 'c2'] } }] },
    });
    expect(shared.eraseAll).toHaveBeenCalledTimes(1);
  });

  it('is repeat-safe: a second run finds nothing and removes nothing more', async () => {
    delete process.env.CONTACTS_DATABASE_URL;
    const first = await eraseCompanyContacts(fakeDb({ guest: 2, own: 1 }), 'tnt_a', []);
    const second = await eraseCompanyContacts(fakeDb({ guest: 0, own: 0 }), 'tnt_a', []);
    expect(first.guestCopies + first.ownContacts).toBe(3);
    expect(second).toEqual({ guestCopies: 0, ownContacts: 0, sharedContacts: 0 });
  });
});
