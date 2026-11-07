import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { ERASURE_SIGNATURE_HEADER } from '@/lib/erasure-signature';
import { booksPullSecret } from '@/lib/tax/books-pull/config';
import { receiveBooksPull } from '@/lib/tax/books-pull/receiver';
import { claimBooksPull, pullBooksMirror, serverBooksPullDeps } from '@/lib/tax/books-pull/service';

/**
 * The scheduled pull of the issued invoices from framer-clone's Books into the
 * company's invoices. A machine caller: listed in publicPaths
 * (src/lib/public-paths.ts) and authenticated by HMAC over the raw body with
 * BOOKS_PULL_SECRET. See docs/operations/books-mirror.md.
 */
export const dynamic = 'force-dynamic';

export const maxDuration = 120;

export async function POST(req: NextRequest) {
  const rawBody = await req.text();
  const result = await receiveBooksPull({
    rawBody,
    signature: req.headers.get(ERASURE_SIGNATURE_HEADER),
    secret: booksPullSecret(),
    claim: (ts) => claimBooksPull(prisma, ts),
    pull: () => pullBooksMirror(prisma, serverBooksPullDeps(), { trigger: 'schedule' }),
  });
  return NextResponse.json(result.body, { status: result.status });
}
