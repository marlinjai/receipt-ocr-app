import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * AES-256-GCM sealing for the stored Google refresh token. The token grants
 * read access to a user's Sheets, so it never touches the DB in plaintext.
 *
 * Key: 32 bytes, supplied via `SHEETS_TOKEN_ENC_KEY` as 64 hex chars or base64.
 * Output: base64 of `iv(12) || authTag(16) || ciphertext`, one self-describing
 * string for a TEXT column. GCM's auth tag means tampering (or a wrong key)
 * fails loudly on decrypt rather than returning garbage.
 */

export function loadKey(raw: string): Buffer {
  const s = raw.trim();
  const key = /^[0-9a-fA-F]{64}$/.test(s) ? Buffer.from(s, 'hex') : Buffer.from(s, 'base64');
  if (key.length !== 32) {
    throw new Error('SHEETS_TOKEN_ENC_KEY must decode to 32 bytes (64 hex chars or base64)');
  }
  return key;
}

export function encryptToken(plaintext: string, keyRaw: string): string {
  const key = loadKey(keyRaw);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ct]).toString('base64');
}

export function decryptToken(payload: string, keyRaw: string): string {
  const key = loadKey(keyRaw);
  const buf = Buffer.from(payload, 'base64');
  if (buf.length < 28) throw new Error('ciphertext too short');
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const ct = buf.subarray(28);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}
