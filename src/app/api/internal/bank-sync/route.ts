import { after, NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { ERASURE_SIGNATURE_HEADER } from '@/lib/erasure-signature';
import { runSpendingChecksAfterNewPayments } from '@/lib/spending/checks';
import { berlinToday } from '@/lib/spending/period';
import { bankSyncSecret } from '@/lib/tax/payments/bank/config';
import { serverBankDeps } from '@/lib/tax/payments/bank/server';
import { claimDailySync, runSpendingChecksForLiveCompanies, syncAllConnections } from '@/lib/tax/payments/bank/service';
import { sweepMerchantKeys } from '@/lib/tax/payments/rekey';
import { receiveBankSync } from '@/lib/tax/payments/bank/sync-receiver';
import { dailyLinesBackfill } from '@/lib/line-items/backfill';
import { readReceiptLines } from '@/lib/receipt-classifier';

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
    sync: async () => {
      // Once a day, rows an older server version wrote with old counterparty keys are carried too (`rekey.ts`).
      await sweepMerchantKeys(prisma).catch((e: unknown) => console.error('[payments] the daily key sweep failed', e instanceof Error ? e.message : String(e)));
      const results = await syncAllConnections(prisma, deps!, { today });
      // The spending checks run after the answer, so the scheduler only waits for the fetches.
      // Each company with a live connection, and the companies receiving private payments of its accounts.
      // Each company is checked once in the run, also when it holds an account and receives from another.
      const done = new Set<string>();
      after(() => runSpendingChecksForLiveCompanies(results, (ctx) => runSpendingChecksAfterNewPayments(prisma, ctx, { today }, done)));
      // The daily part of the line backfill (plan 2026-10-26-receipt-line-items): a bounded run per company, after the answer.
      after(() => dailyLinesBackfill(prisma, readReceiptLines));
      // The answer names connections and counts only, never a company.
      return results.map(({ connectionId, status, added }) => ({ connectionId, status, added }));
    },
  });
  return NextResponse.json(result.body, { status: result.status });
}
