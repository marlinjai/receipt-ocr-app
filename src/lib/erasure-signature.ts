import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * HMAC verification for auth-brain's `tenant.erased` webhook. Same scheme as
 * social-planner (src/lib/erasure-signature.ts): auth-brain signs `sha256=<hex>`
 * of HMAC-SHA256 over the EXACT raw request body and sends it in
 * `x-lumitra-erasure-signature`. Verify the bytes received, never a re-serialized
 * object, because the field order is what the signature covers.
 */

/** Header carrying auth-brain's HMAC over the raw delivery body. */
export const ERASURE_SIGNATURE_HEADER = 'x-lumitra-erasure-signature';

/**
 * True IFF `signatureHeader` is a valid HMAC-SHA256 (hex) of `rawBody` under
 * `secret`. Fails closed: a missing, malformed or wrong signature returns false.
 * The comparison is constant time. An optional `sha256=` prefix is tolerated.
 */
export function verifyErasureSignature(
  rawBody: string,
  signatureHeader: string | null | undefined,
  secret: string,
): boolean {
  if (!secret || !signatureHeader) return false;

  const provided = (signatureHeader.startsWith('sha256=') ? signatureHeader.slice(7) : signatureHeader)
    .trim()
    .toLowerCase();

  const expected = createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex');

  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
