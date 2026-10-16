import { describe, expect, it, vi } from 'vitest';
import { createEmailChannel, emailConfigFromEnv, idempotencyKey, renderEmail } from '../notify/email';
import { channelOrder, deliverThroughChannels, type NotificationChannel, type NotificationMessage } from '../notify/port';
import { createPushChannel, isPushServiceAddress, pushPayload, vapidConfigFromEnv } from '../notify/push';

const message: NotificationMessage = { subjectKey: 'missing_receipt:p1', kind: 'missing_receipt', title: 'Beleg fehlt: Zyx', body: 'Für 29,99 € an Zyx <Handel> fehlt der Beleg.', path: '/app/spending?pruefen=p1' };
const recipient = { workspaceId: 'ws-a', email: 'owner@example.com' };
const channel = (name: 'push' | 'email', send: NotificationChannel['send']): NotificationChannel => ({ name, send });

describe('channelOrder', () => {
  it('tries push, then e-mail by default; e-mail alone; nothing for in-app only', () => {
    expect(channelOrder('push')).toEqual(['push', 'email']);
    expect(channelOrder('email')).toEqual(['email']);
    expect(channelOrder('in_app')).toEqual([]);
  });
});

describe('deliverThroughChannels', () => {
  it('falls back to e-mail when push is not possible', async () => {
    const result = await deliverThroughChannels([createPushChannel(null, null, null), channel('email', async () => ({ status: 'sent' }))], 'push', recipient, message);
    expect(result).toEqual({ channel: 'email', attempts: ['push: unavailable (push is not configured on the server)', 'email: sent'], failed: false });
  });

  it('falls back to e-mail when push fails or throws, and records the failure', async () => {
    const throwing = channel('push', async () => {
      throw new Error('gateway down');
    });
    const result = await deliverThroughChannels([throwing, channel('email', async () => ({ status: 'sent' }))], 'push', recipient, message);
    expect(result.channel).toBe('email');
    expect(result.attempts[0]).toBe('push: failed (gateway down)');
  });

  it('leaves it in the app when no channel delivers, and says whether that was a failure', async () => {
    const unavailable = await deliverThroughChannels([createPushChannel(null, null, null), createEmailChannel(null)], 'push', recipient, message);
    expect(unavailable).toMatchObject({ channel: null, failed: false });
    const failed = await deliverThroughChannels([channel('email', async () => ({ status: 'failed', detail: 'mail service answered 500' }))], 'email', recipient, message);
    expect(failed).toMatchObject({ channel: null, failed: true });
    expect(await deliverThroughChannels([createPushChannel(null, null, null)], 'in_app', recipient, message)).toEqual({ channel: null, attempts: [], failed: false });
  });
});

describe('e-mail channel', () => {
  it('is off until the server holds all three settings', () => {
    expect(emailConfigFromEnv({ RESEND_API_KEY: 'x', SPENDING_MAIL_FROM: 'a@b.c' })).toBeNull();
    expect(emailConfigFromEnv({ RESEND_API_KEY: 'x', SPENDING_MAIL_FROM: 'a@b.c', APP_BASE_URL: 'https://app.example/' })).toEqual({ apiKey: 'x', from: 'a@b.c', baseUrl: 'https://app.example' });
  });

  it('needs an address', async () => {
    expect(await createEmailChannel({ apiKey: 'k', from: 'a@b.c', baseUrl: 'https://app.example' }).send({ workspaceId: 'ws', email: null }, message)).toEqual({ status: 'unavailable', detail: 'no address set' });
  });

  it('sends once per subject (an idempotency key) with a link back into the app, escaped', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 200 }));
    const sent = await createEmailChannel({ apiKey: 'k', from: 'a@b.c', baseUrl: 'https://app.example' }, fetchImpl as unknown as typeof fetch).send(recipient, message);
    expect(sent).toEqual({ status: 'sent' });
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>)['Idempotency-Key']).toBe(idempotencyKey(recipient, message));
    expect(idempotencyKey(recipient, message)).toMatch(/^ws-a:missing_receipt:p1:[0-9a-f]{16}$/);
    expect(idempotencyKey({ ...recipient, email: 'other@example.com' }, message)).not.toBe(idempotencyKey(recipient, message));
    const body = JSON.parse(init.body as string);
    expect(body.to).toEqual(['owner@example.com']);
    expect(body.text).toContain('https://app.example/app/spending?pruefen=p1');
    expect(body.html).toContain('Zyx &lt;Handel&gt;');
    expect(body.html.startsWith('<!doctype html><html lang="de"><head><meta charset="utf-8">')).toBe(true);
  });

  it('reports a refused or unreachable mail service as failed', async () => {
    const refused = vi.fn(async () => new Response('', { status: 422 }));
    expect(await createEmailChannel({ apiKey: 'k', from: 'a@b.c', baseUrl: 'https://x' }, refused as unknown as typeof fetch).send(recipient, message)).toEqual({ status: 'failed', detail: 'mail service answered 422' });
    const offline = vi.fn(async () => {
      throw new Error('offline');
    });
    expect(await createEmailChannel({ apiKey: 'k', from: 'a@b.c', baseUrl: 'https://x' }, offline as unknown as typeof fetch).send(recipient, message)).toEqual({ status: 'failed', detail: 'offline' });
  });

  it('renders the body as text and as escaped markup', () => {
    expect(renderEmail(message, 'https://x').subject).toBe('Beleg fehlt: Zyx');
  });
});

