import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { ERASURE_SIGNATURE_HEADER } from '@/lib/erasure-signature';
import { runSpendingChecks } from '@/lib/spending/checks';
import { berlinToday } from '@/lib/spending/period';
import { bankSyncSecret } from '@/lib/tax/payments/bank/config';
import { serverBankDeps } from '@/lib/tax/payments/bank/server';
import { claimDailySync, syncAllConnections } from '@/lib/tax/payments/bank/service';
import { receiveBankSync } from '@/lib/tax/payments/bank/sync-receiver';

/**
 * The daily fetch of every active bank connection of every workspace. A
 * machine caller: listed in publicPaths (src/lib/auth.ts) and authenticated by
 * HMAC over the raw body with BANK_SYNC_SECRET. See docs/operations/bank-sync.md.
 */
export const dynamic = 'force-dynamic';

export const maxDuration = 300;


export async function POST(req: NextRequest) {
  const rawBody = await req.text();
  const deps = serverBankDeps();
  const today = berlinToday();
  const result = await receiveBankSync({
    rawBody,
    signature: req.headers.get(ERASURE_SIGNATURE_HEADER),
    secret: bankSyncSecret(),
    enabled: deps !== null,
    claim: (ts) => claimDailySync(prisma, ts),
    sync: () => syncAllConnections(prisma, deps!, { today, spendingChecks: (ctx) => runSpendingChecks(prisma, ctx, { today }) }),
  });
  return NextResponse.json(result.body, { status: result.status });
}
