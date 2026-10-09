import { describe, it, expect, vi, beforeEach } from 'vitest';
import { migrate, type ContactsDb } from '@marlinjai/contacts-core';
import { runContactsStartup } from '../startup';

vi.mock('@marlinjai/contacts-core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@marlinjai/contacts-core')>()),
  migrate: vi.fn(async () => ({ applied: [], alreadyApplied: 0, unknown: [] })),
}));

function handleWith(sql: unknown): ContactsDb {
  return { sql, db: {}, ready: vi.fn(), close: vi.fn() } as unknown as ContactsDb;
}

describe('runContactsStartup', () => {
  beforeEach(() => vi.mocked(migrate).mockClear());

  it('does nothing while the switch is off, and never touches the database', async () => {
    const sql = vi.fn();
    const outcome = await runContactsStartup({ enabled: false, handle: handleWith(sql) });
    expect(outcome).toBe('off');
    expect(sql).not.toHaveBeenCalled();
    expect(migrate).not.toHaveBeenCalled();
  });

  it('starts in degraded mode when the database cannot be reached, and says so without the message', async () => {
    const sql = vi.fn(async () => {
      throw Object.assign(new Error('connect ECONNREFUSED 10.0.0.5:5432'), { name: 'AggregateError' });
    });
    const lines: string[] = [];
    const outcome = await runContactsStartup({ enabled: true, handle: handleWith(sql), log: (l) => lines.push(l) });
    expect(outcome).toBe('unreachable');
    expect(migrate).not.toHaveBeenCalled();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('degraded mode');
    expect(lines[0]).not.toContain('10.0.0.5');
  });

  it('applies the layout when the database answers', async () => {
    const sql = vi.fn(async () => []);
    const outcome = await runContactsStartup({ enabled: true, handle: handleWith(sql), log: () => {} });
    expect(outcome).toBe('ready');
    expect(migrate).toHaveBeenCalledTimes(1);
  });

  it('stops the start when a migration fails, because serving an unknown layout is worse', async () => {
    const sql = vi.fn(async () => []);
    vi.mocked(migrate).mockRejectedValueOnce(new Error('checksum mismatch for 0001_contacts'));
    await expect(
      runContactsStartup({ enabled: true, handle: handleWith(sql), log: () => {} }),
    ).rejects.toThrow('checksum mismatch');
  });
});
