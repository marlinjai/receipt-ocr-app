import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { sessionWorkspaceId } from '@/lib/auth-workspace';
import { prisma } from '@/lib/prisma';
import { serverBankDeps } from '@/lib/tax/payments/bank/server';
import { BankServiceError, completeConsent } from '@/lib/tax/payments/bank/service';

export const dynamic = 'force-dynamic';

/**
 * GET /api/bank/callback?code&state (or ?error&state)
 *
 * Where the bank sends the person back after the consent. A signed-in session
 * with write permission is required; the state must belong to a consent of the
 * session's ACTIVE company and be unexpired (see `completeConsent`). The answer
 * is always a redirect to the payments tab with a short outcome, never data.
 */
export async function GET(req: NextRequest) {
  const deps = serverBankDeps();
  // Behind the proxy the request's own origin can be the container's; the configured return address is the public one.
  const origin = deps ? new URL(deps.redirectUrl).origin : req.nextUrl.origin;
  const back = (bank: string) => {
    const url = new URL('/app/finance', origin);
    url.searchParams.set('reiter', 'zahlungen');
    url.searchParams.set('bank', bank);
    return NextResponse.redirect(url, 303);
  };
  let workspaceId: string;
  try {
    const session = await auth.requireAction('receipts.row.write');
    workspaceId = sessionWorkspaceId(session);
  } catch (e) {
    if ((e as { status?: number })?.status === 401) {
      // Signed out on the way: the consent cannot be taken; the person starts it again after signing in.
      return back('fehler:signed_out');
    }
    return back('fehler:forbidden');
  }
  if (!deps) return back('fehler:feature_off');
  const params = req.nextUrl.searchParams;
  try {
    const { outcome } = await completeConsent(prisma, workspaceId, deps, { state: params.get('state'), code: params.get('code'), error: params.get('error') });
    return back(outcome === 'connected' ? 'verbunden' : 'konto_waehlen');
  } catch (e) {
    if (e instanceof BankServiceError) return back(`fehler:${e.detail ?? e.code}`);
    console.error('[bank] callback failed', (e as Error)?.name ?? 'error');
    return back('fehler:failed');
  }
}
