import { createPrivateKey, createSign, type KeyObject } from 'node:crypto';
import type { BankCredentials } from './config';

/**
 * A small client for the Enable Banking interface (reference read on
 * 2026-10-16: https://enablebanking.com/docs/api/reference/). No dependency:
 * the JSON Web Token (JWT) every call carries is signed here with node:crypto.
 *
 * Nothing this module logs or throws carries a token, a key, a session id or
 * an account number: errors carry the interface's error code and the HTTP
 * status only, and the accounts of a session leave this module masked.
 */

export const ENABLE_BANKING_BASE = 'https://api.enablebanking.com';
/** A token is valid for an hour (the interface allows at most a day). */
export const TOKEN_LIFETIME_SECONDS = 3600;
/** Pages of one transaction list at most: a bank that keeps answering with a continuation key cannot loop forever. */
export const MAX_PAGES = 50;
const REQUEST_TIMEOUT_MS = 30_000;

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{ status: number; ok: boolean; text(): Promise<string> }>;

/** What went wrong, in the terms the connection acts on. */
export type BankErrorKind =
  /** The session ended (expired, closed or revoked at the bank, or unknown): a new consent is needed. */
  | 'session_expired'
  | 'session_revoked'
  /** The bank or the interface limits calls: keep the connection, try at the next run. */
  | 'rate_limited'
  /** The bank did not answer or answered with an error: try again later. */
  | 'bank_unavailable'
  /** The interface does not offer this institution. */
  | 'wrong_aspsp'
  /** The account cannot be read through this session. */
  | 'account_not_accessible'
  /** The code the bank sent back is expired or wrong: start the consent again. */
  | 'authorization_code'
  /** The application's key or id is not accepted, or the key cannot be read. */
  | 'credentials'
  /** No answer at all (network, time-out) or an answer that is no JSON. */
  | 'network'
  | 'unknown';

export class BankApiError extends Error {
  readonly kind: BankErrorKind;
  /** The interface's own error code (for example EXPIRED_SESSION), or null. Never bank data. */
  readonly code: string | null;
  readonly status: number | null;
  constructor(kind: BankErrorKind, code: string | null = null, status: number | null = null) {
    super(`bank interface: ${kind}${code ? ` (${code})` : ''}${status ? ` [${status}]` : ''}`);
    this.name = 'BankApiError';
    this.kind = kind;
    this.code = code;
    this.status = status;
  }
}

const CODE_KINDS: Record<string, BankErrorKind> = {
  EXPIRED_SESSION: 'session_expired',
  SESSION_DOES_NOT_EXIST: 'session_expired',
  CLOSED_SESSION: 'session_revoked',
  REVOKED_SESSION: 'session_revoked',
  ASPSP_RATE_LIMIT_EXCEEDED: 'rate_limited',
  ASPSP_TIMEOUT: 'bank_unavailable',
  ASPSP_ERROR: 'bank_unavailable',
  WRONG_ASPSP_PROVIDED: 'wrong_aspsp',
  ASPSP_ACCOUNT_NOT_ACCESSIBLE: 'account_not_accessible',
  EXPIRED_AUTHORIZATION_CODE: 'authorization_code',
  WRONG_AUTHORIZATION_CODE: 'authorization_code',
};

/** Map an error answer of the interface. The machine code is in `error`; `code` is the HTTP status number. */
export function errorFromResponse(status: number, body: unknown): BankApiError {
  const raw = body && typeof body === 'object' ? (body as { error?: unknown; code?: unknown }) : {};
  const code = typeof raw.error === 'string' && /^[A-Z0-9_]{1,64}$/.test(raw.error) ? raw.error : typeof raw.code === 'string' && /^[A-Z0-9_]{1,64}$/.test(raw.code) ? raw.code : null;
  const kind = (code && CODE_KINDS[code]) || (status === 429 ? 'rate_limited' : status === 401 || status === 403 ? 'credentials' : status >= 500 ? 'bank_unavailable' : 'unknown');
  return new BankApiError(kind, code, status);
}

