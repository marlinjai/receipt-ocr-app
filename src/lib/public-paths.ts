/**
 * The paths the session gate lets through without a session (src/lib/auth.ts).
 * Kept apart from the auth client so a test can read the list without its
 * settings.
 *
 * Public: the liveness probe, and the static files a browser fetches WITHOUT
 * the session cookie when it installs the app or its service worker (the
 * manifest and its icons, the worker script, the offline page). They carry no
 * data. Behind the login they answered with a redirect, which made the app
 * impossible to install to the home screen.
 * /api/internal/erasure is auth-brain's signed erasure webhook: a machine caller
 * that authenticates by HMAC over the raw body (see src/lib/erasure.ts). The
 * retention purge and the workspace move (src/lib/workspace-move.ts) are machine
 * callers of the same kind, each with its own secret, each refusing without it,
 * and so is the daily bank fetch (/api/internal/bank-sync, BANK_SYNC_SECRET).
 * /api/banking/callback is where the bank sends the person back: it checks the
 * session itself, so a session that ran out during the bank's sign-in leads to
 * the login and back to the callback instead of a bare 401 (the consent's
 * one-time state is not used up and stays valid for 30 minutes).
 */
export const PUBLIC_PATHS: readonly string[] = [
  '/api/health',
  '/api/internal/erasure',
  '/api/internal/retention/purge',
  '/api/internal/bank-sync',
  '/api/banking/callback',
  '/api/internal/workspace-move',
  '/manifest.json',
  '/icons/*',
  '/sw.js',
  '/offline.html',
];
