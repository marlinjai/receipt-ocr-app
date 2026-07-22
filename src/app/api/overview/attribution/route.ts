import { NextRequest, NextResponse } from 'next/server';
import type { AppSession } from '@marlinjai/auth-brain-nextjs';
import { auth } from '@/lib/auth';
import { sessionWorkspaceId } from '@/lib/auth-workspace';
import { setAttribution, applyAttributionToLedger, type VendorShare } from '@/lib/overview/attribution';

export const dynamic = 'force-dynamic';

/**
 * POST /api/overview/attribution
 * Body: { rules: {vendor,share}[], defaultShare: number, apply?: boolean }
 * Saves the workspace attribution config; when `apply` is set, also writes the
 * resolved share onto every matching ledger row's Business Share %.
 */
export async function POST(req: NextRequest) {
  let principal: AppSession;
  try {
    principal = await auth.requireAction('receipts.row.write');
  } catch (e) {
    return NextResponse.json({ error: 'forbidden' }, { status: (e as { status?: number }).status ?? 403 });
  }

  const ws = sessionWorkspaceId(principal);
  const body = (await req.json().catch(() => ({}))) as { rules?: unknown; defaultShare?: unknown; apply?: unknown };
  const rules: VendorShare[] = Array.isArray(body.rules)
    ? body.rules
        .map((r) => ({ vendor: String((r as { vendor?: unknown }).vendor ?? ''), share: Number((r as { share?: unknown }).share) }))
        .filter((r) => r.vendor.trim() && Number.isFinite(r.share))
    : [];
  const defaultShare = Number.isFinite(Number(body.defaultShare)) ? Number(body.defaultShare) : 100;

  await setAttribution(ws, rules, defaultShare);
  const applied = body.apply ? await applyAttributionToLedger(ws) : 0;
  return NextResponse.json({ ok: true, applied });
}
