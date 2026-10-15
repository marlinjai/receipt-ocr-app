import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createWorkspace, db, plainMealReceipt, type TestWorkspace } from '../../../../../test/db-helpers';

/**
 * POST /api/upload/check against a real database (`pnpm test:db`): the
 * duplicate stop for the company the upload names, and the warning about the
 * user's OTHER companies, which must never reveal a company the user is not in.
 */

type Member = { id: string; slug: string; name: string; role: string; tenantId: string; tenantName: string };
const principal = { current: null as null | { kind: 'user'; memberships: Member[]; activeWorkspace: Member | null } };

vi.mock('@/lib/prisma', async () => ({ prisma: (await import('../../../../../test/db-helpers')).db }));
vi.mock('@/lib/auth', () => ({ auth: { verifyRequest: vi.fn(async () => principal.current) } }));

import { POST } from './route';

let home: TestWorkspace;
let second: TestWorkspace;
let stranger: TestWorkspace;
const member = (w: TestWorkspace, company: string): Member => ({ id: w.workspaceId, slug: 'buecher', name: 'Bücher', role: 'member', tenantId: w.tenantId, tenantName: company });

async function attach(workspace: TestWorkspace, rowId: string, sha256: string, fileId: string) {
  const imageCol = (await workspace.adapter.getColumns(workspace.tableId)).find((c) => c.name === 'Receipt Image')!;
  await workspace.adapter.addFileReference({
    rowId, columnId: imageCol.id, fileId, fileUrl: `/api/files/${fileId}`, originalName: 'rechnung.pdf', mimeType: 'application/pdf',
    metadata: { source: 'ocr-upload', sha256 },
  });
}

function check(body: unknown) {
  return POST(new Request('http://localhost/api/upload/check', { method: 'POST', body: JSON.stringify(body) }) as never);
}

beforeAll(async () => {
  home = await createWorkspace();
  second = await createWorkspace();
  stranger = await createWorkspace();
  principal.current = { kind: 'user', memberships: [member(home, 'Firma Eins'), member(second, 'Firma Zwei')], activeWorkspace: member(second, 'Firma Zwei') };
});
afterAll(async () => {
  await db.$disconnect();
});

describe('POST /api/upload/check', () => {
  it('a file in another of the user\'s companies: no stop, a warning with that company\'s name and nothing else', async () => {
    const hash = '1a'.repeat(32);
    const row = await second.addReceipt(plainMealReceipt({ Name: 'Hosting Oktober' }));
    await attach(second, row, hash, '00000000-0000-4000-8000-0000000001a1');
    const res = await check({ sha256: hash, workspaceId: home.workspaceId });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ duplicate: null, elsewhere: ['Firma Zwei'] });
  });

  it('a file only a company the user is not in holds: neither a stop nor a warning', async () => {
    const hash = '2b'.repeat(32);
    const row = await stranger.addReceipt(plainMealReceipt());
    await attach(stranger, row, hash, '00000000-0000-4000-8000-0000000002b1');
    expect(await (await check({ sha256: hash, workspaceId: home.workspaceId })).json()).toEqual({ duplicate: null, elsewhere: [] });
  });

  it('the file in the named company itself: the stop, independent of which company is active', async () => {
    const hash = '3c'.repeat(32);
    const row = await home.addReceipt(plainMealReceipt({ Name: 'Hosting September' }));
    await attach(home, row, hash, '00000000-0000-4000-8000-0000000003c1');
    expect(await (await check({ sha256: hash, workspaceId: home.workspaceId })).json()).toEqual({
      duplicate: { rowId: row, name: 'Hosting September' },
      elsewhere: [],
    });
  });

  it('naming a company the user is not in, or none, is refused', async () => {
    const hash = '4d'.repeat(32);
    expect((await check({ sha256: hash, workspaceId: stranger.workspaceId })).status).toBe(403);
    expect((await check({ sha256: hash })).status).toBe(403);
    expect((await check({ sha256: 'kein-hash', workspaceId: home.workspaceId })).status).toBe(400);
  });
});
