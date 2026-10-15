import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { jpegFile, pageRotations, pdfFile } from '@/lib/files/__tests__/fixtures';

/**
 * The file route: the access check runs first and unchanged, the bare address
 * streams the stored file as before, and `?ref=` shows the receipt turned by
 * the rotation stored on that file reference. Auth, the database and the file
 * store are replaced; the access check and the turning are the real code.
 */

vi.mock('next/server', () => {
  class NextResponse extends Response {
    static json(body: unknown, init?: ResponseInit) {
      return new NextResponse(JSON.stringify(body), { ...init, headers: { 'Content-Type': 'application/json' } });
    }
  }
  return { NextResponse, NextRequest: class {} };
});

const verifyRequest = vi.fn();
const findMany = vi.fn();
const findUnique = vi.fn();
const tableFindMany = vi.fn();
const resolveRowTableIds = vi.fn();

vi.mock('@/lib/auth', () => ({ auth: { verifyRequest: (...a: unknown[]) => verifyRequest(...a) } }));
vi.mock('@/lib/prisma', () => ({
  prisma: {
    dtFile: { findMany: (...a: unknown[]) => findMany(...a), findUnique: (...a: unknown[]) => findUnique(...a) },
    dtTable: { findMany: (...a: unknown[]) => tableFindMany(...a) },
  },
}));
vi.mock('@/lib/auth-guards', () => ({ resolveRowTableIds: (...a: unknown[]) => resolveRowTableIds(...a) }));

import { GET } from './route';

const FILE = '11111111-1111-4111-8111-111111111111';
const REF = '22222222-2222-4222-8222-222222222222';
const OTHER_FILE = '33333333-3333-4333-8333-333333333333';
const WS_A = { id: 'ws-a', slug: 'studio', name: 'Studio', tenantId: 't-a', role: 'member' };
const WS_B = { id: 'ws-b', slug: 'andere', name: 'Andere', tenantId: 't-b', role: 'member' };

const fetchMock = vi.fn();

function request(query = '', headers: Record<string, string> = {}) {
  return {
    url: `https://receipts.example.invalid/api/files/${FILE}${query}`,
    headers: new Headers(headers),
  } as never;
}
const call = (query = '', headers: Record<string, string> = {}, fileId = FILE) =>
  GET(request(query, headers), { params: Promise.resolve({ fileId }) }) as unknown as Promise<Response>;

function storedFile(bytes: Uint8Array, type: string) {
  fetchMock.mockResolvedValue(new Response(bytes as unknown as BodyInit, { status: 200, headers: { 'Content-Type': type } }));
}
function reference(rotation: unknown, overrides: Record<string, unknown> = {}) {
  findUnique.mockResolvedValue({ fileId: FILE, originalName: 'Kassenbon Bäckerei.pdf', mimeType: 'application/pdf', metadata: { rotation }, ...overrides });
}
const bytesOf = async (res: Response) => new Uint8Array(await res.arrayBuffer());

