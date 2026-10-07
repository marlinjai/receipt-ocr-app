import type { NextRequest } from 'next/server';

/**
 * /share-target is normally answered by the service worker, which takes the
 * shared files into the capture queue. A request only reaches the server when
 * the worker does not control the page yet (first run after installing, or the
 * worker was withdrawn). The files cannot be kept from here, so instead of
 * dropping them silently the browser is sent to the app with a message that
 * says what happened and how to retry.
 */
function toApp(req: NextRequest, shared: string) {
  return Response.redirect(new URL(`/app?shared=${shared}`, req.url), 303);
}

export async function POST(req: NextRequest) {
  return toApp(req, 'unavailable');
}

export async function GET(req: NextRequest) {
  return Response.redirect(new URL('/app', req.url), 307);
}