describe('push channel', () => {
  const vapid = { publicKey: 'pub', privateKey: 'priv', subject: 'mailto:owner@example.com' };
  const store = (devices: Array<{ id: string; endpoint: string }>) => {
    const calls: string[] = [];
    return {
      calls,
      store: {
        list: async () => devices.map((d) => ({ ...d, p256dh: 'p', auth: 'a' })),
        remove: async (id: string) => void calls.push(`remove:${id}`),
        succeeded: async (id: string) => void calls.push(`ok:${id}`),
        failed: async (id: string) => void calls.push(`failed:${id}`),
      },
    };
  };

  it('is unavailable without the server keys or without any device', async () => {
    expect(await createPushChannel(null, store([]).store, vi.fn()).send(recipient, message)).toMatchObject({ status: 'unavailable' });
    expect(await createPushChannel(vapid, store([]).store, vi.fn()).send(recipient, message)).toEqual({ status: 'unavailable', detail: 'no device has push switched on' });
  });

  it('sends the title, text, page and subject to every device, signed and with a day to live', async () => {
    const send = vi.fn(async () => ({ statusCode: 201 }));
    const s = store([{ id: 'd1', endpoint: 'https://push.example/1' }, { id: 'd2', endpoint: 'https://push.example/2' }]);
    expect(await createPushChannel(vapid, s.store, send).send(recipient, message)).toEqual({ status: 'sent' });
    expect(send).toHaveBeenCalledTimes(2);
    const [sub, payload, options] = send.mock.calls[0] as unknown as [{ endpoint: string }, string, { vapidDetails: unknown; TTL: number }];
    expect(sub.endpoint).toBe('https://push.example/1');
    expect(JSON.parse(payload)).toEqual({ title: message.title, body: message.body, path: message.path, tag: message.subjectKey });
    expect(pushPayload(message)).toBe(payload);
    expect(options).toMatchObject({ vapidDetails: vapid, TTL: 86_400 });
    expect(s.calls).toEqual(['ok:d1', 'ok:d2']);
  });

  it('forgets a device the push service says is gone, and is then unavailable, not failed', async () => {
    const send = vi.fn(async () => {
      throw Object.assign(new Error('gone'), { statusCode: 410 });
    });
    const s = store([{ id: 'd1', endpoint: 'https://push.example/1' }]);
    expect(await createPushChannel(vapid, s.store, send).send(recipient, message)).toMatchObject({ status: 'unavailable' });
    expect(s.calls).toEqual(['remove:d1']);
  });

  it('counts a failure and reports it, and is sent when one device of two got it', async () => {
    const send = vi.fn(async (sub: { endpoint: string }) => {
      if (sub.endpoint.endsWith('/1')) throw Object.assign(new Error('boom'), { statusCode: 500 });
      return { statusCode: 201 };
    });
    const s = store([{ id: 'd1', endpoint: 'https://push.example/1' }]);
    expect(await createPushChannel(vapid, s.store, send).send(recipient, message)).toEqual({ status: 'failed', detail: 'push service answered 500' });
    expect(s.calls).toEqual(['failed:d1']);
    const two = store([{ id: 'd1', endpoint: 'https://push.example/1' }, { id: 'd2', endpoint: 'https://push.example/2' }]);
    expect(await createPushChannel(vapid, two.store, send).send(recipient, message)).toEqual({ status: 'sent' });
  });

  it('keeps the delivery when the bookkeeping afterwards fails', async () => {
    const send = vi.fn(async () => ({ statusCode: 201 }));
    const s = store([{ id: 'd1', endpoint: 'https://push.example/1' }]);
    s.store.succeeded = async () => {
      throw new Error('database gone');
    };
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await createPushChannel(vapid, s.store, send).send(recipient, message)).toEqual({ status: 'sent' });
    err.mockRestore();
  });

  it('accepts only the addresses of the known push services', () => {
    for (const ok of ['https://fcm.googleapis.com/fcm/send/abc', 'https://web.push.apple.com/QAbc', 'https://updates.push.services.mozilla.com/wpush/v2/x', 'https://db5p.notify.windows.com/w/?token=x']) expect(isPushServiceAddress(ok)).toBe(true);
    for (const bad of ['http://fcm.googleapis.com/x', 'https://fcm.googleapis.com.evil.example/x', 'https://localhost/x', 'https://10.0.0.1/x', 'https://fcm.googleapis.com:8443/x', 'https://user:pw@fcm.googleapis.com/x', 'not a url', 'https://push.apple.com.evil.example/']) {
      expect(isPushServiceAddress(bad)).toBe(false);
    }
  });

  it('reads its keys from the server settings only when all three are there', () => {
    expect(vapidConfigFromEnv({ VAPID_PUBLIC_KEY: 'a', VAPID_PRIVATE_KEY: 'b' })).toBeNull();
    expect(vapidConfigFromEnv({ VAPID_PUBLIC_KEY: 'a', VAPID_PRIVATE_KEY: 'b', VAPID_SUBJECT: 'mailto:x@example.com' })).toEqual({ publicKey: 'a', privateKey: 'b', subject: 'mailto:x@example.com' });
  });
});
