import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';
import { auth } from '@/lib/auth';

/**
 * End-to-end proof of the cookie-mode session path through the real
 * `@marlinjai/auth-brain-nextjs` wrapper and `@marlinjai/auth-brain-sdk`
 * client: `auth.verifyRequest` reads the shared `lumitra_session` cookie,
 * calls auth-brain's `GET /api/sessions/verify` (here a stubbed `fetch`),
 * applies the receipts app-grant door and resolves the active workspace from
 * the `receipts_ws` cookie. Only the network is faked; every line between the
 * request and the `AuthResult` is the installed package code.
 *
 * The session id below is shaped like the SHA-256 derived ids auth-brain
 * issues (not an RFC 4122 uuid: version nibble 0, variant c). The wrapper and
 * the SDK must pass it through untouched; nothing in this app validates it as
 * a uuid.
 */

const NON_RFC_SESSION_ID = '3f2a9c1e-7b4d-0e9a-c3f1-2d8e6a4b5c7f';
const ISO = '2026-11-08T00:00:00.000Z';

const TENANT_ID = '8b1f6a52-4c3d-4e8f-9a7b-1c2d3e4f5a6b';
const OTHER_TENANT_ID = '2e9d7c41-5b6a-4f3e-8d2c-0b1a9f8e7d6c';
const WS_BOOKS = 'c4d5e6f7-1a2b-4c3d-8e9f-0a1b2c3d4e5f';
const WS_OPS = 'd5e6f7a8-2b3c-4d4e-9f0a-1b2c3d4e5f60';
const WS_FOREIGN = 'e6f7a8b9-3c4d-4e5f-a01b-2c3d4e5f6071';

function tenant(id: string, slug: string, appGrants: string[]) {
  return {
    id,
    group_id: null,
    name: slug,
    slug,
    legal_name: null,
    vat_id: null,
    billing_address: null,
    stripe_customer_id: null,
    retention_hold: false,
    retention_expires_at: null,
    created_at: ISO,
    updated_at: ISO,
    deleted_at: null,
    role: 'owner',
    app_grants: appGrants,
  };
}

function workspace(id: string, tenantId: string, slug: string, role = 'member') {
  return { id, tenant_id: tenantId, name: slug, slug, created_at: ISO, updated_at: ISO, deleted_at: null, role };
}

function verifyPayload() {
  return {
    user: { id: '0f1e2d3c-4b5a-4968-8776-655443322110', email: 'owner@example.com', name: 'Owner', created_at: ISO },
    session: { id: NON_RFC_SESSION_ID, created_at: ISO, last_seen_at: ISO, expires_at: ISO, amr: [] },
    tenants: [tenant(TENANT_ID, 'books-co', ['receipts']), tenant(OTHER_TENANT_ID, 'other-co', ['studio'])],
    workspaces: [
      workspace(WS_BOOKS, TENANT_ID, 'books'),
      workspace(WS_OPS, TENANT_ID, 'ops', 'admin'),
      workspace(WS_FOREIGN, OTHER_TENANT_ID, 'foreign'),
    ],
    active_tenant: null,
    active_workspace: null,
    effective_roles: { tenant_groups: [], tenants: [], workspaces: [] },
  };
}

function request(cookies: Record<string, string>): NextRequest {
  return {
    headers: new Headers(),
    cookies: { get: (name: string) => (name in cookies ? { name, value: cookies[name] } : undefined) },
  } as unknown as NextRequest;
}

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  vi.stubEnv('NODE_ENV', 'test');
  vi.stubEnv('AUTH_BRAIN_URL', '');
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('auth.verifyRequest (cookie mode, real wrapper and SDK)', () => {
  it('verifies the session with auth-brain and opens only the granted company workspaces', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify(verifyPayload()), { status: 200 }));

    const result = await auth.verifyRequest(request({ lumitra_session: 'cookie-a', receipts_ws: WS_OPS }));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe('https://auth.lumitra.co/api/sessions/verify');
    expect(new Headers(init?.headers).get('cookie')).toBe('lumitra_session=cookie-a');

    expect(result.kind).toBe('user');
    if (result.kind !== 'user') return;
    expect(result.email).toBe('owner@example.com');
    expect(result.memberships.map((m) => m.id).sort()).toEqual([WS_BOOKS, WS_OPS].sort());
    expect(result.activeWorkspace?.id).toBe(WS_OPS);
    expect(result.companies.map((c) => c.slug)).toEqual(['books-co']);
  });

  it('is no-workspace-access when no company of the person holds the receipts grant', async () => {
    const payload = verifyPayload();
    payload.tenants = [tenant(OTHER_TENANT_ID, 'other-co', ['studio'])];
    payload.workspaces = [workspace(WS_FOREIGN, OTHER_TENANT_ID, 'foreign')];
    fetchMock.mockResolvedValue(new Response(JSON.stringify(payload), { status: 200 }));

    const result = await auth.verifyRequest(request({ lumitra_session: 'cookie-b' }));

    expect(result).toEqual({ kind: 'none', reason: 'no-workspace-access' });
  });

  it('is bad-session when auth-brain refuses the cookie (401)', async () => {
    fetchMock.mockResolvedValue(new Response('{}', { status: 401 }));

    const result = await auth.verifyRequest(request({ lumitra_session: 'cookie-c' }));

    expect(result).toEqual({ kind: 'none', reason: 'bad-session' });
  });

  it('is bad-session, not a crash, when auth-brain cannot be reached', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));

    const result = await auth.verifyRequest(request({ lumitra_session: 'cookie-d' }));

    expect(result).toEqual({ kind: 'none', reason: 'bad-session' });
  });

  it('is no-credential without a session cookie and never calls auth-brain', async () => {
    const result = await auth.verifyRequest(request({}));

    expect(result).toEqual({ kind: 'none', reason: 'no-credential' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
