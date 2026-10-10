import { describe, it, expect, vi, beforeEach } from 'vitest';
import { migrate, type ContactsDb } from '@marlinjai/contacts-core';
import { runContactsStartup } from '../startup';
import { ContactsNotConfiguredError, contactsDb } from '../db';

vi.mock('@marlinjai/contacts-core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@marlinjai/contacts-core')>()),
  migrate: vi.fn(async () => ({ applied: [], alreadyApplied: 0, unknown: [] })),
}));

function handleWith(sql: unknown): ContactsDb {
  return { sql, db: {}, ready: vi.fn(), close: vi.fn() } as unknown as ContactsDb;
}

describe('runContactsStartup', () => {
  beforeEach(() => vi.mocked(migrate).mockClear());

  it('stops the start when the shared contacts database is not configured: there is no other store', async () => {
    vi.stubEnv('CONTACTS_DATABASE_URL', '');
    const cache = globalThis as unknown as { contactsDb?: ContactsDb };
    const saved = cache.contactsDb;
    delete cache.contactsDb;
    try {
      expect(() => contactsDb()).toThrow(ContactsNotConfiguredError);
      await expect(runContactsStartup({ log: () => {} })).rejects.toThrow('CONTACTS_DATABASE_URL is not set');
      expect(migrate).not.toHaveBeenCalled();
    } finally {
      cache.contactsDb = saved;
      vi.unstubAllEnvs();
    }
  });

  it('starts in degraded mode when the database cannot be reached, and says so without the message', async () => {
    const sql = vi.fn(async () => {
      throw Object.assign(new Error('connect ECONNREFUSED 10.0.0.5:5432'), { name: 'AggregateError' });
    });
    const lines: string[] = [];
    const outcome = await runContactsStartup({ handle: handleWith(sql), log: (l) => lines.push(l) });
    expect(outcome).toBe('unreachable');
    expect(migrate).not.toHaveBeenCalled();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('degraded mode');
    expect(lines[0]).not.toContain('10.0.0.5');
  });

  it('applies the layout when the database answers', async () => {
    const sql = vi.fn(async () => []);
    const outcome = await runContactsStartup({ handle: handleWith(sql), log: () => {} });
    expect(outcome).toBe('ready');
    expect(migrate).toHaveBeenCalledTimes(1);
  });

  it('stops the start when a migration fails, because serving an unknown layout is worse', async () => {
    const sql = vi.fn(async () => []);
    vi.mocked(migrate).mockRejectedValueOnce(new Error('checksum mismatch for 0001_contacts'));
    await expect(runContactsStartup({ handle: handleWith(sql), log: () => {} })).rejects.toThrow('checksum mismatch');
  });
});
