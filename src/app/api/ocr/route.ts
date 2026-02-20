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
  const { fileUrl } = await request.json();

  if (!fileUrl || typeof fileUrl !== 'string') {
    return NextResponse.json({ error: 'fileUrl is required' }, { status: 400 });
  }

  const apiKey = process.env.GOOGLE_CLOUD_VISION_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: 'OCR service not configured' }, { status: 500 });
  }

  // Fetch the image from Storage Brain
  const imageResponse = await fetch(fileUrl);
  if (!imageResponse.ok) {
    return NextResponse.json({ error: 'Failed to fetch image' }, { status: 502 });
  }

  const imageBuffer = await imageResponse.arrayBuffer();
  const base64Image = Buffer.from(imageBuffer).toString('base64');

  // Call Google Cloud Vision
  const visionUrl = `https://vision.googleapis.com/v1/images:annotate?key=${apiKey}`;
  const visionPayload = {
    requests: [
      {
        image: { content: base64Image },
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
    return NextResponse.json(
      { error: 'Vision API request failed', details: errorText },
      { status: 502 }
    );
  }

  const visionData: VisionResponse = await visionResponse.json();
  const ocrResult = visionToOcrResult(visionData);

  return NextResponse.json(ocrResult);
}
