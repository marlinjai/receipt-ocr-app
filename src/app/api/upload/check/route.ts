import type { NextRequest } from 'next/server';
import { auth } from '@/lib/auth';
import { membershipLabel, requestedUploadWorkspace } from '@/lib/auth-workspace';
import { prisma } from '@/lib/prisma';
import { findFileCopies } from '@/lib/upload/duplicates';
import { isSha256Hex } from '@/lib/upload/hash';

export const dynamic = 'force-dynamic';

/**
 * POST /api/upload/check  Body: { sha256, workspaceId }
 *
 * Asked by the uploader BEFORE it uploads anything:
 *  - `duplicate`: a receipt of the workspace the upload is FOR (named by the
 *    upload, checked against the session's memberships) already holds exactly
 *    these bytes. The uploader stops and asks.
 *  - `elsewhere`: the names of the session's OTHER companies that hold the
 *    same file. Only names: no receipt, no row id. A copy in a workspace the
 *    session is not a member of is never looked at.
 */
export async function POST(req: NextRequest) {
  const principal = await auth.verifyRequest(req);
  if (principal.kind === 'service') {
    return Response.json({ error: 'user_session_required' }, { status: 403 });
  }
  if (principal.kind !== 'user') {
    return Response.json({ error: 'unauthorized' }, { status: 401 });
  }
  const body = (await req.json().catch(() => ({}))) as { sha256?: unknown; workspaceId?: unknown };
  if (!isSha256Hex(body.sha256)) {
    return Response.json({ error: 'invalid_hash' }, { status: 400 });
  }
  const workspaceId = requestedUploadWorkspace(principal, body.workspaceId);
  if (!workspaceId) {
    return Response.json({ error: 'workspace_not_allowed' }, { status: 403 });
  }
  const others = principal.memberships.filter((m) => m.id !== workspaceId);
  try {
    const copies = await findFileCopies(prisma, body.sha256, [workspaceId, ...others.map((m) => m.id)]);
    const elsewhere = others
      .filter((m) => copies.has(m.id))
      .map((m) => membershipLabel(m, principal.memberships))
      .sort((a, b) => a.localeCompare(b, 'de'));
    return Response.json({ duplicate: copies.get(workspaceId) ?? null, elsewhere });
  } catch (e) {
    console.error('[upload/check] duplicate lookup failed', e);
    return Response.json({ error: 'check_failed' }, { status: 500 });
  }
}
