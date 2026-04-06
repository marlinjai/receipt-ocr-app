import { NextRequest, NextResponse } from 'next/server';

const STORAGE_BRAIN_URL =
  process.env.NEXT_PUBLIC_STORAGE_BRAIN_URL || 'https://api.storage-brain.lumitra.co';

/**
 * GET /api/upload/complete/:fileId
 *
 * Server-side proxy that fetches file info from Storage Brain after upload.
 * The browser never needs the API key — it just hits this route.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ fileId: string }> },
) {
  const { fileId } = await params;

  const apiKey = process.env.STORAGE_BRAIN_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: 'Storage Brain API key not configured' }, { status: 500 });
  }

  const upstream = await fetch(`${STORAGE_BRAIN_URL}/api/v1/files/${fileId}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });

  if (!upstream.ok) {
    const errorText = await upstream.text().catch(() => '');
    console.error('[upload/complete] Upstream failed:', upstream.status, errorText);
    return NextResponse.json(
      { error: 'Failed to fetch file info from Storage Brain', details: errorText },
      { status: 502 },
    );
  }

  const data = await upstream.json();
  return NextResponse.json(data);
}
