import { NextRequest, NextResponse } from 'next/server';
import { fileReferenceOpenToRequest, guardFileAccess } from '@/lib/file-access';
import { prisma } from '@/lib/prisma';
import { parseRotation } from '@/lib/meals/viewer-state';
import { servedFileHeaders } from '@/lib/files/served-file-headers';
import { RenditionError, canRotate, inlineDisposition, renditionName, rotatedRendition } from '@/lib/files/rotated-rendition';

const STORAGE_BRAIN_URL =
  process.env.NEXT_PUBLIC_STORAGE_BRAIN_URL || 'https://storage-brain-api.marlin-pohl.workers.dev';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Bumped whenever the turned copy is made differently, so no browser keeps an old one. */
const RENDITION_VERSION = 'v1';

/**
 * GET /api/files/:fileId
 *
 * Server-side proxy that streams a file from Storage Brain using Bearer auth.
 * The browser never needs the API key: it just hits this route.
 *
 * Without a query the stored file is streamed exactly as it is (the viewer
 * itself and every other caller load it that way).
 *
 * With `?ref=<file reference id>` the receipt is shown the way the viewer
 * shows it: the rotation stored on that file reference is read here, on every
 * request, and a turned copy is made in memory (see rotated-rendition.ts). The
 * link carries which reference, never the angle, so it cannot show an old
 * rotation. `&original=1` always gives the stored file untouched.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ fileId: string }> },
) {
  const { fileId } = await params;

  // Cross-company isolation: only members of a workspace referencing this
  // file (or service callers) may pull the bytes.
  const denied = await guardFileAccess(request, fileId);
  if (denied) return denied;

  const query = new URL(request.url).searchParams;
  const refId = query.get('ref');
  if (refId !== null && query.get('original') !== '1') {
    return turnedFile(request, fileId, refId);
  }

  const apiKey = process.env.STORAGE_BRAIN_API_KEY;
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
      'Cache-Control': 'private, max-age=86400',
      // An uploaded file must not run anything on this domain (an XML or SVG file can).
      ...servedFileHeaders(contentType),
    },
  });
}

/**
 * The receipt turned by the rotation stored on reference `refId`. Access to
 * the file was already checked; the reference must belong to this very file
 * and to a workspace the caller may read.
 */
async function turnedFile(request: NextRequest, fileId: string, refId: string): Promise<NextResponse> {
  if (!UUID_RE.test(refId)) {
    return NextResponse.json({ error: 'invalid file reference' }, { status: 400 });
  }
  try {
    return await turnedFileFor(request, fileId, refId);
  } catch (e) {
    // The database or the file store failed on the way: the tab says so instead of a bare server error.
    console.error(`[files] the turned copy of file ${fileId} could not be served`, e);
    return turnFailedPage(fileId, 500);
  }
}

async function turnedFileFor(request: NextRequest, fileId: string, refId: string): Promise<NextResponse> {
  const ref = await prisma.dtFile.findUnique({
    where: { id: refId },
    select: { fileId: true, rowId: true, originalName: true, mimeType: true, metadata: true },
  });
  // Same answer as an unknown file, so a reference of another file, or of
  // another company's row, tells nothing.
  if (!ref || ref.fileId !== fileId || !(await fileReferenceOpenToRequest(request, ref.rowId))) {
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }

  const stored = parseRotation((ref.metadata as Record<string, unknown> | null)?.rotation);
  // The stored file never changes under its id, so the reference, the file and
  // the stored rotation name the answer completely. The browser asks again
  // every time (no-cache) and gets a 304 while the rotation is unchanged.
  const etag = `"${RENDITION_VERSION}-${fileId}-${refId}-${stored ?? 'auto'}"`;
  const caching = { 'Cache-Control': 'private, no-cache', ETag: etag };
  if (ifNoneMatch(request, etag)) {
    return new NextResponse(null, { status: 304, headers: caching });
  }

  const apiKey = process.env.STORAGE_BRAIN_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: 'Storage Brain API key not configured' }, { status: 500 });
  }
  const upstream = await fetch(`${STORAGE_BRAIN_URL}/api/v1/files/${fileId}/download`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!upstream.ok) {
    return new NextResponse(upstream.statusText, { status: upstream.status });
  }
  // The store may answer with a generic type; the reference knows what was uploaded.
  const upstreamType = upstream.headers.get('Content-Type') ?? '';
  const mimeType = canRotate(upstreamType) ? upstreamType : ref.mimeType;
  const bytes = new Uint8Array(await upstream.arrayBuffer());

  // A kind of file that cannot be turned (none the upload accepts): as it is
  // when nothing was turned, and said so when a stored rotation would be lost.
  if (!canRotate(mimeType)) {
    if (stored) {
      console.error(`[files] file ${fileId} is turned by ${stored} degrees but its type cannot be turned`);
      return turnFailedPage(fileId, 422);
    }
    return fileResponse(bytes, upstreamType || 'application/octet-stream', renditionName(ref.originalName, { kind: 'original', rotation: 0 }), caching);
  }

  try {
    const rendition = await rotatedRendition(bytes, mimeType, stored);
    if (rendition.kind === 'original') {
      return fileResponse(bytes, mimeType, renditionName(ref.originalName, rendition), caching);
    }
    return fileResponse(rendition.bytes, 'application/pdf', renditionName(ref.originalName, rendition), caching);
  } catch (e) {
    // A file that cannot be turned (encrypted, broken, mirrored photo) is a
    // known refusal (422); anything else is a fault of ours (500).
    const known = e instanceof RenditionError;
    console.error(`[files] the turned copy of file ${fileId} could not be made (${known ? e.code : 'unexpected'})`, e);
    return turnFailedPage(fileId, known ? 422 : 500);
  }
}

function ifNoneMatch(request: NextRequest, etag: string): boolean {
  const header = request.headers?.get('if-none-match');
  if (!header) return false;
  return header.split(',').some((tag) => tag.trim().replace(/^W\//, '') === etag);
}

function fileResponse(bytes: Uint8Array, contentType: string, name: string, caching: Record<string, string>): NextResponse {
  return new NextResponse(bytes as unknown as BodyInit, {
    status: 200,
    headers: {
      'Content-Type': contentType,
      'Content-Disposition': inlineDisposition(name),
      ...caching,
      ...servedFileHeaders(contentType),
    },
  });
}

/**
 * The turned copy could not be made: say so in the tab that was opened, and
 * offer the stored file as it is. Never the unturned file as if it were turned.
 */
function turnFailedPage(fileId: string, status: 422 | 500): NextResponse {
  const original = `/api/files/${encodeURIComponent(fileId)}`;
  const html = `<!doctype html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Beleg konnte nicht gedreht werden</title>
<style>
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #0d0d12; color: #e8e6e3; font: 16px/1.5 system-ui, sans-serif; }
  main { max-width: 32rem; padding: 2rem 1.5rem; }
  a { color: #e2a348; }
</style>
</head>
<body>
<main>
<h1 style="font-size:1.125rem">Die gedrehte Ansicht konnte nicht erzeugt werden.</h1>
<p>Die Datei ist unverändert gespeichert. Sie können sie so öffnen, wie sie hochgeladen wurde.</p>
<p><a href="${original}">Beleg ungedreht öffnen</a></p>
</main>
</body>
</html>`;
  return new NextResponse(html, {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}
