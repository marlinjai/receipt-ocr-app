import { describe, expect, it, vi } from 'vitest';
import { createEmailChannel, emailConfigFromEnv, idempotencyKey, renderEmail } from '../notify/email';
import { channelOrder, deliverThroughChannels, type NotificationChannel, type NotificationMessage } from '../notify/port';
import { createPushChannel } from '../notify/push';

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
    const result = await deliverThroughChannels([createPushChannel(), channel('email', async () => ({ status: 'sent' }))], 'push', recipient, message);
    expect(result).toEqual({ channel: 'email', attempts: ['push: unavailable (push is not set up yet)', 'email: sent'], failed: false });
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
    const unavailable = await deliverThroughChannels([createPushChannel(), createEmailChannel(null)], 'push', recipient, message);
    expect(unavailable).toMatchObject({ channel: null, failed: false });
    const failed = await deliverThroughChannels([channel('email', async () => ({ status: 'failed', detail: 'mail service answered 500' }))], 'email', recipient, message);
    expect(failed).toMatchObject({ channel: null, failed: true });
    expect(await deliverThroughChannels([createPushChannel()], 'in_app', recipient, message)).toEqual({ channel: null, attempts: [], failed: false });
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
