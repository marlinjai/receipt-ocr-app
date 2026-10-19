import { describe, expect, it } from 'vitest';
import { createVerify, generateKeyPairSync } from 'node:crypto';
import { BankApiError, createBankClient, errorFromResponse, maskAccountNumber, MAX_PAGES, signToken, TOKEN_LIFETIME_SECONDS, type FetchLike } from '../client';

/** The Enable Banking client against a fake fetch. The key pair is made here; no real key or id is used. */

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const APP_ID = `app-${Math.random().toString(36).slice(2)}`;
const credentials = { appId: APP_ID, privateKey: pem, redirectUrl: 'https://receipts.example.test/api/banking/callback' };
const NOW = new Date('2026-10-16T08:00:00Z');

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

function fakeFetch(answers: Array<{ status: number; body: unknown }>): { fetch: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, method: init.method, headers: init.headers, body: init.body });
    const next = answers.shift() ?? { status: 500, body: {} };
    return { status: next.status, ok: next.status >= 200 && next.status < 300, text: async () => (typeof next.body === 'string' ? next.body : JSON.stringify(next.body)) };
  };
  return { fetch, calls };
}

const decode = (part: string) => JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));

describe('signToken', () => {
  it('signs RS256 with the application id as key id and the documented claims', () => {
    const token = signToken({ appId: APP_ID }, privateKey, 1_000_000);
    const [h, c, s] = token.split('.');
    expect(decode(h)).toEqual({ typ: 'JWT', alg: 'RS256', kid: APP_ID });
    expect(decode(c)).toEqual({ iss: 'enablebanking.com', aud: 'api.enablebanking.com', iat: 1_000_000, exp: 1_000_000 + TOKEN_LIFETIME_SECONDS });
    expect(TOKEN_LIFETIME_SECONDS).toBeLessThanOrEqual(86_400);
    const ok = createVerify('RSA-SHA256').update(`${h}.${c}`).verify(publicKey, Buffer.from(s, 'base64url'));
    expect(ok).toBe(true);
  });

  it('a token signed with another key does not verify', () => {
    const other = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const [h, c, s] = signToken({ appId: APP_ID }, other.privateKey, 1).split('.');
    expect(createVerify('RSA-SHA256').update(`${h}.${c}`).verify(publicKey, Buffer.from(s, 'base64url'))).toBe(false);
  });
});

