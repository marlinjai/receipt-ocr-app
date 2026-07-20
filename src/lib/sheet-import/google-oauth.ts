/**
 * Google OAuth 2.0 for the per-user Sheets connection. The authorization-URL
 * builder is pure; the token calls hit Google's token endpoint. All of it is
 * unit-testable (buildAuthUrl directly, the exchanges via a mocked fetch).
 *
 * Scope is read-only Sheets. `access_type=offline` + `prompt=consent` ensure a
 * refresh token is returned on first connect (Google omits it otherwise).
 */

export const GOOGLE_SHEETS_SCOPE = 'https://www.googleapis.com/auth/spreadsheets.readonly';
const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';

export interface GoogleTokens {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  scope: string;
  token_type: string;
}

export class GoogleOAuthError extends Error {
  readonly status: number;
  constructor(status: number, detail: string) {
    super(`Google OAuth error ${status}: ${detail}`);
    this.name = 'GoogleOAuthError';
    this.status = status;
  }
}

export function buildAuthUrl(p: {
  clientId: string;
  redirectUri: string;
  state: string;
  scope?: string;
  loginHint?: string;
}): string {
  const u = new URL(AUTH_ENDPOINT);
  u.searchParams.set('client_id', p.clientId);
  u.searchParams.set('redirect_uri', p.redirectUri);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('scope', p.scope ?? GOOGLE_SHEETS_SCOPE);
  u.searchParams.set('access_type', 'offline');
  u.searchParams.set('prompt', 'consent');
  u.searchParams.set('include_granted_scopes', 'true');
  u.searchParams.set('state', p.state);
  if (p.loginHint) u.searchParams.set('login_hint', p.loginHint);
  return u.toString();
}

async function postToken(body: URLSearchParams): Promise<GoogleTokens> {
  const res = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) throw new GoogleOAuthError(res.status, await res.text().catch(() => ''));
  return (await res.json()) as GoogleTokens;
}

export function exchangeCodeForTokens(p: {
  code: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}): Promise<GoogleTokens> {
  return postToken(
    new URLSearchParams({
      code: p.code,
      client_id: p.clientId,
      client_secret: p.clientSecret,
      redirect_uri: p.redirectUri,
      grant_type: 'authorization_code',
    }),
  );
}

export function refreshAccessToken(p: {
  refreshToken: string;
  clientId: string;
  clientSecret: string;
}): Promise<GoogleTokens> {
  return postToken(
    new URLSearchParams({
      refresh_token: p.refreshToken,
      client_id: p.clientId,
      client_secret: p.clientSecret,
      grant_type: 'refresh_token',
    }),
  );
}
