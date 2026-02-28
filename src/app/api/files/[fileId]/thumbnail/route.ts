import { NextRequest, NextResponse } from 'next/server';

/**
 * GET /api/files/:fileId/thumbnail
 *
 * Returns a PDF placeholder SVG thumbnail.
 * The actual PDF can be viewed via /api/files/:fileId.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ fileId: string }> },
) {
  // Extract the fileId so we can embed it in the SVG's data attribute
  const { fileId } = await params;

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="260" viewBox="0 0 200 260" data-file-id="${fileId}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#1e1e2e"/>
      <stop offset="100%" stop-color="#14141f"/>
    </linearGradient>
  </defs>
  <rect width="200" height="260" rx="8" fill="url(#bg)"/>
  <rect x="30" y="25" width="140" height="185" rx="4" fill="none" stroke="#333" stroke-width="1.5"/>
  <path d="M130 25 V55 H160" fill="none" stroke="#333" stroke-width="1.5" stroke-linejoin="round"/>
  <path d="M130 25 L160 55" fill="none" stroke="#333" stroke-width="1.5"/>
  <rect x="50" y="75" width="80" height="6" rx="3" fill="#2a2a3a"/>
  <rect x="50" y="90" width="100" height="6" rx="3" fill="#2a2a3a"/>
  <rect x="50" y="105" width="60" height="6" rx="3" fill="#2a2a3a"/>
  <rect x="50" y="120" width="90" height="6" rx="3" fill="#2a2a3a"/>
  <rect x="50" y="135" width="70" height="6" rx="3" fill="#2a2a3a"/>
  <text x="100" y="235" text-anchor="middle" font-family="system-ui,sans-serif" font-weight="600" font-size="16" fill="#e2a348">PDF</text>
</svg>`;

  return new NextResponse(svg, {
    status: 200,
    headers: {
      'Content-Type': 'image/svg+xml',
      'Cache-Control': 'public, max-age=86400',
    },
  });
}
