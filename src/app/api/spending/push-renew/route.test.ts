import { beforeEach, describe, expect, it, vi } from 'vitest';

/** The renewal route the service worker calls: the signed-in person only, refusals with a code. */

const verifyRequest = vi.fn();
const replacePushSubscription = vi.fn();
vi.mock('@/lib/auth', () => ({ auth: { verifyRequest: (...a: unknown[]) => verifyRequest(...a) } }));
vi.mock('@/lib/prisma', () => ({ prisma: { marker: 'prisma' } }));
vi.mock('@/lib/spending/notify/service', () => {
  class NotifyServiceError extends Error {
    constructor(readonly code: string) {
      super(code);
    }
  }
  return { NotifyServiceError, replacePushSubscription: (...a: unknown[]) => replacePushSubscription(...a) };
});

import { NotifyServiceError } from '@/lib/spending/notify/service';
import { POST } from './route';

const post = (body: unknown) => POST(new Request('http://localhost/api/spending/push-renew', { method: 'POST', body: JSON.stringify(body) }) as never);

beforeEach(() => {
  verifyRequest.mockReset();
  replacePushSubscription.mockReset();
});

describe('POST /api/spending/push-renew', () => {
  it('refuses without a session, and refuses machine callers', async () => {
    verifyRequest.mockResolvedValue({ kind: 'none', reason: 'no-credential' });
    expect((await post({})).status).toBe(401);
    verifyRequest.mockResolvedValue({ kind: 'service' });
    expect((await post({})).status).toBe(403);
    expect(replacePushSubscription).not.toHaveBeenCalled();
  });

  it("moves the signed-in person's rows only", async () => {
    verifyRequest.mockResolvedValue({ kind: 'user', userId: 'user-a', email: 'a@example.com', memberships: [], activeWorkspace: null });
    replacePushSubscription.mockResolvedValue(2);
    const res = await post({ oldEndpoint: 'https://fcm.googleapis.com/x/old', subscription: { endpoint: 'https://fcm.googleapis.com/x/new' } });
    expect(await res.json()).toEqual({ moved: 2 });
    expect(replacePushSubscription).toHaveBeenCalledWith({ marker: 'prisma' }, 'user-a', 'https://fcm.googleapis.com/x/old', { endpoint: 'https://fcm.googleapis.com/x/new' });
  });

  it('answers a bad subscription with its code, and anything else with failed', async () => {
    verifyRequest.mockResolvedValue({ kind: 'user', userId: 'user-a', email: 'a@example.com', memberships: [], activeWorkspace: null });
    replacePushSubscription.mockRejectedValueOnce(new NotifyServiceError('invalid_subscription'));
    const bad = await post({});
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: 'invalid_subscription' });
    replacePushSubscription.mockRejectedValueOnce(new Error('database gone'));
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect((await post({})).status).toBe(500);
    spy.mockRestore();
  });
});
