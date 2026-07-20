import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { exchangeCodeForTokens } from '@/lib/sheet-import/google-oauth';
import { loadGoogleOAuthClient, redirectUriFor, publicOrigin } from '@/lib/sheet-import/google-config';
import { saveGoogleCredential } from '@/lib/sheet-import/google-credentials';
import { OAUTH_STATE_COOKIE } from '../start/route';

export const dynamic = 'force-dynamic';

/**
 * GET /api/google/oauth/callback
 *
 * Google redirects here with `code` + `state`. We verify the state against the
 * cookie (CSRF), exchange the code for tokens, and store the sealed refresh
 * token against the auth-brain user. Always ends in a redirect back to the
 * dashboard with a `google=connected|error` flag the UI can surface; the state
 * cookie is cleared either way.
 */
export async function GET(req: NextRequest) {
  const origin = publicOrigin(req);
  const back = (ok: boolean, reason?: string) => {
    const dest = new URL('/app/dashboard', origin);
    dest.searchParams.set('google', ok ? 'connected' : 'error');
    if (reason) dest.searchParams.set('reason', reason);
    const res = NextResponse.redirect(dest.toString());
    res.cookies.set(OAUTH_STATE_COOKIE, '', { maxAge: 0, path: '/' });
    return res;
  };

  const session = await auth.getSession();
  if (!session) return back(false, 'unauthenticated');

  const url = new URL(req.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const oauthError = url.searchParams.get('error');
  const cookieState = req.cookies.get(OAUTH_STATE_COOKIE)?.value;

  if (oauthError) return back(false, oauthError);
  if (!code || !state || !cookieState || state !== cookieState) return back(false, 'state_mismatch');

  try {
    const client = loadGoogleOAuthClient();
    const tokens = await exchangeCodeForTokens({
      code,
      clientId: client.clientId,
      clientSecret: client.clientSecret,
      redirectUri: redirectUriFor(req),
    });
    // Without a refresh token we can't mint access tokens later. Google only
    // omits it if the user previously consented without revoking; prompt=consent
    // on /start forces its return, so this is a real error worth surfacing.
    if (!tokens.refresh_token) return back(false, 'no_refresh_token');

    await saveGoogleCredential({
      authUserId: session.userId,
      refreshToken: tokens.refresh_token,
      scopes: tokens.scope,
    });
    return back(true);
  } catch {
    return back(false, 'exchange_failed');
  }
}
