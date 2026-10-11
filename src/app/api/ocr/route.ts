import { NextRequest, NextResponse } from 'next/server';
import { guardFileAccess } from '@/lib/file-access';
import { TextRecognitionError, recognizeText } from '@/lib/text-recognition';

export async function POST(request: NextRequest) {
  const body = await request.json();

  // fileId only. The legacy fileUrl path is gone: nothing sends it anymore,
  // and fetching a caller-supplied URL with the Storage Brain bearer attached
  // was an SSRF hole.
  const fileId: string | undefined = body.fileId;

  if (!fileId) {
    return NextResponse.json({ error: 'fileId is required' }, { status: 400 });
  }

  // Cross-company isolation (also validates the id shape).
  const denied = await guardFileAccess(request, fileId);
  if (denied) return denied;

  const visionApiKey = process.env.GOOGLE_CLOUD_VISION_API_KEY;
  if (!visionApiKey) {
    return NextResponse.json({ error: 'OCR service not configured' }, { status: 500 });
  }

  const storageBrainBaseUrl = process.env.NEXT_PUBLIC_STORAGE_BRAIN_URL || 'https://storage-brain-api.marlin-pohl.workers.dev';
  const storageBrainApiKey = process.env.STORAGE_BRAIN_API_KEY;

  // Build the correct download URL:
  // The Storage Brain download route is GET /api/v1/files/:fileId/download
  // The `url` field from the SDK is broken (uses a non-existent route pattern),
  // so we always construct from fileId when available.
  const downloadUrl = `${storageBrainBaseUrl}/api/v1/files/${fileId}/download`;

  // Fetch the file from Storage Brain
  const imageResponse = await fetch(downloadUrl, {
    headers: storageBrainApiKey ? { Authorization: `Bearer ${storageBrainApiKey}` } : {},
  });

  if (!imageResponse.ok) {
    const errorBody = await imageResponse.text().catch(() => '');
    console.error('[OCR] Image fetch failed:', downloadUrl, imageResponse.status, errorBody);
    return NextResponse.json(
      { error: 'Failed to fetch image from storage', status: imageResponse.status },
      { status: 502 },
    );
  }

  const contentType = imageResponse.headers.get('content-type') ?? '';
  const isPdf = contentType.includes('pdf') || (body.fileName ?? '').toLowerCase().endsWith('.pdf');
  const imageBuffer = await imageResponse.arrayBuffer();
  const base64Content = Buffer.from(imageBuffer).toString('base64');

  try {
    return NextResponse.json(await recognizeText(base64Content, isPdf, visionApiKey));
  } catch (err) {
    if (!(err instanceof TextRecognitionError)) throw err;
    console.error('[OCR] Vision API failed:', err.status, err.details);
    return NextResponse.json({ error: 'Vision API request failed', details: err.details }, { status: 502 });
  }
}
