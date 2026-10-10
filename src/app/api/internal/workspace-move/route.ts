import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { moveWorkspace, receiveWorkspaceMove } from '@/lib/workspace-move';
import { ERASURE_SIGNATURE_HEADER } from '@/lib/erasure-signature';

/**
 * The receipts side of moving one workspace to another company: restamps the
 * company on every row of the workspace and moves its guest contacts, with a dry
 * run. A machine caller: listed in publicPaths (src/lib/auth.ts) and authenticated
 * by HMAC over the raw body with WORKSPACE_MOVE_SECRET. See
 * docs/operations/workspace-move.md for the order of the whole move.
 */
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  // The signature covers the exact bytes, so read the raw body before anything else.
  const rawBody = await req.text();
  const result = await receiveWorkspaceMove({
    rawBody,
    signature: req.headers.get(ERASURE_SIGNATURE_HEADER),
    secret: process.env.WORKSPACE_MOVE_SECRET,
    move: (request, apply) => moveWorkspace(prisma, request, { apply }),
  });
  return NextResponse.json(result.body, { status: result.status });
}
