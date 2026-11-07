/**
 * Where the issued documents are pulled from (framer-clone's Books, its
 * read-only machine endpoint) and with which key, read by name from the
 * environment only. Values are never logged or returned: `missing` holds names.
 *
 * - BOOKS_PULL_KEY: the auth-brain API key of a service account scoped to the
 *   company whose invoices are mirrored (a secret, Infisical).
 * - BOOKS_URL: the Books' base address, `https://app.lumitra.co` when unset
 *   (not a secret).
 * - BOOKS_PULL_SECRET: the HMAC secret the scheduled call signs with; only the
 *   scheduled route needs it, the button in the "Einnahmen" tab does not.
 *
 * See docs/operations/books-mirror.md.
 */

export const BOOKS_PULL_ENV = {
  key: 'BOOKS_PULL_KEY',
  url: 'BOOKS_URL',
  secret: 'BOOKS_PULL_SECRET',
} as const;

export const DEFAULT_BOOKS_URL = 'https://app.lumitra.co';

export type BooksPullConfig = { configured: true; baseUrl: string; key: string } | { configured: false; missing: string[] };

type Env = Record<string, string | undefined>;

/** A value scaffolded into the secret store before the real one exists counts as not set. */
const isPlaceholder = (v: string | undefined) => v === undefined || v === '' || v.startsWith('PLACEHOLDER');

export function booksPullConfig(env: Env = process.env): BooksPullConfig {
  const rawKey = env[BOOKS_PULL_ENV.key]?.trim();
  const key = isPlaceholder(rawKey) ? undefined : rawKey;
  const rawUrl = env[BOOKS_PULL_ENV.url]?.trim() || DEFAULT_BOOKS_URL;
  let baseUrl: string | null = null;
  try {
    const url = new URL(rawUrl);
    // The key travels in a header: never over plain http, except to a local Books in development.
    if (url.protocol === 'https:' || (url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1'))) {
      baseUrl = url.origin;
    }
  } catch {
    baseUrl = null;
  }
  const missing: string[] = [];
  if (!key) missing.push(BOOKS_PULL_ENV.key);
  if (!baseUrl) missing.push(BOOKS_PULL_ENV.url);
  if (missing.length > 0 || !key || !baseUrl) return { configured: false, missing };
  return { configured: true, baseUrl, key };
}

export function booksPullSecret(env: Env = process.env): string | undefined {
  const v = env[BOOKS_PULL_ENV.secret];
  return typeof v === 'string' && !isPlaceholder(v.trim()) ? v : undefined;
}
