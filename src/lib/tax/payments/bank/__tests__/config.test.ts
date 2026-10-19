import { describe, expect, it } from 'vitest';
import { bankConfig, bankSyncSecret, normalizePem } from '../config';

/** Whether the bank feed is on. Every value is invented here; the tests only look at names and presence. */

// The PEM frame is put together at run time, so no private-key header is ever written out in the repository.
const frame = (side: 'BEGIN' | 'END') => ['-----', side, ' PRIVATE', ' KEY-----'].join('');
const fake = () => `v-${Math.random().toString(36).slice(2)}`;
const full = () => ({
  BANK_FEED_ENABLED: 'true',
  ENABLE_BANKING_APPLICATION_ID: fake(),
  ENABLE_BANKING_PRIVATE_KEY: `${frame('BEGIN')}\\nabc\\n${frame('END')}`,
  ENABLE_BANKING_REDIRECT_URL: 'https://receipts.example.test/api/banking/callback',
});

describe('bankConfig', () => {
  it('is on only with the switch and all three settings', () => {
    const config = bankConfig(full());
    expect(config.enabled).toBe(true);
    expect(config.credentials?.privateKey).toBe(`${frame('BEGIN')}\nabc\n${frame('END')}`);
  });

  it('is off without the switch, and says it was the switch', () => {
    for (const value of [undefined, '', 'false', 'TRUE', 'yes']) {
      const config = bankConfig({ ...full(), BANK_FEED_ENABLED: value });
      expect(config.enabled).toBe(false);
      expect(config.enabled === false && config.switchedOff).toBe(true);
    }
  });

  it('is off with a setting missing or blank and names only the missing names', () => {
    const env = { ...full(), ENABLE_BANKING_APPLICATION_ID: '   ', ENABLE_BANKING_REDIRECT_URL: undefined };
    const config = bankConfig(env);
    expect(config.enabled).toBe(false);
    expect(config.missing).toEqual(['ENABLE_BANKING_APPLICATION_ID', 'ENABLE_BANKING_REDIRECT_URL']);
    expect(JSON.stringify(config)).not.toContain(env.ENABLE_BANKING_PRIVATE_KEY);
  });

  it('the sync secret is separate and optional', () => {
    expect(bankSyncSecret({})).toBeNull();
    expect(bankSyncSecret({ BANK_SYNC_SECRET: ' ' })).toBeNull();
    const secret = fake();
    expect(bankSyncSecret({ BANK_SYNC_SECRET: secret })).toBe(secret);
  });

  it('a PEM with real line breaks stays as it is', () => {
    expect(normalizePem('a\nb')).toBe('a\nb');
  });
});
