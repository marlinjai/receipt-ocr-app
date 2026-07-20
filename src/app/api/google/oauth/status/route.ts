import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { getGoogleConnection, disconnectGoogle } from '@/lib/sheet-import/google-credentials';

export const dynamic = 'force-dynamic';

/** GET /api/google/oauth/status — is this user's Google connected? (no token) */
export async function GET() {
  const session = await auth.getSession();
  if (!session) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const conn = await getGoogleConnection(session.userId);
  return NextResponse.json({
    connected: Boolean(conn),
    googleEmail: conn?.googleEmail ?? null,
    scopes: conn?.scopes ?? null,
  });
}

/** DELETE /api/google/oauth/status — forget this user's Google connection. */
export async function DELETE() {
  const session = await auth.getSession();
  if (!session) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  await disconnectGoogle(session.userId);
  return NextResponse.json({ ok: true });
}