const base64url = (input: Buffer | string) => Buffer.from(input).toString('base64url');

/** The signed token of one call: RS256 with the application's key, the application id as key id. */
export function signToken(credentials: Pick<BankCredentials, 'appId'>, key: KeyObject, nowSeconds: number): string {
  const header = base64url(JSON.stringify({ typ: 'JWT', alg: 'RS256', kid: credentials.appId }));
  const claims = base64url(JSON.stringify({ iss: 'enablebanking.com', aud: 'api.enablebanking.com', iat: nowSeconds, exp: nowSeconds + TOKEN_LIFETIME_SECONDS }));
  const signature = createSign('RSA-SHA256').update(`${header}.${claims}`).sign(key);
  return `${header}.${claims}.${base64url(signature)}`;
}

/** An institution the interface offers. */
export interface Aspsp {
  name: string;
  country: string;
  /** How long a consent at this institution can last, in seconds; null when the interface does not say. */
  maximumConsentValiditySeconds: number | null;
  beta: boolean;
}

/** One account of a session, as it leaves this module: masked. */
export interface SessionAccount {
  uid: string;
  /** The last four characters of the account number, like "•••• 1234"; null when the bank names none. */
  mask: string | null;
  name: string;
  currency: string | null;
}

export interface BankSession {
  sessionId: string;
  accounts: SessionAccount[];
  validUntil: Date | null;
}

/** Who is present at a call made while the person uses the app; sent so the bank does not count it as an unattended fetch. */
export interface PsuPresence {
  ipAddress: string;
  userAgent: string;
}

export interface StartInput {
  aspsp: { name: string; country: string };
  validUntil: Date;
  state: string;
  redirectUrl: string;
}

/** What the connection service needs from the interface. The database tests give a fake. */
export interface BankApi {
  listAspsps(country: string): Promise<Aspsp[]>;
  startAuthorization(input: StartInput): Promise<{ url: string }>;
  createSession(code: string): Promise<BankSession>;
  deleteSession(sessionId: string): Promise<void>;
  /** Every booked and pending transaction of the account between the two days (both included), all pages. Raw, as the interface gives them. */
  fetchTransactions(accountUid: string, dateFrom: string, dateTo: string, psu?: PsuPresence): Promise<unknown[]>;
}

/** "•••• 1234" from an account number; never more than its last four characters. */
export function maskAccountNumber(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const compact = value.replace(/\s+/g, '');
  return compact.length >= 4 ? `•••• ${compact.slice(-4)}` : null;
}

function sessionAccount(raw: unknown): SessionAccount | null {
  const a = (raw ?? {}) as { uid?: unknown; account_id?: { iban?: unknown; other?: { identification?: unknown } }; name?: unknown; details?: unknown; product?: unknown; currency?: unknown };
  if (typeof a.uid !== 'string' || !a.uid) return null;
  const name = [a.name, a.details, a.product].find((x) => typeof x === 'string' && x.trim()) as string | undefined;
  return {
    uid: a.uid,
    mask: maskAccountNumber(a.account_id?.iban) ?? maskAccountNumber(a.account_id?.other?.identification),
    name: (name ?? '').trim().slice(0, 80),
    currency: typeof a.currency === 'string' ? a.currency : null,
  };
}

const toDate = (value: unknown): Date | null => {
  if (typeof value !== 'string') return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
};

