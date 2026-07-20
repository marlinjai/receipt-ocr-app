import { NextRequest, NextResponse } from 'next/server';
import { randomBytes } from 'node:crypto';
import { auth } from '@/lib/auth';
import { buildAuthUrl } from '@/lib/sheet-import/google-oauth';
import { loadGoogleOAuthClient, redirectUriFor } from '@/lib/sheet-import/google-config';

export const dynamic = 'force-dynamic';

export const OAUTH_STATE_COOKIE = 'gsheet_oauth_state';

/**
 * GET /api/google/oauth/start
 *
 * Kicks off the per-user Google connection: mints a CSRF state (stored in an
 * httpOnly cookie, verified by the callback) and redirects to Google's consent
 * screen for the read-only Sheets scope. The middleware already guarantees a
 * verified receipts session on /api/*, so reaching here means the user is
 * authenticated; we only need their id/email, not another gate.
 */
export async function GET(req: NextRequest) {
  const session = await auth.getSession();
  if (!session) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  let client;
  try {
    client = loadGoogleOAuthClient();
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }

  const state = randomBytes(16).toString('base64url');
  const url = buildAuthUrl({ clientId: client.clientId, redirectUri: redirectUriFor(req), state });

  const res = NextResponse.redirect(url);
  res.cookies.set(OAUTH_STATE_COOKIE, state, {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/',
    maxAge: 600,
  });
  return res;
}
