import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** The real wiring of the push channel to the `web-push` library, with the library replaced at module level. */

const setVapidDetails = vi.fn();
const sendNotification = vi.fn();
vi.mock('web-push', () => ({ default: { setVapidDetails: (...a: unknown[]) => setVapidDetails(...a), sendNotification: (...a: unknown[]) => sendNotification(...a) } }));

import { serverChannels, validVapidConfig } from '../notify/service';

const recipient = { workspaceId: 'ws-a', email: null };
const message = { subjectKey: 'k', kind: 'missing_receipt' as const, title: 'T', body: 'B', path: '/app/spending' };
const db = {
  spendingPushSubscription: {
    findMany: vi.fn(async () => [{ id: 'd1', endpoint: 'https://fcm.googleapis.com/fcm/send/1', p256dh: 'p', auth: 'a' }]),
    updateMany: vi.fn(async () => ({ count: 1 })),
    deleteMany: vi.fn(async () => ({ count: 0 })),
  },
} as never;

const env = { VAPID_PUBLIC_KEY: 'pub', VAPID_PRIVATE_KEY: 'priv', VAPID_SUBJECT: 'mailto:owner@example.com' };
let saved: NodeJS.ProcessEnv;

beforeEach(() => {
  saved = { ...process.env };
  setVapidDetails.mockReset();
  sendNotification.mockReset();
});
afterEach(() => {
  process.env = saved;
});

describe('serverChannels', () => {
  it('sends through web-push with the signing keys, a day to live and a socket timeout', async () => {
    Object.assign(process.env, env);
    sendNotification.mockResolvedValue({ statusCode: 201 });
    const push = serverChannels(db)[0];
    expect(await push.send(recipient, message)).toEqual({ status: 'sent' });
    const [subscription, payload, options] = sendNotification.mock.calls[0];
    expect(subscription).toEqual({ endpoint: 'https://fcm.googleapis.com/fcm/send/1', keys: { p256dh: 'p', auth: 'a' } });
    expect(JSON.parse(payload as string)).toMatchObject({ title: 'T', path: '/app/spending' });
    expect(options).toEqual({ vapidDetails: { publicKey: 'pub', privateKey: 'priv', subject: 'mailto:owner@example.com' }, TTL: 86_400, urgency: 'normal', timeout: 15_000 });
  });

  it('keeps push off, and says so once, when the keys on the server are not valid', async () => {
    setVapidDetails.mockImplementation(() => {
      throw new Error('Vapid public key should be 65 bytes long when decoded.');
    });
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const wrong = { ...env, VAPID_PUBLIC_KEY: 'not-a-key' };
    expect(validVapidConfig(wrong)).toBeNull();
    expect(validVapidConfig(wrong)).toBeNull();
    // Checked once per set of keys: one log line, not one per page.
    expect(setVapidDetails).toHaveBeenCalledTimes(1);
    expect(err).toHaveBeenCalledTimes(1);
    Object.assign(process.env, wrong);
    expect(await serverChannels(db)[0].send(recipient, message)).toEqual({ status: 'unavailable', detail: 'push is not configured on the server' });
    expect(sendNotification).not.toHaveBeenCalled();
    err.mockRestore();
  });
});
