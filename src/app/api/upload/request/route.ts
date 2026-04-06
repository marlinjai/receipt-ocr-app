import { NextRequest, NextResponse } from 'next/server';

const STORAGE_BRAIN_URL =
  process.env.NEXT_PUBLIC_STORAGE_BRAIN_URL || 'https://api.storage-brain.lumitra.co';

/**
 * POST /api/upload/request
 *
 * Server-side proxy that requests a presigned upload URL from Storage Brain.
 * The browser never needs the API key — it just hits this route.
 */
export async function POST(request: NextRequest) {
  const apiKey = process.env.STORAGE_BRAIN_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: 'Storage Brain API key not configured' }, { status: 500 });
  }

  const body = await request.json();
  const { fileName, fileType, fileSize, context, tags, workspaceId } = body;

  const upstream = await fetch(`${STORAGE_BRAIN_URL}/api/v1/upload/request`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      fileType,
      fileName,
      fileSizeBytes: fileSize,
      context,
      tags,
      workspaceId,
    }),
  });

  if (!upstream.ok) {
    const errorText = await upstream.text().catch(() => '');
    console.error('[upload/request] Upstream failed:', upstream.status, errorText);
    return NextResponse.json(
      { error: 'Failed to request upload from Storage Brain', details: errorText },
      { status: 502 },
    );
  }

  const data = await upstream.json();
  return NextResponse.json(data);
}
