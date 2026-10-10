import { describe, it, expect, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { strFromU8, unzipSync, strToU8 } from 'fflate';
import { buildExportArchive, buildReadme, guestCopiesCsv, registerHash, sha256Hex } from '../company-export';
import type { MealRecord } from '../meals/types';
import { receiveRetentionPurge } from '../retention-purge';

vi.mock('server-only', () => ({}));

describe('export archive', () => {
  it('round-trips every file, unchanged, and keeps the folder layout', () => {
    const files = [
      { path: 'register/ws_1/2025.csv', data: strToU8('date,place\n2025-02-09,Test\n') },
      { path: 'contacts/contacts.json', data: strToU8('[]') },
      { path: 'README.txt', data: strToU8('readme') },
    ];
    const zip = buildExportArchive(files);
    const back = unzipSync(zip);
    expect(Object.keys(back).sort()).toEqual(files.map((f) => f.path).sort());
    expect(strFromU8(back['register/ws_1/2025.csv'])).toBe('date,place\n2025-02-09,Test\n');
  });

  it('computes a stable SHA-256 of the archive bytes', () => {
    const zip = buildExportArchive([{ path: 'a.txt', data: strToU8('x') }]);
    expect(sha256Hex(zip)).toMatch(/^[0-9a-f]{64}$/);
    expect(sha256Hex(zip)).toBe(sha256Hex(zip));
  });

  it('the readme states the counts and the retention duty, and carries no names', () => {
    const text = buildReadme(new Date('2026-10-09T10:00:00Z'), { registerFiles: 2, contacts: 4, legacy: 0 });
    expect(text).toContain('2 files');
    expect(text).toContain('4 contacts');
    expect(text).toContain('ten years');
    expect(text).toContain('2026-10-09T10:00:00.000Z');
  });
});

describe('register hash (what an export is compared by)', () => {
  const file = (path: string, text: string) => ({ path, data: strToU8(text) });
  const register = [file('register/ws_1/2025.csv', 'a'), file('register/ws_1/guests.csv', 'b')];

  it('is the same for the same register, whatever the order and whatever else is in the export', () => {
    const withRest = [file('README.txt', 'created 2026-10-09'), ...[...register].reverse(), file('contacts/contacts.json', '[]')];
    const later = [file('README.txt', 'created 2027-01-01'), ...register, file('contacts/contacts.json', '[{"id":"x"}]')];
    expect(registerHash(withRest)).toBe(registerHash(register));
    expect(registerHash(later)).toBe(registerHash(register));
    expect(registerHash(register)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('changes when a register file changes, is added, is removed or is renamed', () => {
    const base = registerHash(register);
    expect(registerHash([file('register/ws_1/2025.csv', 'a!'), register[1]])).not.toBe(base);
    expect(registerHash([...register, file('register/ws_1/2026.csv', 'c')])).not.toBe(base);
    expect(registerHash([register[0]])).not.toBe(base);
    expect(registerHash([file('register/ws_2/2025.csv', 'a'), register[1]])).not.toBe(base);
  });

  it('cannot be confused by moving text between a path and its content', () => {
    expect(registerHash([file('register/a', 'bc')])).not.toBe(registerHash([file('register/ab', 'c')]));
  });
});

describe('list of all printed guest names', () => {
  const record = (rowId: string, guests: Array<{ name: string; company: string }>, date: string | null = '2025-03-14') =>
    ({ rowId, date, guests: guests.map((g) => ({ contactId: null, ...g })) }) as unknown as MealRecord;

  it('lists every guest of every meal, also of meals without a date, in a stable order', () => {
    const csv = guestCopiesCsv([
      record('row-b', [{ name: 'Zweite Person', company: '' }], null),
      record('row-a', [{ name: 'Erste Person', company: 'Beispiel GmbH' }, { name: 'Dritte Person', company: '' }]),
    ]);
    expect(csv).toBe(
      'meal_row_id;date;position;name;company\n' +
        'row-a;2025-03-14;1;Erste Person;Beispiel GmbH\n' +
        'row-a;2025-03-14;2;Dritte Person;\n' +
        'row-b;;1;Zweite Person;\n',
    );
  });

  it('is absent when no meal has a guest, and escapes text a spreadsheet would run as a formula', () => {
    expect(guestCopiesCsv([record('row-a', [])])).toBeNull();
    expect(guestCopiesCsv([record('row-a', [{ name: '=SUM(A1)', company: 'A; B' }])])).toContain("'=SUM(A1);\"A; B\"");
  });
});

describe('retention purge call', () => {
  const SECRET = 'test-secret-not-real';
  const sign = (body: string) => `sha256=${createHmac('sha256', SECRET).update(body, 'utf8').digest('hex')}`;

  it('refuses with 503 and purges nothing when the secret is not configured', async () => {
    const purge = vi.fn(async () => 0);
    const res = await receiveRetentionPurge({ rawBody: '', signature: sign(''), secret: undefined, purge, log: () => {} });
    expect(res.status).toBe(503);
    expect(purge).not.toHaveBeenCalled();
  });

  it('refuses an unsigned call with 401 and purges nothing', async () => {
    const purge = vi.fn(async () => 0);
    const res = await receiveRetentionPurge({ rawBody: '', signature: null, secret: SECRET, purge, log: () => {} });
    expect(res.status).toBe(401);
    expect(purge).not.toHaveBeenCalled();
  });

  it('purges on a signed call and reports the count only', async () => {
    const purge = vi.fn(async () => 3);
    const lines: string[] = [];
    const res = await receiveRetentionPurge({ rawBody: '', signature: sign(''), secret: SECRET, purge, log: (l) => lines.push(l) });
    expect(res).toEqual({ status: 200, body: { ok: true, removed: 3 } });
    expect(lines.join('\n')).toContain('3');
  });

  it('answers 502 without leaking the error text when the purge fails', async () => {
    const purge = vi.fn(async () => {
      throw new Error('connection to 10.0.0.5 refused');
    });
    const res = await receiveRetentionPurge({ rawBody: '', signature: sign(''), secret: SECRET, purge, log: () => {} });
    expect(res.status).toBe(502);
    expect(JSON.stringify(res.body)).not.toContain('10.0.0.5');
  });
});
