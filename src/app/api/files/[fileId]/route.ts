import { NextRequest, NextResponse } from 'next/server';

const STORAGE_BRAIN_URL =
  process.env.NEXT_PUBLIC_STORAGE_BRAIN_URL || 'https://storage-brain-api.marlin-pohl.workers.dev';

/**
 * GET /api/files/:fileId
 *
 * Server-side proxy that streams a file from Storage Brain using Bearer auth.
 * The browser never needs the API key — it just hits this route.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ fileId: string }> },
) {
  const { fileId } = await params;

  const apiKey = process.env.NEXT_PUBLIC_STORAGE_BRAIN_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: 'Storage Brain API key not configured' }, { status: 500 });
  }

  const upstream = await fetch(
    `${STORAGE_BRAIN_URL}/api/v1/files/${fileId}/download`,
    { headers: { Authorization: `Bearer ${apiKey}` } },
  );

  if (!upstream.ok) {
    return new NextResponse(upstream.statusText, { status: upstream.status });
  }

  const contentType = upstream.headers.get('Content-Type') ?? 'application/octet-stream';

  return new NextResponse(upstream.body, {
    status: 200,
    headers: {
      'Content-Type': contentType,
      'Content-Disposition': 'inline',
      'Cache-Control': 'public, max-age=86400',
    },
  });
}
