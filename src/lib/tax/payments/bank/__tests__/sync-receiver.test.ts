import { describe, expect, it, vi } from 'vitest';
import { createHmac, randomBytes } from 'node:crypto';
import { receiveBankSync } from '../sync-receiver';

/** The daily bank fetch route's door: fails closed, needs the signature, answers counts only. */

const SECRET = `test-${randomBytes(16).toString('hex')}`;
const BODY = '{}';
const sign = (body: string, secret = SECRET) => `sha256=${createHmac('sha256', secret).update(body, 'utf8').digest('hex')}`;
const quiet = () => undefined;

describe('receiveBankSync', () => {
  it('answers 503 without a secret and runs nothing', async () => {
    const sync = vi.fn();
    const result = await receiveBankSync({ rawBody: BODY, signature: sign(BODY), secret: null, enabled: true, sync, log: quiet });
    expect(result.status).toBe(503);
    expect(sync).not.toHaveBeenCalled();
  });

  it('answers 401 on a missing or wrong signature', async () => {
    const sync = vi.fn();
    expect((await receiveBankSync({ rawBody: BODY, signature: null, secret: SECRET, enabled: true, sync, log: quiet })).status).toBe(401);
    expect((await receiveBankSync({ rawBody: BODY, signature: sign(BODY, 'other'), secret: SECRET, enabled: true, sync, log: quiet })).status).toBe(401);
    expect((await receiveBankSync({ rawBody: '{"x":1}', signature: sign(BODY), secret: SECRET, enabled: true, sync, log: quiet })).status).toBe(401);
    expect(sync).not.toHaveBeenCalled();
  });

  it('answers 503 when the feed is switched off, even signed', async () => {
    const sync = vi.fn();
    expect((await receiveBankSync({ rawBody: BODY, signature: sign(BODY), secret: SECRET, enabled: false, sync, log: quiet })).status).toBe(503);
    expect(sync).not.toHaveBeenCalled();
  });

  it('runs signed and answers counts per connection', async () => {
    const sync = vi.fn(async () => [
      { connectionId: 'c1', status: 'synced', added: 3 },
      { connectionId: 'c2', status: 'failed', added: 0 },
    ]);
    const result = await receiveBankSync({ rawBody: BODY, signature: sign(BODY), secret: SECRET, enabled: true, sync, log: quiet });
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ ok: true, connections: 2, added: 3, failed: 1 });
  });

  it('a failing run answers 502 without details', async () => {
    const result = await receiveBankSync({ rawBody: BODY, signature: sign(BODY), secret: SECRET, enabled: true, sync: async () => { throw new Error('boom with details'); }, log: quiet });
    expect(result.status).toBe(502);
    expect(JSON.stringify(result.body)).not.toContain('details');
  });
});