describe('createBankClient', () => {
  it('sends a fresh bearer token and the consent request as documented', async () => {
    const { fetch, calls } = fakeFetch([{ status: 200, body: { url: 'https://bank.example.test/login', authorization_id: 'a1' } }]);
    const client = createBankClient(credentials, { fetch, now: () => NOW });
    const validUntil = new Date('2027-04-14T08:00:00Z');
    expect(await client.startAuthorization({ aspsp: { name: 'Beispielbank', country: 'DE' }, validUntil, state: 'st', redirectUrl: credentials.redirectUrl })).toEqual({ url: 'https://bank.example.test/login' });
    expect(calls[0].url).toBe('https://api.enablebanking.com/auth');
    expect(calls[0].method).toBe('POST');
    expect(JSON.parse(calls[0].body!)).toEqual({ access: { valid_until: validUntil.toISOString() }, aspsp: { name: 'Beispielbank', country: 'DE' }, state: 'st', redirect_url: credentials.redirectUrl, psu_type: 'personal' });
    const token = calls[0].headers.Authorization.replace('Bearer ', '');
    expect(decode(token.split('.')[1]).iat).toBe(Math.floor(NOW.getTime() / 1000));
  });

  it('refuses a consent answer without an https address', async () => {
    const { fetch } = fakeFetch([{ status: 200, body: { url: 'javascript:alert(1)' } }]);
    await expect(createBankClient(credentials, { fetch }).startAuthorization({ aspsp: { name: 'B', country: 'DE' }, validUntil: NOW, state: 's', redirectUrl: 'x' })).rejects.toBeInstanceOf(BankApiError);
  });

  it('reads all pages of a transaction list and stops at the last', async () => {
    const { fetch, calls } = fakeFetch([
      { status: 200, body: { transactions: [{ n: 1 }, { n: 2 }], continuation_key: 'k1' } },
      { status: 200, body: { transactions: [{ n: 3 }], continuation_key: 'k2' } },
      { status: 200, body: { transactions: [] } },
    ]);
    const list = await createBankClient(credentials, { fetch }).fetchTransactions('uid-1', '2026-07-19', '2026-10-16');
    expect(list).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);
    expect(calls).toHaveLength(3);
    expect(calls[0].url).toBe('https://api.enablebanking.com/accounts/uid-1/transactions?date_from=2026-07-19&date_to=2026-10-16');
    expect(calls[1].url).toContain('continuation_key=k1');
    expect(calls[2].url).toContain('continuation_key=k2');
  });

  it('marks a fetch with the person present only when asked to', async () => {
    const { fetch, calls } = fakeFetch([{ status: 200, body: { transactions: [] } }, { status: 200, body: { transactions: [] } }]);
    const client = createBankClient(credentials, { fetch });
    await client.fetchTransactions('u', '2026-10-01', '2026-10-16', { ipAddress: '192.0.2.1', userAgent: 'Testbrowser' });
    await client.fetchTransactions('u', '2026-10-01', '2026-10-16');
    expect(calls[0].headers).toMatchObject({ 'Psu-Ip-Address': '192.0.2.1', 'Psu-User-Agent': 'Testbrowser' });
    expect(calls[1].headers['Psu-Ip-Address']).toBeUndefined();
  });

  it('never loops forever on a bank that keeps paging', async () => {
    const { fetch, calls } = fakeFetch(Array.from({ length: MAX_PAGES + 5 }, () => ({ status: 200, body: { transactions: [], continuation_key: 'again' } })));
    await expect(createBankClient(credentials, { fetch }).fetchTransactions('u', '2026-01-01', '2026-01-02')).rejects.toMatchObject({ code: 'TOO_MANY_PAGES' });
    expect(calls).toHaveLength(MAX_PAGES);
  });

  it('masks the accounts of a new session and keeps no account number', async () => {
    const { fetch } = fakeFetch([
      {
        status: 200,
        body: {
          session_id: 'sess-1',
          access: { valid_until: '2027-04-14T08:00:00Z' },
          accounts: [
            // `name` is the account holder's name: never kept.
            { uid: 'u1', account_id: { iban: 'DE00 1234 5678 9012 3456 78' }, name: 'Erika Beispiel', product: 'Girokonto', currency: 'EUR' },
            { uid: 'u2', account_id: { other: { identification: '99887766' } }, product: 'Karte' },
            { account_id: { iban: 'DE00999' } },
          ],
        },
      },
    ]);
    const session = await createBankClient(credentials, { fetch }).createSession('code');
    expect(session.sessionId).toBe('sess-1');
    expect(session.validUntil?.toISOString()).toBe('2027-04-14T08:00:00.000Z');
    expect(session.accounts).toEqual([
      { uid: 'u1', mask: '•••• 5678', name: 'Girokonto', currency: 'EUR' },
      { uid: 'u2', mask: '•••• 7766', name: 'Karte', currency: null },
    ]);
    expect(JSON.stringify(session)).not.toContain('1234 5678 9012');
    expect(JSON.stringify(session)).not.toContain('Erika');
  });

  it('lists institutions with their consent length in seconds', async () => {
    const { fetch, calls } = fakeFetch([{ status: 200, body: { aspsps: [{ name: 'Beispielbank', country: 'DE', maximum_consent_validity: 7_776_000, beta: false }, { name: 'Testbank', country: 'DE', beta: true }, { country: 'DE' }] } }]);
    const list = await createBankClient(credentials, { fetch }).listAspsps('DE');
    expect(calls[0].url).toBe('https://api.enablebanking.com/aspsps?country=DE&psu_type=personal');
    expect(list).toEqual([
      { name: 'Beispielbank', country: 'DE', maximumConsentValiditySeconds: 7_776_000, beta: false },
      { name: 'Testbank', country: 'DE', maximumConsentValiditySeconds: null, beta: true },
    ]);
  });

  it('maps error answers by their machine code, else by status', async () => {
    const cases: Array<[number, unknown, string]> = [
      [422, { message: 'x', code: 422, error: 'EXPIRED_SESSION' }, 'session_expired'],
      [422, { error: 'SESSION_DOES_NOT_EXIST' }, 'session_expired'],
      [422, { error: 'REVOKED_SESSION' }, 'session_revoked'],
      [422, { error: 'CLOSED_SESSION' }, 'session_revoked'],
      [429, { error: 'ASPSP_RATE_LIMIT_EXCEEDED' }, 'rate_limited'],
      [429, {}, 'rate_limited'],
      [408, { error: 'ASPSP_TIMEOUT' }, 'bank_unavailable'],
      [500, { error: 'ASPSP_ERROR' }, 'bank_unavailable'],
      [503, 'not json', 'bank_unavailable'],
      [400, { error: 'WRONG_ASPSP_PROVIDED' }, 'wrong_aspsp'],
      [400, { error: 'ASPSP_ACCOUNT_NOT_ACCESSIBLE' }, 'account_not_accessible'],
      [400, { error: 'EXPIRED_AUTHORIZATION_CODE' }, 'authorization_code'],
      [400, { error: 'WRONG_AUTHORIZATION_CODE' }, 'authorization_code'],
      [401, {}, 'credentials'],
      [400, { error: 'SOMETHING_NEW' }, 'unknown'],
    ];
    for (const [status, body, kind] of cases) {
      const { fetch } = fakeFetch([{ status, body }]);
      const error = await createBankClient(credentials, { fetch }).deleteSession('s').catch((e) => e);
      expect(error, `${status} ${JSON.stringify(body)}`).toBeInstanceOf(BankApiError);
      expect(error.kind, `${status} ${JSON.stringify(body)}`).toBe(kind);
    }
  });

  it('an error never carries the token, the key or the session id', async () => {
    const { fetch } = fakeFetch([{ status: 422, body: { error: 'EXPIRED_SESSION', message: 'session sess-secret-1 expired' } }]);
    const error = await createBankClient(credentials, { fetch }).deleteSession('sess-secret-1').catch((e) => e);
    expect(String(error.message)).not.toContain('sess-secret-1');
    expect(String(error.message)).not.toContain('Bearer');
    expect(errorFromResponse(400, { error: 'lowercase or <script>' }).code).toBeNull();
  });

  it('a network failure and an unreadable key are errors of their own', async () => {
    const failing: FetchLike = async () => {
      throw new Error('offline');
    };
    await expect(createBankClient(credentials, { fetch: failing }).listAspsps('DE')).rejects.toMatchObject({ kind: 'network' });
    const { fetch } = fakeFetch([]);
    await expect(createBankClient({ ...credentials, privateKey: 'not a key' }, { fetch }).listAspsps('DE')).rejects.toMatchObject({ kind: 'credentials', code: 'UNREADABLE_PRIVATE_KEY' });
  });
});

describe('maskAccountNumber', () => {
  it('keeps the last four characters only', () => {
    expect(maskAccountNumber('DE00 1111 2222 3333 4444 55')).toBe('•••• 4455');
    expect(maskAccountNumber('12')).toBeNull();
    expect(maskAccountNumber(undefined)).toBeNull();
  });
});
