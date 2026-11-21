import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { eraseCompany } from '@/lib/company-erasure';
import { receiveErasureDelivery } from '@/lib/erasure';
import { erasureLedger } from '@/lib/erasure-ledger';
import { ERASURE_SIGNATURE_HEADER } from '@/lib/erasure-signature';
import { eraseStoredFile } from '@/lib/stored-files';
import { serverBankDeps } from '@/lib/tax/payments/bank/server';
import { endCompanyBankConnections } from '@/lib/tax/payments/bank/service';
import { endCompanyAccountShares } from '@/lib/tax/payments/routing';

/**
 * Receiver for auth-brain's signed `tenant.erased` webhook. This is a machine
 * caller: it is listed in publicPaths (src/lib/auth.ts), so the session gate lets
 * it through, and it authenticates by HMAC over the raw body, never by session.
 *
 * Auth-brain waits ten seconds for the answer and sends the delivery again when
 * none came. A company with many stored files can take longer: the run goes on
 * after the caller hung up, and the next delivery finds what is left (often
 * nothing) and answers. Hence the long limit here.
 */
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

export async function POST(req: NextRequest) {
  // The signature covers the exact bytes, so read the raw body before anything else.
  const rawBody = await req.text();
  const result = await receiveErasureDelivery({
    rawBody,
    signature: req.headers.get(ERASURE_SIGNATURE_HEADER),
    secret: process.env.RECEIPTS_ERASURE_WEBHOOK_SECRET,
    ledger: erasureLedger(prisma),
    erase: (tenantId, workspaceIds) =>
      eraseCompany(prisma, tenantId, workspaceIds, {
        deleteStoredFile: eraseStoredFile,
        // An erased company's bank feed ends with it: otherwise the daily run would keep reading its account until the consent runs out.
        endBankConnections: (tenant, workspaces) => endCompanyBankConnections(prisma, serverBankDeps(), tenant, workspaces),
        // An erased company also keeps nothing tied to another company's records: its account shares end, with the links that tied the two.
        endAccountShares: (tenant, workspaces) => endCompanyAccountShares(prisma, tenant, workspaces),
      }),
  });
  return NextResponse.json(result.body, { status: result.status });
}
