import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import { verifyErasureSignature } from '../erasure-signature';

const SECRET = 'test-secret-not-real';
const BODY = '{"event_id":"e1","kind":"tenant.erased","tenant_id":"t1"}';
const sign = (body: string, secret = SECRET) => `sha256=${createHmac('sha256', secret).update(body, 'utf8').digest('hex')}`;

describe('verifyErasureSignature', () => {
  it('accepts the HMAC of the exact raw body', () => {
    expect(verifyErasureSignature(BODY, sign(BODY), SECRET)).toBe(true);
  });

  it('accepts the bare hex form too', () => {
    const hex = sign(BODY).slice(7);
    expect(verifyErasureSignature(BODY, hex, SECRET)).toBe(true);
  });

  it('rejects a body that was changed after signing', () => {
    expect(verifyErasureSignature(BODY.replace('t1', 't2'), sign(BODY), SECRET)).toBe(false);
  });

  it('rejects a signature made with another secret', () => {
    expect(verifyErasureSignature(BODY, sign(BODY, 'other'), SECRET)).toBe(false);
  });

  it('fails closed on a missing header, a missing secret and a malformed value', () => {
    expect(verifyErasureSignature(BODY, null, SECRET)).toBe(false);
    expect(verifyErasureSignature(BODY, undefined, SECRET)).toBe(false);
    expect(verifyErasureSignature(BODY, sign(BODY), '')).toBe(false);
    expect(verifyErasureSignature(BODY, 'sha256=abc', SECRET)).toBe(false);
  });
});
