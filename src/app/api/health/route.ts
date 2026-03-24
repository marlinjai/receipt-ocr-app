import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';

/**
 * GET /api/health — used by Coolify container health check.
 *
 * Always returns 200 so Coolify marks the container as healthy once the
 * Next.js server is up. The response body still reports individual
 * dependency status for observability.
 *
 * To get a strict check that returns 503 on failure, pass ?strict=true
 * (useful for external monitoring / uptime robots).
 */
export async function GET(request: NextRequest) {
  const strict = request.nextUrl.searchParams.get('strict') === 'true';
  const checks: Record<string, 'ok' | 'error'> = {};

  try {
    await prisma.$queryRaw`SELECT 1`;
    checks.postgres = 'ok';
  } catch {
    checks.postgres = 'error';
  }

  const healthy = Object.values(checks).every((v) => v === 'ok');
  const status = healthy ? 'healthy' : 'degraded';

  return NextResponse.json(
    { status, checks, timestamp: new Date().toISOString() },
    { status: strict && !healthy ? 503 : 200 },
  );
}
