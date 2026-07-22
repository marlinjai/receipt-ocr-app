import { NextRequest, NextResponse } from 'next/server';
import type { AppSession } from '@marlinjai/auth-brain-nextjs';
import { Prisma } from '@prisma/client';
import { auth } from '@/lib/auth';
import { sessionWorkspaceId } from '@/lib/auth-workspace';
import { prisma } from '@/lib/prisma';
import { sanitizeSelectionDef } from '@/lib/overview/selection';

export const dynamic = 'force-dynamic';

/**
 * Saved overview selections (named time-frame/filter/pick definitions).
 *   POST   { id?, name, definition } — create, or update when `id` is given
 *   DELETE { id }                    — remove
 * Both return the workspace's refreshed selection list. Workspace-scoped: an id
 * from another workspace is a 404 (the where clause carries the workspace).
 */

async function gate(): Promise<AppSession | NextResponse> {
  try {
    return await auth.requireAction('receipts.row.write');
  } catch (e) {
    return NextResponse.json({ error: 'forbidden' }, { status: (e as { status?: number }).status ?? 403 });
  }
}

async function list(workspaceId: string) {
  return prisma.overviewSelection.findMany({
    where: { authWorkspaceId: workspaceId },
    orderBy: { name: 'asc' },
    select: { id: true, name: true, definition: true },
  });
}

export async function POST(req: NextRequest) {
  const principal = await gate();
  if (principal instanceof NextResponse) return principal;
  const ws = sessionWorkspaceId(principal);

  const body = (await req.json().catch(() => ({}))) as { id?: unknown; name?: unknown; definition?: unknown };
  const name = typeof body.name === 'string' ? body.name.trim().slice(0, 80) : '';
  if (!name) return NextResponse.json({ error: 'name_required' }, { status: 400 });
  const definition = sanitizeSelectionDef(body.definition) as Prisma.InputJsonValue;

  try {
    if (typeof body.id === 'string' && body.id) {
      const { count } = await prisma.overviewSelection.updateMany({
        where: { id: body.id, authWorkspaceId: ws },
        data: { name, definition },
      });
      if (count === 0) return NextResponse.json({ error: 'not_found' }, { status: 404 });
    } else {
      await prisma.overviewSelection.upsert({
        where: { authWorkspaceId_name: { authWorkspaceId: ws, name } },
        create: { authWorkspaceId: ws, name, definition },
        update: { definition },
      });
    }
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
      return NextResponse.json({ error: 'name_taken' }, { status: 409 });
    }
    throw e;
  }
  return NextResponse.json({ ok: true, selections: await list(ws) });
}

export async function DELETE(req: NextRequest) {
  const principal = await gate();
  if (principal instanceof NextResponse) return principal;
  const ws = sessionWorkspaceId(principal);

  const body = (await req.json().catch(() => ({}))) as { id?: unknown };
  if (typeof body.id !== 'string' || !body.id) return NextResponse.json({ error: 'id_required' }, { status: 400 });
  await prisma.overviewSelection.deleteMany({ where: { id: body.id, authWorkspaceId: ws } });
  return NextResponse.json({ ok: true, selections: await list(ws) });
}
