import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  buildAuthUrl,
  exchangeCodeForTokens,
  refreshAccessToken,
  GoogleOAuthError,
  GOOGLE_SHEETS_SCOPE,
} from './google-oauth';

afterEach(() => vi.restoreAllMocks());

describe('buildAuthUrl', () => {
  it('sets the params Google needs for an offline read-only grant', () => {
    const url = new URL(
      buildAuthUrl({ clientId: 'cid', redirectUri: 'https://receipts.lumitra.co/api/google/oauth/callback', state: 'st' }),
    );
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    const p = url.searchParams;
    expect(p.get('client_id')).toBe('cid');
    expect(p.get('redirect_uri')).toBe('https://receipts.lumitra.co/api/google/oauth/callback');
    expect(p.get('response_type')).toBe('code');
    expect(p.get('scope')).toBe(GOOGLE_SHEETS_SCOPE);
    expect(p.get('access_type')).toBe('offline');
    expect(p.get('prompt')).toBe('consent'); // forces refresh_token issuance
    expect(p.get('state')).toBe('st');
  });
});

describe('token exchanges', () => {
  it('exchanges an auth code for tokens', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ access_token: 'at', refresh_token: 'rt', expires_in: 3600, scope: GOOGLE_SHEETS_SCOPE, token_type: 'Bearer' }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const tokens = await exchangeCodeForTokens({ code: 'c', clientId: 'id', clientSecret: 'sec', redirectUri: 'https://x/cb' });
    expect(tokens.access_token).toBe('at');
    expect(tokens.refresh_token).toBe('rt');
    // sent as form-encoded to the token endpoint
    const [urlArg, init] = fetchMock.mock.calls[0];
    expect(urlArg).toBe('https://oauth2.googleapis.com/token');
    expect((init.body as URLSearchParams).get('grant_type')).toBe('authorization_code');
  });

  it('refreshes an access token', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ access_token: 'fresh', expires_in: 3600, scope: GOOGLE_SHEETS_SCOPE, token_type: 'Bearer' }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const tokens = await refreshAccessToken({ refreshToken: 'rt', clientId: 'id', clientSecret: 'sec' });
    expect(tokens.access_token).toBe('fresh');
    expect((fetchMock.mock.calls[0][1].body as URLSearchParams).get('grant_type')).toBe('refresh_token');
  });

  it('throws GoogleOAuthError on a non-2xx token response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('bad', { status: 400 })));
    await expect(refreshAccessToken({ refreshToken: 'rt', clientId: 'id', clientSecret: 'sec' })).rejects.toBeInstanceOf(GoogleOAuthError);
  });
});
