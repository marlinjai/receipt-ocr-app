import { describe, expect, it, vi } from 'vitest';
import { createHmac, randomBytes } from 'node:crypto';
import { receiveBankSync } from '../sync-receiver';

/** The daily bank fetch route's door: fails closed, needs the signature, answers counts only. */

const SECRET = `test-${randomBytes(16).toString('hex')}`;
const NOW = new Date('2026-10-16T05:30:00Z');
const BODY = JSON.stringify({ ts: Math.floor(NOW.getTime() / 1000) });
const now = () => NOW;
const sign = (body: string, secret = SECRET) => `sha256=${createHmac('sha256', secret).update(body, 'utf8').digest('hex')}`;
const quiet = () => undefined;

const allow = async () => true;

describe('receiveBankSync', () => {
  it('answers 503 without a secret and runs nothing', async () => {
    const sync = vi.fn();
    const result = await receiveBankSync({ claim: allow, rawBody: BODY, signature: sign(BODY), secret: null, enabled: true, sync, log: quiet, now });
    expect(result.status).toBe(503);
    expect(sync).not.toHaveBeenCalled();
  });

  it('answers 401 on a missing or wrong signature', async () => {
    const sync = vi.fn();
    expect((await receiveBankSync({ claim: allow, rawBody: BODY, signature: null, secret: SECRET, enabled: true, sync, log: quiet, now })).status).toBe(401);
    expect((await receiveBankSync({ claim: allow, rawBody: BODY, signature: sign(BODY, 'other'), secret: SECRET, enabled: true, sync, log: quiet, now })).status).toBe(401);
    expect((await receiveBankSync({ claim: allow, rawBody: '{"x":1}', signature: sign(BODY), secret: SECRET, enabled: true, sync, log: quiet, now })).status).toBe(401);
    expect(sync).not.toHaveBeenCalled();
  });

  it('refuses a signed body without a time, or older or newer than five minutes (no replay)', async () => {
    const sync = vi.fn();
    for (const body of ['{}', JSON.stringify({ ts: 'soon' }), JSON.stringify({ ts: Math.floor(NOW.getTime() / 1000) - 301 }), JSON.stringify({ ts: Math.floor(NOW.getTime() / 1000) + 301 }), 'not json']) {
      expect((await receiveBankSync({ claim: allow, rawBody: body, signature: sign(body), secret: SECRET, enabled: true, sync, log: quiet, now })).status, body).toBe(401);
    }
    const fresh = JSON.stringify({ ts: Math.floor(NOW.getTime() / 1000) - 60 });
    expect((await receiveBankSync({ claim: allow, rawBody: fresh, signature: sign(fresh), secret: SECRET, enabled: true, sync: async () => [], log: quiet, now })).status).toBe(200);
    expect(sync).not.toHaveBeenCalled();
  });

  it('runs a signed request once: the same or an older time is refused inside the window too', async () => {
    // As the database claim behaves: only a time later than the last accepted one is taken.
    let last: number | null = null;
    const claim = async (ts: number) => (last !== null && ts <= last ? false : ((last = ts), true));
    const sync = vi.fn(async () => []);
    expect((await receiveBankSync({ rawBody: BODY, signature: sign(BODY), secret: SECRET, enabled: true, sync, log: quiet, now, claim })).status).toBe(200);
    expect((await receiveBankSync({ rawBody: BODY, signature: sign(BODY), secret: SECRET, enabled: true, sync, log: quiet, now, claim })).status).toBe(409);
    const later = JSON.stringify({ ts: Math.floor(NOW.getTime() / 1000) + 1 });
    expect((await receiveBankSync({ rawBody: later, signature: sign(later), secret: SECRET, enabled: true, sync, log: quiet, now, claim })).status).toBe(200);
    expect(sync).toHaveBeenCalledTimes(2);
  });

  it('answers 503 when the feed is switched off, even signed', async () => {
    const sync = vi.fn();
    expect((await receiveBankSync({ claim: allow, rawBody: BODY, signature: sign(BODY), secret: SECRET, enabled: false, sync, log: quiet, now })).status).toBe(503);
    expect(sync).not.toHaveBeenCalled();
  });

  it('runs signed and answers counts per connection', async () => {
    const sync = vi.fn(async () => [
      { connectionId: 'c1', status: 'synced', added: 3 },
      { connectionId: 'c2', status: 'failed', added: 0 },
      { connectionId: 'c3', status: 'deferred', added: 0 },
    ]);
    const result = await receiveBankSync({ claim: allow, rawBody: BODY, signature: sign(BODY), secret: SECRET, enabled: true, sync, log: quiet, now });
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ ok: true, connections: 3, added: 3, failed: 1, deferred: 1 });
  });

  it('a failing run answers 502 without details', async () => {
    const result = await receiveBankSync({ claim: allow, rawBody: BODY, signature: sign(BODY), secret: SECRET, enabled: true, sync: async () => { throw new Error('boom with details'); }, log: quiet, now });
    expect(result.status).toBe(502);
    expect(JSON.stringify(result.body)).not.toContain('details');
  });
});
