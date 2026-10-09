import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { purgeExpiredRetainedGuests } from '@/lib/erasure';
import { receiveRetentionPurge } from '@/lib/retention-purge';
import { ERASURE_SIGNATURE_HEADER } from '@/lib/erasure-signature';

/**
 * Scheduled purge of held printed guest copies whose retention period has passed.
 * A machine caller: listed in publicPaths (src/lib/auth.ts) and authenticated by
 * HMAC over the raw body with RETENTION_PURGE_SECRET.
 */
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const rawBody = await req.text();
  const result = await receiveRetentionPurge({
    rawBody,
    signature: req.headers.get(ERASURE_SIGNATURE_HEADER),
    secret: process.env.RETENTION_PURGE_SECRET,
    purge: () => purgeExpiredRetainedGuests(prisma),
  });
  return NextResponse.json(result.body, { status: result.status });
}