export function createBankClient(credentials: BankCredentials, options: { fetch?: FetchLike; now?: () => Date; baseUrl?: string } = {}): BankApi {
  const doFetch: FetchLike = options.fetch ?? ((url, init) => fetch(url, init));
  const now = options.now ?? (() => new Date());
  const baseUrl = options.baseUrl ?? ENABLE_BANKING_BASE;
  let key: KeyObject | null = null;
  const signingKey = () => {
    if (!key) {
      try {
        key = createPrivateKey(credentials.privateKey);
      } catch {
        throw new BankApiError('credentials', 'UNREADABLE_PRIVATE_KEY');
      }
    }
    return key;
  };

  async function call(method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown, extraHeaders: Record<string, string> = {}): Promise<unknown> {
    const token = signToken(credentials, signingKey(), Math.floor(now().getTime() / 1000));
    let response: Awaited<ReturnType<FetchLike>>;
    try {
      response = await doFetch(`${baseUrl}${path}`, {
        method,
        headers: { ...extraHeaders, Authorization: `Bearer ${token}`, Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw new BankApiError('network');
    }
    const text = await response.text().catch(() => '');
    let parsed: unknown = null;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        if (response.ok) throw new BankApiError('network', 'INVALID_JSON', response.status);
      }
    }
    if (!response.ok) throw errorFromResponse(response.status, parsed);
    return parsed;
  }

  return {
    async listAspsps(country) {
      const data = (await call('GET', `/aspsps?country=${encodeURIComponent(country)}&psu_type=personal`)) as { aspsps?: unknown };
      const list = Array.isArray(data?.aspsps) ? data.aspsps : [];
      return list.flatMap((raw) => {
        const a = (raw ?? {}) as { name?: unknown; country?: unknown; maximum_consent_validity?: unknown; beta?: unknown };
        if (typeof a.name !== 'string' || typeof a.country !== 'string') return [];
        const seconds = typeof a.maximum_consent_validity === 'number' && a.maximum_consent_validity > 0 ? a.maximum_consent_validity : null;
        return [{ name: a.name, country: a.country, maximumConsentValiditySeconds: seconds, beta: a.beta === true }];
      });
    },
    async startAuthorization(input) {
      const data = (await call('POST', '/auth', {
        access: { valid_until: input.validUntil.toISOString() },
        aspsp: { name: input.aspsp.name, country: input.aspsp.country },
        state: input.state,
        redirect_url: input.redirectUrl,
        psu_type: 'personal',
      })) as { url?: unknown };
      if (typeof data?.url !== 'string' || !/^https:\/\//.test(data.url)) throw new BankApiError('unknown', 'NO_REDIRECT_URL');
      return { url: data.url };
    },
    async createSession(code) {
      const data = (await call('POST', '/sessions', { code })) as { session_id?: unknown; accounts?: unknown; access?: { valid_until?: unknown } };
      if (typeof data?.session_id !== 'string' || !data.session_id) throw new BankApiError('unknown', 'NO_SESSION_ID');
      const accounts = (Array.isArray(data.accounts) ? data.accounts : []).map(sessionAccount).filter((a): a is SessionAccount => a !== null);
      return { sessionId: data.session_id, accounts, validUntil: toDate(data.access?.valid_until) };
    },
    async deleteSession(sessionId) {
      await call('DELETE', `/sessions/${encodeURIComponent(sessionId)}`);
    },
    async fetchTransactions(accountUid, dateFrom, dateTo, psu) {
      const presence: Record<string, string> = psu ? { 'Psu-Ip-Address': psu.ipAddress.slice(0, 64), 'Psu-User-Agent': psu.userAgent.slice(0, 256) } : {};
      const out: unknown[] = [];
      let continuation: string | null = null;
      for (let page = 0; page < MAX_PAGES; page++) {
        const query = new URLSearchParams({ date_from: dateFrom, date_to: dateTo });
        if (continuation) query.set('continuation_key', continuation);
        const data = (await call('GET', `/accounts/${encodeURIComponent(accountUid)}/transactions?${query}`, undefined, presence)) as { transactions?: unknown; continuation_key?: unknown };
        if (Array.isArray(data?.transactions)) out.push(...data.transactions);
        continuation = typeof data?.continuation_key === 'string' && data.continuation_key ? data.continuation_key : null;
        if (!continuation) return out;
      }
      throw new BankApiError('unknown', 'TOO_MANY_PAGES');
    },
  };
}
