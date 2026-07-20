/**
 * Env-backed config for the Sheets OAuth client. Kept tiny and lazy (read at
 * call time, never at module load) so `next build` works without the secrets.
 */

export interface GoogleOAuthClient {
  clientId: string;
  clientSecret: string;
}

export function loadGoogleOAuthClient(): GoogleOAuthClient {
  const clientId = process.env.GOOGLE_SHEETS_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_SHEETS_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error('Google Sheets OAuth is not configured (GOOGLE_SHEETS_CLIENT_ID / GOOGLE_SHEETS_CLIENT_SECRET)');
  }
  return { clientId, clientSecret };
}

export function tokenEncryptionKey(): string {
  const key = process.env.SHEETS_TOKEN_ENC_KEY;
  if (!key) throw new Error('SHEETS_TOKEN_ENC_KEY is not set');
  return key;
}

/**
 * The request's public origin, honouring the reverse-proxy forwarded headers
 * exactly like the app's middleware, so redirects land on the real host.
 */
export function publicOrigin(req: Request): string {
  const url = new URL(req.url);
  const proto = req.headers.get('x-forwarded-proto') ?? url.protocol.replace(/:$/, '');
  const host = req.headers.get('x-forwarded-host') ?? req.headers.get('host') ?? url.host;
  return `${proto}://${host}`;
}

/**
 * The OAuth redirect URI, derived from the public origin so it matches whichever
 * registered URI applies (prod vs localhost). Must be identical on the auth
 * request and the token exchange, which it is (same host on both).
 */
export function redirectUriFor(req: Request): string {
  return `${publicOrigin(req)}/api/google/oauth/callback`;
}
