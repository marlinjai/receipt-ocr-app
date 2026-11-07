import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { receiveBooksPull } from '../receiver';
import type { BooksPullOutcome } from '../service';

const SECRET = 'secret-built-at-run-time-' + Math.random().toString(36).slice(2);
const NOW = new Date('2026-11-08T05:00:00Z');
const nowTs = Math.floor(NOW.getTime() / 1000);
const sign = (body: string) => 'sha256=' + createHmac('sha256', SECRET).update(body).digest('hex');

const landed: BooksPullOutcome = {
  ok: true,
  workspaceId: 'ws',
  report: { created: 2, attached: 0, updated: 0, unchanged: 61, paymentsMoved: 0, skipped: [{ number: '23', reason: 'not_euro' }], conflicts: [] },
};

function call(overrides: Partial<Parameters<typeof receiveBooksPull>[0]> = {}) {
  const rawBody = JSON.stringify({ ts: nowTs });
  return receiveBooksPull({
    rawBody,
    signature: sign(rawBody),
    secret: SECRET,
    claim: async () => true,
    pull: async () => landed,
    now: () => NOW,
    log: () => undefined,
    ...overrides,
  });
}

describe('receiveBooksPull', () => {
  it('runs a signed, fresh call once and answers counts and invoice numbers', async () => {
    const res = await call();
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, created: 2, attached: 0, updated: 0, unchanged: 61, paymentsMoved: 0, skipped: [{ number: '23', reason: 'not_euro' }], conflicts: [] });
    expect(JSON.stringify(res.body)).not.toContain('ws');
  });

  it('fails closed without the secret, and refuses a bad signature or a stale time', async () => {
    const pull = vi.fn(async () => landed);
    expect((await call({ secret: undefined, pull })).status).toBe(503);
    expect((await call({ signature: 'sha256=00', pull })).status).toBe(401);
    expect((await call({ signature: null, pull })).status).toBe(401);
    const stale = JSON.stringify({ ts: nowTs - 301 });
    expect((await call({ rawBody: stale, signature: sign(stale), pull })).status).toBe(401);
    expect(pull).not.toHaveBeenCalled();
  });

  it('refuses a replay of an accepted call', async () => {
    const pull = vi.fn(async () => landed);
    expect((await call({ claim: async () => false, pull })).status).toBe(409);
    expect(pull).not.toHaveBeenCalled();
  });

  it('answers a failed pull non-2xx with its code, so the task shows a failed run', async () => {
    expect(await call({ pull: async () => ({ ok: false, code: 'books_key_refused', workspaceId: null }) })).toEqual({ status: 502, body: { error: 'Pull failed', code: 'books_key_refused' } });
    expect((await call({ pull: async () => ({ ok: false, code: 'not_configured', workspaceId: null }) })).status).toBe(503);
    expect((await call({ pull: async () => Promise.reject(new Error('boom')) })).status).toBe(502);
  });
});
