import type { NextRequest } from 'next/server';
import { auth } from '@/lib/auth';
import { sessionWorkspaceId, workspaceLabel } from '@/lib/auth-workspace';
import { prisma } from '@/lib/prisma';
import { registerExport } from '@/lib/meals/register-export';
import { getTaxSettings, loadMealRecords } from '@/lib/meals/service';
import type { MealFile } from '@/lib/meals/types';

export const dynamic = 'force-dynamic';

const STORAGE_BRAIN_URL =
  process.env.NEXT_PUBLIC_STORAGE_BRAIN_URL || 'https://api.storage-brain.lumitra.co';

/**
 * GET /api/meals/register?year=2025&format=csv|pdf[&ack=N]
 *
 * The business-meal register of one year for the session's ACTIVE workspace.
 * The workspace comes from the verified session only; nothing in the query can
 * select another one. A service-token caller has no workspace to scope to and
 * is refused.
 *
 * 409 `setting_missing`: the section 19 question is unanswered.
 * 409 `incomplete_unacknowledged`: there are N incomplete entries and the
 * request did not acknowledge exactly N (`ack=N`).
 */
export async function GET(req: NextRequest) {
  const principal = await auth.verifyRequest(req);
  if (principal.kind === 'service') {
    return Response.json({ error: 'user_session_required' }, { status: 403 });
  }
  if (principal.kind !== 'user') {
    return Response.json({ error: 'unauthorized' }, { status: 401 });
  }

  const active = principal.activeWorkspace;
  const label = active ? active.tenantName || workspaceLabel(active.slug) : 'Development';

  async function loadFile(file: MealFile) {
    const apiKey = process.env.STORAGE_BRAIN_API_KEY;
    if (!apiKey) return null;
    const res = await fetch(`${STORAGE_BRAIN_URL}/api/v1/files/${file.fileId}/download`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!res.ok) {
      console.error('[meals/register] receipt download failed', file.fileId, res.status);
      return null;
    }
    return {
      bytes: new Uint8Array(await res.arrayBuffer()),
      mimeType: res.headers.get('content-type') ?? file.mimeType,
    };
  }

  try {
    const result = await registerExport(new URL(req.url).searchParams, {
      workspaceId: sessionWorkspaceId(principal),
      workspaceLabel: label,
      loadRecords: (workspaceId) => loadMealRecords(prisma, workspaceId),
      loadSettings: (workspaceId) => getTaxSettings(prisma, workspaceId),
      loadFile,
      now: () => new Date(),
    });
    return new Response(result.body as BodyInit, { status: result.status, headers: result.headers });
  } catch (e) {
    console.error('[meals/register] export failed', e);
    return Response.json({ error: 'export_failed' }, { status: 500 });
  }
}
