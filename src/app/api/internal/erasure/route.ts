import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { eraseCompanyContacts, receiveErasureDelivery } from '@/lib/erasure';
import { ERASURE_SIGNATURE_HEADER } from '@/lib/erasure-signature';
import { serverBankDeps } from '@/lib/tax/payments/bank/server';
import { endCompanyBankConnections } from '@/lib/tax/payments/bank/service';
import { endCompanyAccountShares } from '@/lib/tax/payments/routing';

/**
 * Receiver for auth-brain's signed `tenant.erased` webhook. This is a machine
 * caller: it is listed in publicPaths (src/lib/auth.ts), so the session gate lets
 * it through, and it authenticates by HMAC over the raw body, never by session.
 */
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  // The signature covers the exact bytes, so read the raw body before anything else.
  const rawBody = await req.text();
  const result = await receiveErasureDelivery({
    rawBody,
    signature: req.headers.get(ERASURE_SIGNATURE_HEADER),
    secret: process.env.RECEIPTS_ERASURE_WEBHOOK_SECRET,
    // An erased company's bank feed ends with it: otherwise the daily run would keep reading its account until the consent runs out.
    // An erased company also keeps nothing tied to another company's records: its account shares end, with the links that tied the two.
    erase: async (tenantId, workspaceIds) => {
      const counts = await eraseCompanyContacts(prisma, tenantId, workspaceIds);
      const bankConnections = await endCompanyBankConnections(prisma, serverBankDeps(), tenantId, workspaceIds);
      const shares = await endCompanyAccountShares(prisma, tenantId, workspaceIds);
      return { ...counts, bankConnections, accountShares: shares.shares, crossCompanyLinks: shares.links, crossCompanyRecords: shares.records };
    },
  });
  return NextResponse.json(result.body, { status: result.status });
}
