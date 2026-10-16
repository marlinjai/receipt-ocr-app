import type { NextRequest } from 'next/server';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { NotifyServiceError, replacePushSubscription } from '@/lib/spending/notify/service';

export const dynamic = 'force-dynamic';

/**
 * POST /api/spending/push-renew  Body: { oldEndpoint, subscription }
 *
 * Called by the service worker when the browser gave this device a new push
 * address on its own (`pushsubscriptionchange`). The session cookie travels
 * with the worker's request; only the signed-in person's own rows with the
 * old address change, in every company they switched push on in. The new
 * subscription is checked like any other (known push service, key sizes).
 */
export async function POST(req: NextRequest) {
  const principal = await auth.verifyRequest(req);
  if (principal.kind === 'service') return Response.json({ error: 'user_session_required' }, { status: 403 });
  if (principal.kind !== 'user') return Response.json({ error: 'unauthorized' }, { status: 401 });
  const body = (await req.json().catch(() => ({}))) as { oldEndpoint?: unknown; subscription?: unknown };
  try {
    const moved = await replacePushSubscription(prisma, principal.userId, body.oldEndpoint, body.subscription);
    return Response.json({ moved });
  } catch (e) {
    if (e instanceof NotifyServiceError) return Response.json({ error: e.code }, { status: 400 });
    console.error('[spending] push renewal failed', e);
    return Response.json({ error: 'failed' }, { status: 500 });
  }
}
