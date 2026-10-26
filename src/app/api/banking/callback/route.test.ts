import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Where the bank sends the person back: a session that ran out at the bank
 * leads to the login and from there back here, with the bank's answer
 * untouched; a signed-in person's answer is taken. Auth, the database and the
 * bank service are replaced. Every value is invented.
 */

const requireAction = vi.fn();
const completeConsent = vi.fn();

// The Next runtime is not loaded in unit tests; a redirect is a 303 with a location, as in Next.
vi.mock('next/server', () => ({
  NextResponse: { redirect: (url: URL | string, status = 307) => new Response(null, { status, headers: { location: String(url) } }) },
}));
vi.mock('@/lib/auth', () => ({
  auth: {
    requireAction: (...a: unknown[]) => requireAction(...a),
    loginUrl: (returnTo: string) => `https://auth.example.test/login?return_to=${encodeURIComponent(returnTo)}`,
    appUrl: () => 'https://receipts.example.test',
  },
}));
vi.mock('@/lib/auth-workspace', () => ({ sessionWorkspaceId: (s: { activeWorkspace: { id: string } }) => s.activeWorkspace.id }));
vi.mock('@/lib/prisma', () => ({ prisma: { marker: 'prisma' } }));
let deps: { redirectUrl: string } | null = { redirectUrl: 'https://receipts.example.test/api/banking/callback' };
vi.mock('@/lib/tax/payments/bank/server', () => ({ serverBankDeps: () => deps }));
vi.mock('@/lib/tax/payments/bank/service', () => ({
  completeConsent: (...a: unknown[]) => completeConsent(...a),
  BankServiceError: class BankServiceError extends Error {
    code = 'state_invalid';
    detail: string | null = null;
  },
}));

import { GET } from './route';

const request = (query: string) => {
  const url = new URL(`http://container.internal:3000/api/banking/callback?${query}`);
  return { nextUrl: url } as never;
};

beforeEach(() => {
  deps = { redirectUrl: 'https://receipts.example.test/api/banking/callback' };
  requireAction.mockReset();
  completeConsent.mockReset();
});

describe('GET /api/banking/callback', () => {
  it('signed out on the way back: to the login, and from there back here with code and state, nothing taken', async () => {
    requireAction.mockRejectedValue(Object.assign(new Error('unauthorized'), { status: 401 }));
    const res = await GET(request('code=c-1&state=s-1'));
    expect(res.status).toBe(303);
    const login = new URL(res.headers.get('location') as string);
    expect(login.origin).toBe('https://auth.example.test');
    // The public address, never the container's.
    expect(login.searchParams.get('return_to')).toBe('https://receipts.example.test/api/banking/callback?code=c-1&state=s-1');
    expect(completeConsent).not.toHaveBeenCalled();
  });

  it('signed in: the answer is taken for the active company and the payments tab shows the outcome', async () => {
    requireAction.mockResolvedValue({ activeWorkspace: { id: 'ws-a' } });
    completeConsent.mockResolvedValue({ outcome: 'connected', connectionId: 'con-1' });
    const res = await GET(request('code=c-1&state=s-1'));
    expect(completeConsent).toHaveBeenCalledWith({ marker: 'prisma' }, 'ws-a', expect.anything(), { state: 's-1', code: 'c-1', error: null });
    expect(res.headers.get('location')).toBe('https://receipts.example.test/app/finance?reiter=konten&bank=verbunden');
  });

  it('without write permission the answer is not taken', async () => {
    requireAction.mockRejectedValue(Object.assign(new Error('forbidden'), { status: 403 }));
    const res = await GET(request('code=c-1&state=s-1'));
    expect(res.headers.get('location')).toContain('bank=fehler%3Aforbidden');
    expect(completeConsent).not.toHaveBeenCalled();
  });

  it('switched off: back to the payments tab on the app address, without a login round trip', async () => {
    deps = null;
    requireAction.mockRejectedValue(Object.assign(new Error('unauthorized'), { status: 401 }));
    const res = await GET(request('code=c-1&state=s-1'));
    expect(res.headers.get('location')).toBe('https://receipts.example.test/app/finance?reiter=konten&bank=fehler%3Afeature_off');
    expect(requireAction).not.toHaveBeenCalled();
  });
});
