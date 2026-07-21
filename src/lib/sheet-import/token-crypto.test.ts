import { describe, it, expect } from 'vitest';
import { encryptToken, decryptToken, loadKey } from './token-crypto';

// 32-byte test keys (never a real key).
const HEX_KEY = 'a'.repeat(64);
const B64_KEY = Buffer.alloc(32, 7).toString('base64');

describe('token-crypto', () => {
  it('round-trips a refresh token (hex key)', () => {
    const secret = '1//0gRefreshTokenExample-abc_DEF';
    const sealed = encryptToken(secret, HEX_KEY);
    expect(sealed).not.toContain(secret);
    expect(decryptToken(sealed, HEX_KEY)).toBe(secret);
  });

  it('round-trips with a base64 key', () => {
    const sealed = encryptToken('tok', B64_KEY);
    expect(decryptToken(sealed, B64_KEY)).toBe('tok');
  });

  it('produces a fresh IV each call (ciphertexts differ, both decrypt)', () => {
    const a = encryptToken('same', HEX_KEY);
    const b = encryptToken('same', HEX_KEY);
    expect(a).not.toBe(b);
    expect(decryptToken(a, HEX_KEY)).toBe('same');
    expect(decryptToken(b, HEX_KEY)).toBe('same');
  });

  it('fails loudly on a wrong key', () => {
    const sealed = encryptToken('tok', HEX_KEY);
    expect(() => decryptToken(sealed, 'b'.repeat(64))).toThrow();
  });

  it('fails loudly on tampered ciphertext (GCM auth tag)', () => {
    const sealed = encryptToken('tok', HEX_KEY);
    const buf = Buffer.from(sealed, 'base64');
    buf[buf.length - 1] ^= 0xff; // flip a ciphertext bit
    expect(() => decryptToken(buf.toString('base64'), HEX_KEY)).toThrow();
  });

  it('rejects a key that is not 32 bytes', () => {
    expect(() => loadKey('tooshort')).toThrow(/32 bytes/);
  });
});
