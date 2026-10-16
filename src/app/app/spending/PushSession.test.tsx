// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';

vi.mock('./loop-actions', () => ({ enablePush: vi.fn(), forgetPushEverywhere: vi.fn(), pushStateOfDevice: vi.fn() }));

import { renewPush, signOutWithPush } from './PushSession';
import type { PushEnvironment, SubscriptionLike } from './push-device';

const ENDPOINT = 'https://fcm.googleapis.com/fcm/send/device-1';

function environment(has: boolean) {
  let current: SubscriptionLike | null = has
    ? { endpoint: ENDPOINT, toJSON: () => ({ endpoint: ENDPOINT, keys: {} }), unsubscribe: vi.fn(async () => ((current = null), true)) }
    : null;
  const env: PushEnvironment = {
    registration: async () => ({ pushManager: { getSubscription: async () => current, subscribe: vi.fn() } }),
    requestPermission: vi.fn(),
  };
  return { env, sub: () => current };
}

describe('renewPush', () => {
  it('renews a device the server holds for the active company', async () => {
    const deps = { pushStateOfDevice: vi.fn(async () => ({ ok: true as const, value: { here: true, elsewhere: false } })), enablePush: vi.fn(async () => ({ ok: true as const, value: {} as never })) };
    expect(await renewPush(environment(true).env, deps)).toBe(true);
    expect(deps.enablePush).toHaveBeenCalledWith({ endpoint: ENDPOINT, keys: {} });
  });

  it('renews nothing for a device without push, or one this company does not hold', async () => {
    const deps = { pushStateOfDevice: vi.fn(async () => ({ ok: true as const, value: { here: false, elsewhere: true } })), enablePush: vi.fn() };
    expect(await renewPush(environment(false).env, deps)).toBe(false);
    expect(await renewPush(environment(true).env, deps)).toBe(false);
    expect(deps.enablePush).not.toHaveBeenCalled();
  });
});

describe('signOutWithPush', () => {
  it('forgets the device for every company and ends its subscription, then signs out', async () => {
    const { env, sub } = environment(true);
    const deps = { forgetPushEverywhere: vi.fn(async () => ({ ok: true as const, value: { forgotten: 2 } })) };
    const go = vi.fn();
    await signOutWithPush(env, 'https://auth.example/logout', go, deps);
    expect(deps.forgetPushEverywhere).toHaveBeenCalledWith(ENDPOINT);
    expect(sub()).toBeNull();
    expect(go).toHaveBeenCalledWith('https://auth.example/logout');
  });

  it('signs out also when push cannot be switched off, or the device offers none', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const go = vi.fn();
    await signOutWithPush(environment(true).env, '/logout', go, { forgetPushEverywhere: vi.fn(async () => { throw new Error('offline'); }) });
    await signOutWithPush(null, '/logout', go);
    expect(go).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });
});
