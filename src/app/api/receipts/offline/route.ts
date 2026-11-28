import { ReceiptsAuthError, requireReceiptsSession } from '@/lib/auth-guards';
import { sessionCompanyName, sessionWorkspaceId } from '@/lib/auth-workspace';
import { loadOfflineReceipts } from '@/lib/offline/snapshot';
import type { OfflineReceiptsResponse } from '@/lib/offline/receipts-db';
import { prisma } from '@/lib/prisma';
import { measurePage } from '@/lib/timing';

/**
 * GET /api/receipts/offline: the receipts of the active company as the offline page lists
 * them (plan docs/plans/2026-11-28-offline-receipts.md). The company comes from the session
 * only. 401 without a session: the app then deletes the list kept on the device; 503 when the
 * session cannot be checked (the middleware's answer to an auth outage), so the list stays.
 */
export const dynamic = 'force-dynamic';

const NO_STORE = { 'cache-control': 'no-store' };

export async function GET(): Promise<Response> {
  return measurePage('api/receipts/offline', async () => {
    let session;
    try {
      session = await requireReceiptsSession();
    } catch (e) {
      // Only a refused session says "signed out" (the app then deletes the list on the device). The
      // middleware already answers an auth outage with 503 before this route runs; anything else
      // thrown here is a 503 too, so the list stays.
      if (!(e instanceof ReceiptsAuthError)) return Response.json({ error: 'unavailable' }, { status: 503, headers: NO_STORE });
      return Response.json({ error: e.status === 401 ? 'unauthorized' : 'forbidden' }, { status: e.status === 401 ? 401 : 403, headers: NO_STORE });
    }
    const workspaceId = sessionWorkspaceId(session);
    try {
      const receipts = await loadOfflineReceipts(prisma, workspaceId);
      const body: OfflineReceiptsResponse = { workspaceId, company: sessionCompanyName(session), receipts };
      return Response.json(body, { headers: NO_STORE });
    } catch (e) {
      // Ids and reason only, never a receipt's content.
      console.error('[offline] could not read the receipts', { workspaceId, error: e instanceof Error ? e.name : 'unknown' });
      return Response.json({ error: 'read_failed' }, { status: 500, headers: NO_STORE });
    }
  });
}
