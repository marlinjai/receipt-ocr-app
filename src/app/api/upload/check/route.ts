import type { NextRequest } from 'next/server';
import { auth } from '@/lib/auth';
import { sessionWorkspaceId } from '@/lib/auth-workspace';
import { prisma } from '@/lib/prisma';
import { findFileDuplicate } from '@/lib/upload/duplicates';
import { isSha256Hex } from '@/lib/upload/hash';

export const dynamic = 'force-dynamic';

/**
 * POST /api/upload/check  Body: { sha256 }
 *
 * Asked by the uploader BEFORE it uploads anything: is a file with exactly
 * these bytes already attached to a receipt of the active workspace? The
 * workspace comes from the session; a match in another workspace is never
 * reported.
 */
export async function POST(req: NextRequest) {
  const principal = await auth.verifyRequest(req);
  if (principal.kind === 'service') {
    return Response.json({ error: 'user_session_required' }, { status: 403 });
  }
  if (principal.kind !== 'user') {
    return Response.json({ error: 'unauthorized' }, { status: 401 });
  }
  const body = (await req.json().catch(() => ({}))) as { sha256?: unknown };
  if (!isSha256Hex(body.sha256)) {
    return Response.json({ error: 'invalid_hash' }, { status: 400 });
  }
  try {
    const duplicate = await findFileDuplicate(prisma, sessionWorkspaceId(principal), body.sha256);
    return Response.json({ duplicate });
  } catch (e) {
    console.error('[upload/check] duplicate lookup failed', e);
    return Response.json({ error: 'check_failed' }, { status: 500 });
  }
}
