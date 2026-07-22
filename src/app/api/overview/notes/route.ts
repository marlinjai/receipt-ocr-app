import { NextRequest, NextResponse } from 'next/server';
import type { AppSession } from '@marlinjai/auth-brain-nextjs';
import { auth } from '@/lib/auth';
import { sessionWorkspaceId } from '@/lib/auth-workspace';
import { setNotes } from '@/lib/overview/notes';

export const dynamic = 'force-dynamic';

/** POST /api/overview/notes  Body: { body: string } — save the overview notes. */
export async function POST(req: NextRequest) {
  let principal: AppSession;
  try {
    principal = await auth.requireAction('receipts.row.write');
  } catch (e) {
    return NextResponse.json({ error: 'forbidden' }, { status: (e as { status?: number }).status ?? 403 });
  }
  const body = (await req.json().catch(() => ({}))) as { body?: unknown };
  await setNotes(sessionWorkspaceId(principal), String(body.body ?? ''));
  return NextResponse.json({ ok: true });
}
