import { NextRequest, NextResponse } from 'next/server';
import type { OcrResult, OcrBlock } from '@/lib/ocr-types';

interface VisionTextAnnotation {
  description: string;
  boundingPoly?: {
    vertices: Array<{ x?: number; y?: number }>;
  };
  confidence?: number;
}

interface VisionResponse {
  responses: Array<{
    textAnnotations?: VisionTextAnnotation[];
    fullTextAnnotation?: {
      text: string;
      pages?: Array<{
        confidence?: number;
      }>;
    };
    error?: { message: string };
  }>;
}

function visionToOcrResult(visionResponse: VisionResponse): OcrResult {
  const response = visionResponse.responses[0];

  if (response.error) {
    throw new Error(`Vision API error: ${response.error.message}`);
  }

  const fullText = response.fullTextAnnotation?.text ?? '';
  const confidence = response.fullTextAnnotation?.pages?.[0]?.confidence ?? 0;

  // Skip first annotation (it's the full text), rest are individual words/blocks
  const annotations = response.textAnnotations?.slice(1) ?? [];

  const blocks: OcrBlock[] = annotations.map((a) => {
    const vertices = a.boundingPoly?.vertices ?? [];
    const xs = vertices.map((v) => v.x ?? 0);
    const ys = vertices.map((v) => v.y ?? 0);
    const minX = Math.min(...xs);
    const minY = Math.min(...ys);
    const maxX = Math.max(...xs);
    const maxY = Math.max(...ys);

    return {
      text: a.description,
      boundingBox: {
        x: minX,
        y: minY,
        width: maxX - minX,
        height: maxY - minY,
      },
      confidence: a.confidence ?? confidence,
    };
  });

  return { fullText, blocks, confidence };
}

export async function POST(request: NextRequest) {
  const body = await request.json();

  // Accept either fileId (preferred) or fileUrl (legacy)
  const fileId: string | undefined = body.fileId;
  const fileUrl: string | undefined = body.fileUrl;

  if (!fileId && !fileUrl) {
    return NextResponse.json({ error: 'fileId or fileUrl is required' }, { status: 400 });
  }

  const visionApiKey = process.env.GOOGLE_CLOUD_VISION_API_KEY;
  if (!visionApiKey) {
    return NextResponse.json({ error: 'OCR service not configured' }, { status: 500 });
  }

  const storageBrainBaseUrl = process.env.NEXT_PUBLIC_STORAGE_BRAIN_URL || 'https://storage-brain-api.marlin-pohl.workers.dev';
  const storageBrainApiKey = process.env.NEXT_PUBLIC_STORAGE_BRAIN_API_KEY;

  // Build the correct download URL:
  // The Storage Brain download route is GET /api/v1/files/:fileId/download
  // The `url` field from the SDK is broken (uses a non-existent route pattern),
  // so we always construct from fileId when available.
  let downloadUrl: string;
  if (fileId) {
    downloadUrl = `${storageBrainBaseUrl}/api/v1/files/${fileId}/download`;
  } else if (fileUrl!.startsWith('http')) {
    downloadUrl = fileUrl!;
  } else {
    downloadUrl = `${storageBrainBaseUrl}${decodeURIComponent(fileUrl!)}`;
  }

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

  let ocrResult: OcrResult;

  if (isPdf) {
    // PDFs require the files:annotate (batch) endpoint or async, but single-page PDFs
    // work with files:annotate. For simplicity, use the files:annotate endpoint.
    const filesUrl = `https://vision.googleapis.com/v1/files:annotate?key=${visionApiKey}`;
    const filesPayload = {
      requests: [
        {
          inputConfig: {
            content: base64Content,
            mimeType: 'application/pdf',
          },
          features: [{ type: 'DOCUMENT_TEXT_DETECTION' }],
          pages: [1, 2, 3, 4, 5],
        },
      ],
    };

    const visionResponse = await fetch(filesUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(filesPayload),
    });

    if (!visionResponse.ok) {
      const errorText = await visionResponse.text();
      console.error('[OCR] Vision API (PDF) failed:', visionResponse.status, errorText);
      return NextResponse.json(
        { error: 'Vision API request failed', details: errorText },
        { status: 502 },
      );
    }

    const visionData = await visionResponse.json();
    // files:annotate returns { responses: [{ responses: [per-page] }] }
    const pagesResponses = visionData.responses?.[0]?.responses ?? [];
    const allText: string[] = [];
    const allBlocks: OcrBlock[] = [];
    let avgConfidence = 0;
    let pageCount = 0;

    for (const pageResp of pagesResponses) {
      const fullText = pageResp.fullTextAnnotation?.text ?? '';
      const pageConf = pageResp.fullTextAnnotation?.pages?.[0]?.confidence ?? 0;
      if (fullText) {
        allText.push(fullText);
        avgConfidence += pageConf;
        pageCount++;
      }
      const annotations = pageResp.textAnnotations?.slice(1) ?? [];
      for (const a of annotations) {
        const vertices = a.boundingPoly?.vertices ?? [];
        const xs = vertices.map((v: { x?: number }) => v.x ?? 0);
        const ys = vertices.map((v: { y?: number }) => v.y ?? 0);
        allBlocks.push({
          text: a.description,
          boundingBox: {
            x: Math.min(...xs),
            y: Math.min(...ys),
            width: Math.max(...xs) - Math.min(...xs),
            height: Math.max(...ys) - Math.min(...ys),
          },
          confidence: a.confidence ?? pageConf,
        });
      }
    }

    ocrResult = {
      fullText: allText.join('\n'),
      blocks: allBlocks,
      confidence: pageCount > 0 ? avgConfidence / pageCount : 0,
    };
  } else {
    // Images: use standard images:annotate
    const visionUrl = `https://vision.googleapis.com/v1/images:annotate?key=${visionApiKey}`;
    const visionPayload = {
      requests: [
        {
          image: { content: base64Content },
          features: [{ type: 'DOCUMENT_TEXT_DETECTION' }],
        },
      ],
    };

    const visionResponse = await fetch(visionUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(visionPayload),
    });

    if (!visionResponse.ok) {
      const errorText = await visionResponse.text();
      console.error('[OCR] Vision API failed:', visionResponse.status, errorText);
      return NextResponse.json(
        { error: 'Vision API request failed', details: errorText },
        { status: 502 },
      );
    }

    const visionData: VisionResponse = await visionResponse.json();
    ocrResult = visionToOcrResult(visionData);
  }

  return NextResponse.json(ocrResult);
}
