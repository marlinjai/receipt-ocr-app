import { auth } from '@/lib/auth';

/**
 * Auth middleware for the whole app (see @marlinjai/auth-brain-nextjs).
 *
 * PAGE navigation: a verified auth-brain session with >=1 `receipts-*`
 * workspace passes; a verified session with none goes to /no-access; anything
 * else redirects to the hosted login at auth.lumitra.co with return_to.
 *
 * /api/* keeps the dual gate: a valid SERVICE_TOKEN bearer (machine callers,
 * e.g. smoke tests against /api/ocr) OR the session cookie (browser fetches,
 * same-origin, the cookie rides along). Failure is a JSON 401/500, never a
 * redirect. Public: /api/health (Coolify liveness) and /no-access.
 */

// timingSafeEqual (service-token compare) is not available on Edge.
export const runtime = 'nodejs';

export const config = {
  // Gate page navigation AND /api/*, excluding Next internals and static
  // assets (which carry no session and must not bounce to login).
  matcher: ['/((?!_next/static|_next/image|favicon.ico|robots.txt).*)'],
};

export default auth.createAuthMiddleware();