beforeEach(() => {
  vi.stubEnv('STORAGE_BRAIN_API_KEY', 'test-key');
  vi.stubGlobal('fetch', fetchMock);
  for (const m of [verifyRequest, findMany, findUnique, tableFindMany, resolveRowTableIds, fetchMock]) m.mockReset();
  // A member of workspace A; the file is referenced by a row of a table in workspace A.
  verifyRequest.mockResolvedValue({ kind: 'user', email: 'user@example.invalid', memberships: [WS_A], activeWorkspace: WS_A });
  findMany.mockResolvedValue([{ rowId: 'row-1' }]);
  resolveRowTableIds.mockResolvedValue(new Map([['row-1', 'table-1']]));
  tableFindMany.mockResolvedValue([{ workspaceId: 'ws-a' }]);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('GET /api/files/:id: access is checked first, exactly as before', () => {
  it('401 without a session, nothing is read', async () => {
    verifyRequest.mockResolvedValue({ kind: 'none', reason: 'no-credential' });
    for (const query of ['', `?ref=${REF}`, `?ref=${REF}&original=1`]) {
      const res = await call(query);
      expect(res.status).toBe(401);
    }
    expect(fetchMock).not.toHaveBeenCalled();
    expect(findUnique).not.toHaveBeenCalled();
  });

  it('404 for a file of another company, also with a reference of that file', async () => {
    tableFindMany.mockResolvedValue([{ workspaceId: 'ws-b' }]);
    reference(90);
    for (const query of ['', `?ref=${REF}`]) {
      const res = await call(query);
      expect(res.status).toBe(404);
    }
    expect(fetchMock).not.toHaveBeenCalled();
    expect(findUnique).not.toHaveBeenCalled();
  });

  it('400 for a file id that is no id', async () => {
    const res = await call(`?ref=${REF}`, {}, 'not-an-id');
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a member of several companies reaches a file of any of them', async () => {
    verifyRequest.mockResolvedValue({ kind: 'user', email: 'user@example.invalid', memberships: [WS_A, WS_B], activeWorkspace: WS_A });
    tableFindMany.mockResolvedValue([{ workspaceId: 'ws-b' }]);
    storedFile(await pdfFile([{ width: 300, height: 800 }]), 'application/pdf');
    expect((await call()).status).toBe(200);
  });
});

describe('GET /api/files/:id: the stored file', () => {
  it('without a query streams the stored file untouched, cached as before', async () => {
    const source = await pdfFile([{ width: 800, height: 300 }]);
    storedFile(source, 'application/pdf');
    const res = await call();
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('private, max-age=86400');
    expect(res.headers.get('Content-Disposition')).toBe('inline');
    expect(await bytesOf(res)).toEqual(source);
    expect(findUnique).not.toHaveBeenCalled();
  });

  it('`original=1` gives the stored file even with a reference', async () => {
    reference(90);
    const source = await pdfFile([{ width: 300, height: 800 }]);
    storedFile(source, 'application/pdf');
    const res = await call(`?ref=${REF}&original=1`);
    expect(await bytesOf(res)).toEqual(source);
    expect(findUnique).not.toHaveBeenCalled();
  });

  it('a file store error is passed on', async () => {
    fetchMock.mockResolvedValue(new Response('gone', { status: 404, statusText: 'Not Found' }));
    expect((await call()).status).toBe(404);
  });
});

describe('GET /api/files/:id?ref=: the receipt as the viewer shows it', () => {
  it.each([90, 180, 270])('a PDF stored at %i opens turned by that', async (rotation) => {
    reference(rotation);
    storedFile(await pdfFile([{ width: 300, height: 800 }, { width: 300, height: 800, ownRotation: 90 }]), 'application/pdf');
    const res = await call(`?ref=${REF}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('application/pdf');
    expect(await pageRotations(await bytesOf(res))).toEqual([rotation, (rotation + 90) % 360]);
  });

  it('a stored 0 serves the stored bytes', async () => {
    reference(0);
    const source = await pdfFile([{ width: 800, height: 300 }]);
    storedFile(source, 'application/pdf');
    expect(await bytesOf(await call(`?ref=${REF}`))).toEqual(source);
  });

  it('an image stored at 90 opens as a turned PDF named after it', async () => {
    reference(90, { originalName: 'Kassenbon Bäckerei.jpg', mimeType: 'image/jpeg' });
    storedFile(jpegFile(300, 800), 'image/jpeg');
    const res = await call(`?ref=${REF}`);
    expect(res.headers.get('Content-Type')).toBe('application/pdf');
    expect(res.headers.get('Content-Disposition')).toContain("filename*=UTF-8''Kassenbon%20B%C3%A4ckerei.pdf");
    expect(await pageRotations(await bytesOf(res))).toEqual([90]);
  });

  it('the store answering with a generic type still turns by the type the reference knows', async () => {
    reference(180);
    storedFile(await pdfFile([{ width: 300, height: 800 }]), 'application/octet-stream');
    expect(await pageRotations(await bytesOf(await call(`?ref=${REF}`)))).toEqual([180]);
  });

  it('is never kept stale: revalidated on every open, with a tag that changes with the rotation', async () => {
    reference(90);
    storedFile(await pdfFile([{ width: 300, height: 800 }]), 'application/pdf');
    const first = await call(`?ref=${REF}`);
    expect(first.headers.get('Cache-Control')).toBe('private, no-cache');
    const tag = first.headers.get('ETag')!;

    // Unchanged: 304 without loading the file again.
    fetchMock.mockClear();
    const again = await call(`?ref=${REF}`, { 'If-None-Match': tag });
    expect(again.status).toBe(304);
    expect(fetchMock).not.toHaveBeenCalled();

    // Turned in the meantime: a new tag, so the old copy is not used.
    reference(180);
    storedFile(await pdfFile([{ width: 300, height: 800 }]), 'application/pdf');
    const turned = await call(`?ref=${REF}`, { 'If-None-Match': tag });
    expect(turned.status).toBe(200);
    expect(turned.headers.get('ETag')).not.toBe(tag);
    expect(await pageRotations(await bytesOf(turned))).toEqual([180]);
  });

  it('a reference of another file is answered like an unknown one', async () => {
    reference(90, { fileId: OTHER_FILE });
    const res = await call(`?ref=${REF}`);
    expect(res.status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('an unknown reference is 404, a malformed one 400', async () => {
    findUnique.mockResolvedValue(null);
    expect((await call(`?ref=${REF}`)).status).toBe(404);
    expect((await call('?ref=nope')).status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a file that cannot be turned gets an error page offering the stored file, never the unturned file as if turned', async () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    reference(90);
    storedFile(new TextEncoder().encode('kein pdf'), 'application/pdf');
    const res = await call(`?ref=${REF}`);
    expect(res.status).toBe(500);
    expect(res.headers.get('Content-Type')).toBe('text/html; charset=utf-8');
    const html = await res.text();
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('<meta charset="utf-8">');
    expect(html).toContain(`href="/api/files/${FILE}"`);
    expect(quiet).toHaveBeenCalled();
    quiet.mockRestore();
  });

  it('a stored turn on a type that cannot be turned is reported, not dropped', async () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    reference(90, { mimeType: 'image/webp', originalName: 'foto.webp' });
    storedFile(new Uint8Array([1, 2, 3]), 'image/webp');
    expect((await call(`?ref=${REF}`)).status).toBe(500);
    quiet.mockRestore();
  });

  it('a file store error is passed on', async () => {
    reference(90);
    fetchMock.mockResolvedValue(new Response('down', { status: 502, statusText: 'Bad Gateway' }));
    expect((await call(`?ref=${REF}`)).status).toBe(502);
  });
});
