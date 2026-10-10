import { beforeEach, describe, expect, it, vi } from 'vitest';
import { REGULAR_BUSINESS, SMALL_BUSINESS, UNANSWERED, meal } from '@/lib/meals/__tests__/fixtures';

/**
 * The register route: who may call it, and that the workspace always comes
 * from the session. Auth and the database are replaced; the export itself
 * (register, CSV, PDF) is the real code.
 */

const verifyRequest = vi.fn();
const loadMealRecords = vi.fn();
const getTaxSettings = vi.fn();

vi.mock('@/lib/auth', () => ({ auth: { verifyRequest: (...a: unknown[]) => verifyRequest(...a) } }));
vi.mock('@/lib/prisma', () => ({ prisma: { marker: 'prisma' } }));
vi.mock('@/lib/meals/service', () => ({
  loadMealRecords: (...a: unknown[]) => loadMealRecords(...a),
  getTaxSettings: (...a: unknown[]) => getTaxSettings(...a),
}));

import { GET } from './route';

const WS_A = { id: 'ws-a', slug: 'beispiel-studio', name: 'Beispiel Studio', tenantId: 't-a', tenantName: 'Beispiel Studio', role: 'member' };
const WS_B = { id: 'ws-b', slug: 'andere-firma', name: 'Andere Firma', tenantId: 't-b', tenantName: 'Andere Firma', role: 'member' };

function request(query: string) {
  return { url: `https://receipts.example.invalid/api/meals/register?${query}` } as never;
}

function userIn(active: typeof WS_A) {
  return { kind: 'user', email: 'user@example.invalid', userId: 'u1', memberships: [WS_A, WS_B], activeWorkspace: active };
}

beforeEach(() => {
  verifyRequest.mockReset();
  loadMealRecords.mockReset();
  getTaxSettings.mockReset();
  loadMealRecords.mockResolvedValue([meal({ rowId: 'a' }), meal({ rowId: 'b', date: '2025-08-01', guests: [] })]);
  getTaxSettings.mockResolvedValue(SMALL_BUSINESS);
});

describe('GET /api/meals/register: access', () => {
  it('401 without a session', async () => {
    verifyRequest.mockResolvedValue({ kind: 'none', reason: 'no-credential' });
    const res = await GET(request('year=2025&format=csv'));
    expect(res.status).toBe(401);
    expect(loadMealRecords).not.toHaveBeenCalled();
  });

  it('403 for a service-token caller: there is no workspace to scope to', async () => {
    verifyRequest.mockResolvedValue({ kind: 'service' });
    const res = await GET(request('year=2025&format=csv'));
    expect(res.status).toBe(403);
    expect(loadMealRecords).not.toHaveBeenCalled();
  });
});

describe('GET /api/meals/register: workspace isolation', () => {
  it('reads the ACTIVE workspace of the session and nothing else', async () => {
    verifyRequest.mockResolvedValue(userIn(WS_A));
    await GET(request('year=2025&format=csv&ack=1'));
    expect(loadMealRecords).toHaveBeenCalledTimes(1);
    expect(loadMealRecords.mock.calls[0][1]).toBe('ws-a');
    expect(getTaxSettings.mock.calls[0][1]).toBe('ws-a');
  });

  it('ignores any workspace named in the query, even one the user is a member of', async () => {
    verifyRequest.mockResolvedValue(userIn(WS_A));
    await GET(request('year=2025&format=csv&ack=1&workspaceId=ws-b&workspace=ws-b&ws=ws-b&tenantId=t-b'));
    expect(loadMealRecords.mock.calls.every((c) => c[1] === 'ws-a')).toBe(true);
    expect(getTaxSettings.mock.calls.every((c) => c[1] === 'ws-a')).toBe(true);
  });

  it('follows the session when the active workspace changes', async () => {
    verifyRequest.mockResolvedValue(userIn(WS_B));
    await GET(request('year=2025&format=csv&ack=1'));
    expect(loadMealRecords.mock.calls[0][1]).toBe('ws-b');
  });
});

describe('GET /api/meals/register: refusals', () => {
  beforeEach(() => verifyRequest.mockResolvedValue(userIn(WS_A)));

  it('400 on a bad year or format', async () => {
    expect((await GET(request('year=25&format=csv'))).status).toBe(400);
    expect((await GET(request('year=2025&format=xlsx'))).status).toBe(400);
    expect((await GET(request('format=csv'))).status).toBe(400);
  });

  it('409 while the section 19 question is unanswered, for both formats', async () => {
    getTaxSettings.mockResolvedValue(UNANSWERED);
    for (const format of ['csv', 'pdf']) {
      const res = await GET(request(`year=2025&format=${format}&ack=1`));
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: 'setting_missing' });
    }
  });

  it('409 with the count while incomplete entries are not acknowledged, then exports once they are', async () => {
    const refused = await GET(request('year=2025&format=csv'));
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({ error: 'incomplete_unacknowledged', incompleteCount: 1 });
    // A stale acknowledgement (for another count) does not pass either.
    expect((await GET(request('year=2025&format=csv&ack=3'))).status).toBe(409);
    const ok = await GET(request('year=2025&format=csv&ack=1'));
    expect(ok.status).toBe(200);
  });

  it('500 with a plain error when loading fails, not a hang or a half file', async () => {
    loadMealRecords.mockRejectedValue(new Error('database down'));
    const res = await GET(request('year=2025&format=csv&ack=1'));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'export_failed' });
  });
});

describe('GET /api/meals/register: output', () => {
  beforeEach(() => verifyRequest.mockResolvedValue(userIn(WS_A)));

  it('CSV: attachment with a byte order mark, entries, totals and the incomplete block', async () => {
    const res = await GET(request('year=2025&format=csv&ack=1'));
    expect(res.headers.get('content-type')).toContain('text/csv');
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="bewirtungsverzeichnis-2025.csv"');
    expect(res.headers.get('cache-control')).toBe('no-store');
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const lines = new TextDecoder().decode(bytes).split('\r\n');
    expect(lines).toHaveLength(4);
    expect(lines[2]).toContain('Summe');
    expect(lines[3]).toContain('unvollständig');
  });

  it('an entry edited between two exports reads as edited in the second: every export loads the records again', async () => {
    // The second line of the file is entry number 1.
    const entry = async (res: Response) => new TextDecoder().decode(await res.arrayBuffer()).split('\r\n')[1];
    const first = await entry(await GET(request('year=2025&format=csv&ack=1')));
    expect(first).toContain('Abstimmung Relaunch Webshop, Angebot Phase 2');

    loadMealRecords.mockResolvedValue([
      meal({ rowId: 'a', occasion: 'Abnahme Fotoproduktion Herbst', tip: 21 }),
      meal({ rowId: 'b', date: '2025-08-01', guests: [] }),
    ]);
    const second = await entry(await GET(request('year=2025&format=csv&ack=1')));
    expect(second).toContain('Abnahme Fotoproduktion Herbst');
    expect(second).not.toContain('Abstimmung Relaunch Webshop');
    expect(second).toContain('21,00');
    expect(loadMealRecords).toHaveBeenCalledTimes(2);
  });

  it('PDF: a real document, with the warnings in a header', async () => {
    getTaxSettings.mockResolvedValue(REGULAR_BUSINESS);
    const res = await GET(request('year=2025&format=pdf&ack=1'));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/pdf');
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe('%PDF-');
    const warnings = JSON.parse(decodeURIComponent(res.headers.get('x-register-warnings')!));
    expect(warnings).toEqual(['Nr. 1: Es ist kein Beleg hinterlegt.']);
  });
});
