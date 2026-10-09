import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { eraseCompanyContacts, receiveErasureDelivery } from '@/lib/erasure';
import { ERASURE_SIGNATURE_HEADER } from '@/lib/erasure-signature';

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
    erase: (tenantId, workspaceIds) => eraseCompanyContacts(prisma, tenantId, workspaceIds),
  });
  return NextResponse.json(result.body, { status: result.status });
}
