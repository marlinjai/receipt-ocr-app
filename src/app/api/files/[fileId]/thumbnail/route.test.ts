import { describe, expect, it, vi } from 'vitest';

/**
 * The placeholder thumbnail writes the file id into an SVG: only a real id
 * gets in, and the picture is sandboxed so nothing in it could ever run.
 */

vi.mock('next/server', () => {
  class NextResponse extends Response {
    static json(body: unknown, init?: ResponseInit) {
      return new NextResponse(JSON.stringify(body), { ...init, headers: { 'Content-Type': 'application/json' } });
    }
  }
  return { NextResponse, NextRequest: class {} };
});

import { GET } from './route';
import { SANDBOX_POLICY } from '@/lib/files/served-file-headers';

const call = (fileId: string) => GET({} as never, { params: Promise.resolve({ fileId }) }) as unknown as Promise<Response>;

describe('GET /api/files/:id/thumbnail', () => {
  it('draws the placeholder for a real id, sandboxed and never sniffed', async () => {
    const res = await call('11111111-1111-4111-8111-111111111111');
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('image/svg+xml');
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(res.headers.get('Content-Security-Policy')).toBe(SANDBOX_POLICY);
    expect(await res.text()).toContain('data-file-id="11111111-1111-4111-8111-111111111111"');
  });

  it('refuses anything else, so no markup from the address ends up in the picture', async () => {
    const res = await call('x"><script>alert(1)</script>');
    expect(res.status).toBe(400);
    expect(await res.text()).not.toContain('<script>');
  });
});
