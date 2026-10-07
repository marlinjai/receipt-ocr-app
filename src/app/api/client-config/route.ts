export const dynamic = 'force-dynamic';

/**
 * GET /api/client-config
 *
 * Switches the browser reads on page load. Today one: whether the service
 * worker may run. Setting `DISABLE_SERVICE_WORKER=1` on the server and
 * restarting makes every client unregister the worker on its next page load:
 * the kill switch for a faulty worker, with no new build.
 */
export async function GET() {
  const disabled = ['1', 'true'].includes((process.env.DISABLE_SERVICE_WORKER ?? '').trim().toLowerCase());
  return Response.json({ serviceWorker: !disabled }, { headers: { 'Cache-Control': 'no-store' } });
}
