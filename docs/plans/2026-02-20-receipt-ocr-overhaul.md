---
title: Receipt OCR App Overhaul — Implementation Plan
summary: Step-by-step implementation plan to fix the Receipt OCR app after Storage Brain v0.4.0 breaking changes, integrating Google Cloud Vision OCR, D1 persistence via data-table adapter, and Cloudflare Pages deployment.
type: plan
tags: [receipt-ocr, implementation, ocr, cloudflare-d1, opennext]
projects: [receipt-ocr-app, storage-brain, data-table]
status: draft
date: 2026-02-20
---

# Receipt OCR App Overhaul — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix the Receipt OCR app after Storage Brain v0.4.0 breaking changes — add Google Cloud Vision OCR, D1 persistence, and deploy to Cloudflare Pages via OpenNext.

**Architecture:** Upload images to Storage Brain (R2 storage), send the image URL to a Next.js API route that calls Google Cloud Vision for OCR, extract receipt fields, persist to Cloudflare D1 via the data-table D1 adapter, display in the existing data-table dashboard.

**Tech Stack:** Next.js 16, @opennextjs/cloudflare, Google Cloud Vision API, Cloudflare D1 + R2, @marlinjai/data-table-adapter-d1, @marlinjai/storage-brain-sdk v0.4.0

---

### Task 1: Update Storage Brain SDK and Fix Type Imports

**Files:**
- Modify: `projects/receipt-ocr-app/package.json`
- Modify: `projects/receipt-ocr-app/src/lib/storage.ts`

**Step 1: Update SDK version in package.json**

In `package.json`, change the storage-brain-sdk dependency:

```json
"@marlinjai/storage-brain-sdk": "^0.4.0",
```

**Step 2: Fix type imports in storage.ts**

The SDK v0.4.0 no longer exports `OcrResult`. Update `src/lib/storage.ts`:

```typescript
import { StorageBrain } from '@marlinjai/storage-brain-sdk';

export function getStorageClient() {
  const apiKey = process.env.NEXT_PUBLIC_STORAGE_BRAIN_API_KEY;

  if (!apiKey) {
    throw new Error('NEXT_PUBLIC_STORAGE_BRAIN_API_KEY is not set');
  }

  return new StorageBrain({
    apiKey,
    baseUrl: process.env.NEXT_PUBLIC_STORAGE_BRAIN_URL || 'https://storage-brain-api.marlin-pohl.workers.dev',
  });
}

export type { FileInfo, FileMetadata } from '@marlinjai/storage-brain-sdk';
```

**Step 3: Install updated dependency**

Run: `cd "projects/receipt-ocr-app" && npm install`

**Step 4: Commit**

```bash
git add projects/receipt-ocr-app/package.json projects/receipt-ocr-app/src/lib/storage.ts
git commit -m "fix: update storage-brain-sdk to v0.4.0, remove OcrResult type"
```

---

### Task 2: Define OCR Types and Adapt Field Extraction

**Files:**
- Create: `projects/receipt-ocr-app/src/lib/ocr-types.ts`
- Modify: `projects/receipt-ocr-app/src/lib/extract-receipt-fields.ts`

**Step 1: Create OCR types file**

Create `src/lib/ocr-types.ts` with the types the app needs (previously from SDK, now app-owned):

```typescript
/**
 * OCR block with bounding box — matches what our extraction logic needs.
 * Adapted from Google Cloud Vision textAnnotations format.
 */
export interface OcrBlock {
  text: string;
  boundingBox: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  confidence: number;
}

/**
 * OCR result — the common format our extraction pipeline works with.
 * The /api/ocr route converts Google Vision responses into this shape.
 */
export interface OcrResult {
  fullText: string;
  blocks: OcrBlock[];
  confidence: number;
}
```

**Step 2: Update extract-receipt-fields.ts to use local types**

Change the import on line 1 from:

```typescript
import type { OcrResult } from '@/lib/storage';
```

to:

```typescript
import type { OcrResult } from '@/lib/ocr-types';
```

No other changes needed — the `OcrResult` shape is identical to what the extraction logic already uses.

**Step 3: Verify the app still compiles**

Run: `cd "projects/receipt-ocr-app" && npx tsc --noEmit`

**Step 4: Commit**

```bash
git add projects/receipt-ocr-app/src/lib/ocr-types.ts projects/receipt-ocr-app/src/lib/extract-receipt-fields.ts
git commit -m "refactor: define app-owned OCR types, decouple from SDK"
```

---

### Task 3: Create Server-Side OCR API Route

**Files:**
- Create: `projects/receipt-ocr-app/src/app/api/ocr/route.ts`

**Step 1: Create the OCR API route**

Create `src/app/api/ocr/route.ts`:

```typescript
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
```

**Step 2: Verify compilation**

Run: `cd "projects/receipt-ocr-app" && npx tsc --noEmit`

**Step 3: Commit**

```bash
git add projects/receipt-ocr-app/src/app/api/ocr/route.ts
git commit -m "feat: add server-side OCR API route using Google Cloud Vision"
```

---

### Task 4: Update Upload Flow — ReceiptUploader + Home Page

**Files:**
- Modify: `projects/receipt-ocr-app/src/components/ReceiptUploader.tsx`
- Modify: `projects/receipt-ocr-app/src/app/page.tsx`

**Step 1: Update ReceiptUploader to call OCR after upload**

The uploader now: (1) uploads file to Storage Brain, (2) calls `/api/ocr` with the file URL, (3) returns both the file info and OCR result.

Replace the entire `ReceiptUploader.tsx`:

```typescript
'use client';

import { useState, useCallback } from 'react';
import { getStorageClient, type FileInfo } from '@/lib/storage';
import type { OcrResult } from '@/lib/ocr-types';

export interface UploadResult {
  file: FileInfo;
  ocrResult: OcrResult | null;
}

interface ReceiptUploaderProps {
  onUploadComplete: (result: UploadResult) => void;
}

export default function ReceiptUploader({ onUploadComplete }: ReceiptUploaderProps) {
  const [isDragging, setIsDragging] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [phase, setPhase] = useState<'idle' | 'uploading' | 'ocr'>('idle');
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const handleUpload = useCallback(async (file: File) => {
    setIsUploading(true);
    setPhase('uploading');
    setProgress(0);
    setError(null);

    try {
      const storage = getStorageClient();

      const result = await storage.upload(file, {
        context: 'receipt',
        tags: { source: 'receipt-ocr-app' },
        onProgress: (p) => setProgress(p),
      });

      // Now run OCR
      setPhase('ocr');
      setProgress(0);

      let ocrResult: OcrResult | null = null;
      try {
        const ocrResponse = await fetch('/api/ocr', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ fileUrl: result.url }),
        });

        if (ocrResponse.ok) {
          ocrResult = await ocrResponse.json();
        }
      } catch {
        // OCR failed but upload succeeded — continue with null OCR
      }

      onUploadComplete({ file: result, ocrResult });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setIsUploading(false);
      setPhase('idle');
      setProgress(0);
    }
  }, [onUploadComplete]);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    const file = e.dataTransfer.files[0];
    if (file) handleUpload(file);
  }, [handleUpload]);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
  }, []);

  const handleFileInput = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) handleUpload(file);
  }, [handleUpload]);

  const phaseLabel = phase === 'uploading' ? 'Uploading receipt...' : 'Running OCR...';
  const phaseDetail = phase === 'uploading' ? 'Storing file securely' : 'Extracting text with AI';

  return (
    <div className="w-full max-w-xl mx-auto">
      <div
        onDrop={handleDrop}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        className={`
          border-2 border-dashed rounded-xl p-12 text-center transition-all cursor-pointer
          ${isDragging ? 'border-blue-500 bg-blue-50' : 'border-gray-300 hover:border-gray-400 hover:bg-gray-50'}
          ${isUploading ? 'pointer-events-none opacity-60' : ''}
        `}
      >
        {isUploading ? (
          <div className="space-y-4">
            <div className="w-16 h-16 mx-auto">
              <svg className="animate-spin text-blue-500" viewBox="0 0 24 24" fill="none">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
              </svg>
            </div>
            <div>
              <p className="text-lg font-medium text-gray-700">{phaseLabel}</p>
              <p className="text-sm text-gray-500 mt-1">{phaseDetail}</p>
            </div>
            {phase === 'uploading' && (
              <>
                <div className="w-full bg-gray-200 rounded-full h-2">
                  <div
                    className="bg-blue-500 h-2 rounded-full transition-all duration-300"
                    style={{ width: `${progress}%` }}
                  />
                </div>
                <p className="text-sm text-gray-500">{progress}%</p>
              </>
            )}
          </div>
        ) : (
          <label className="cursor-pointer block">
            <input
              type="file"
              accept="image/*,application/pdf"
              onChange={handleFileInput}
              className="hidden"
            />
            <div className="space-y-4">
              <div className="w-16 h-16 mx-auto text-gray-400">
                <svg fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
                </svg>
              </div>
              <div>
                <p className="text-lg font-medium text-gray-700">Drop your receipt here</p>
                <p className="text-sm text-gray-500 mt-1">or click to browse</p>
              </div>
              <p className="text-xs text-gray-400">Supports JPG, PNG, WebP, GIF, AVIF, and PDF</p>
            </div>
          </label>
        )}
      </div>

      {error && (
        <div className="mt-4 p-4 bg-red-50 border border-red-200 rounded-lg">
          <p className="text-sm text-red-600">{error}</p>
        </div>
      )}
    </div>
  );
}
```

**Step 2: Update Home page to pass OCR result through receipt store**

Replace `src/app/page.tsx`:

```typescript
'use client';

import { useCallback } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import ReceiptUploader from '@/components/ReceiptUploader';
import type { UploadResult } from '@/components/ReceiptUploader';
import { receiptStore } from '@/lib/receipt-store';

export default function Home() {
  const router = useRouter();

  const handleUploadComplete = useCallback((result: UploadResult) => {
    receiptStore.addReceipt(result);
    router.push('/dashboard');
  }, [router]);

  return (
    <main className="min-h-screen py-12 px-4">
      <div className="max-w-4xl mx-auto">
        <div className="text-center mb-12">
          <h1 className="text-4xl font-bold text-gray-900 mb-4">Receipt OCR</h1>
          <p className="text-lg text-gray-600 max-w-2xl mx-auto">
            Upload receipts and invoices to instantly extract text using AI-powered OCR.
            Powered by{' '}
            <a href="https://github.com/marlinjai/storage-brain" target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline">
              Storage Brain
            </a>.
          </p>
          <Link href="/dashboard" className="inline-block mt-4 px-4 py-2 text-sm font-medium text-blue-600 bg-blue-50 rounded-lg hover:bg-blue-100 transition-colors">
            View Dashboard
          </Link>
        </div>

        <ReceiptUploader onUploadComplete={handleUploadComplete} />

        <footer className="mt-16 text-center text-sm text-gray-500">
          <p>
            Built with{' '}
            <a href="https://www.npmjs.com/package/@marlinjai/storage-brain-sdk" target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline">
              @marlinjai/storage-brain-sdk
            </a>
          </p>
        </footer>
      </div>
    </main>
  );
}
```

**Step 3: Update receipt-store to carry OCR data**

Replace `src/lib/receipt-store.ts`:

```typescript
import type { FileInfo } from '@/lib/storage';
import type { OcrResult } from '@/lib/ocr-types';

export interface PendingReceipt {
  file: FileInfo;
  ocrResult: OcrResult | null;
}

type Listener = (receipt: PendingReceipt) => void;

const listeners = new Set<Listener>();
const pendingReceipts: PendingReceipt[] = [];

export const receiptStore = {
  addReceipt(receipt: PendingReceipt) {
    pendingReceipts.push(receipt);
    listeners.forEach((fn) => fn(receipt));
  },

  consumePending(): PendingReceipt[] {
    return pendingReceipts.splice(0);
  },

  subscribe(fn: Listener): () => void {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
};
```

**Step 4: Commit**

```bash
git add projects/receipt-ocr-app/src/components/ReceiptUploader.tsx \
      projects/receipt-ocr-app/src/app/page.tsx \
      projects/receipt-ocr-app/src/lib/receipt-store.ts
git commit -m "feat: two-phase upload flow — Storage Brain upload then OCR via Vision API"
```

---

### Task 5: Update Dashboard to Use New Receipt Store Shape

**Files:**
- Modify: `projects/receipt-ocr-app/src/app/dashboard/page.tsx`

**Step 1: Update the ingest effect in DashboardContent**

The dashboard's `useEffect` that consumes pending receipts needs to work with the new `PendingReceipt` shape (which has `file` and `ocrResult` instead of just a `FileInfo` with `metadata.ocrData`).

In `src/app/dashboard/page.tsx`, replace the ingest `useEffect` (the one starting around line 65 with the comment "Ingest pending receipts from upload page"):

Replace lines 65-140 (the entire ingest useEffect) with:

```typescript
  // Ingest pending receipts from upload page
  useEffect(() => {
    const statusCol = columns.find((c) => c.name === 'Status');
    const categoryCol = columns.find((c) => c.name === 'Category');
    const selectCols = columns.filter((c) => c.type === 'select' || c.type === 'multi_select');

    const allOptsLoaded = selectCols.every((c) => selectOptions.has(c.id));
    if (columns.length === 0 || !allOptsLoaded) return;

    const ingest = async () => {
      const { receiptStore } = await import('@/lib/receipt-store');
      const { extractReceiptFields } = await import('@/lib/extract-receipt-fields');
      const pending = receiptStore.consumePending();

      for (const { file, ocrResult } of pending) {
        const extracted = ocrResult ? extractReceiptFields(ocrResult) : null;

        const statusOpts = statusCol ? selectOptions.get(statusCol.id) : undefined;
        const statusValue = ocrResult?.fullText
          ? statusOpts?.find((o) => o.name === 'Processed')?.id
          : statusOpts?.find((o) => o.name === 'Pending')?.id;

        const categoryOpts = categoryCol ? selectOptions.get(categoryCol.id) : undefined;
        const categoryValue = extracted?.category
          ? categoryOpts?.find((o) => o.name === extracted.category)?.id ?? null
          : null;

        const cells: Record<string, CellValue> = {};
        for (const col of columns) {
          switch (col.name) {
            case 'Name':
              cells[col.id] = extracted?.name ?? file.originalName;
              break;
            case 'Vendor':
              cells[col.id] = extracted?.vendor ?? null;
              break;
            case 'Gross':
              cells[col.id] = extracted?.gross ?? null;
              break;
            case 'Net':
              cells[col.id] = extracted?.net ?? null;
              break;
            case 'Tax Rate':
              cells[col.id] = extracted?.taxRate ?? null;
              break;
            case 'Date':
              cells[col.id] = extracted?.date ?? null;
              break;
            case 'Category':
              cells[col.id] = categoryValue;
              break;
            case 'Status':
              cells[col.id] = statusValue ?? '';
              break;
            case 'Confidence':
              cells[col.id] = ocrResult?.confidence ? Math.round(ocrResult.confidence * 100) : 0;
              break;
            case 'Receipt Image':
              cells[col.id] = file.url ?? '';
              break;
            case 'OCR Text':
              cells[col.id] = ocrResult?.fullText ?? '';
              break;
          }
        }

        await addRow({ cells });
      }
    };

    ingest();
  }, [columns, selectOptions, addRow]);
```

**Step 2: Update OcrResults component**

Replace `src/components/OcrResults.tsx` to work with the new types:

```typescript
'use client';

import type { FileInfo } from '@/lib/storage';
import type { OcrResult } from '@/lib/ocr-types';

interface OcrResultsProps {
  file: FileInfo;
  ocrResult: OcrResult | null;
  onReset: () => void;
}

export default function OcrResults({ file, ocrResult, onReset }: OcrResultsProps) {
  const hasOcrData = ocrResult && ocrResult.fullText;

  return (
    <div className="w-full max-w-4xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-semibold text-gray-900">{file.originalName}</h2>
          <p className="text-sm text-gray-500">
            Uploaded {new Date(file.createdAt).toLocaleString()}
          </p>
        </div>
        <button onClick={onReset} className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors">
          Upload Another
        </button>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
          <div className="px-4 py-3 border-b border-gray-200 bg-gray-50">
            <h3 className="font-medium text-gray-900">Preview</h3>
          </div>
          <div className="p-4">
            {file.fileType.startsWith('image/') ? (
              <img src={file.url} alt={file.originalName} className="w-full h-auto rounded-lg" />
            ) : (
              <div className="flex items-center justify-center h-48 bg-gray-100 rounded-lg">
                <div className="text-center">
                  <svg className="w-12 h-12 mx-auto text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                  </svg>
                  <p className="mt-2 text-sm text-gray-500">PDF Document</p>
                </div>
              </div>
            )}
          </div>
        </div>

        <div className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
          <div className="px-4 py-3 border-b border-gray-200 bg-gray-50 flex items-center justify-between">
            <h3 className="font-medium text-gray-900">Extracted Text</h3>
            {ocrResult?.confidence && (
              <span className="text-xs px-2 py-1 bg-green-100 text-green-700 rounded-full">
                {Math.round(ocrResult.confidence * 100)}% confidence
              </span>
            )}
          </div>
          <div className="p-4">
            {hasOcrData ? (
              <div className="space-y-4">
                <pre className="whitespace-pre-wrap text-sm text-gray-700 font-mono bg-gray-50 p-4 rounded-lg max-h-96 overflow-auto">
                  {ocrResult.fullText}
                </pre>
                <button
                  onClick={() => navigator.clipboard.writeText(ocrResult.fullText)}
                  className="w-full px-4 py-2 text-sm font-medium text-blue-600 bg-blue-50 rounded-lg hover:bg-blue-100 transition-colors"
                >
                  Copy to Clipboard
                </button>
              </div>
            ) : (
              <div className="text-center py-8">
                <svg className="w-12 h-12 mx-auto text-gray-300" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                </svg>
                <p className="mt-2 text-sm text-gray-500">No text extracted</p>
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
        <div className="px-4 py-3 border-b border-gray-200 bg-gray-50">
          <h3 className="font-medium text-gray-900">File Details</h3>
        </div>
        <div className="p-4">
          <dl className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
            <div>
              <dt className="text-gray-500">File ID</dt>
              <dd className="font-mono text-gray-900 truncate">{file.id}</dd>
            </div>
            <div>
              <dt className="text-gray-500">Type</dt>
              <dd className="text-gray-900">{file.fileType}</dd>
            </div>
            <div>
              <dt className="text-gray-500">Size</dt>
              <dd className="text-gray-900">{formatBytes(file.sizeBytes)}</dd>
            </div>
            <div>
              <dt className="text-gray-500">Status</dt>
              <dd>
                <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-700">
                  {file.processingStatus}
                </span>
              </dd>
            </div>
          </dl>
        </div>
      </div>
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}
```

**Step 3: Verify compilation**

Run: `cd "projects/receipt-ocr-app" && npx tsc --noEmit`

**Step 4: Commit**

```bash
git add projects/receipt-ocr-app/src/app/dashboard/page.tsx \
      projects/receipt-ocr-app/src/components/OcrResults.tsx
git commit -m "feat: update dashboard + OcrResults to use new OCR data flow"
```

---

### Task 6: Switch to D1 Adapter for Persistence

**Files:**
- Modify: `projects/receipt-ocr-app/package.json`
- Modify: `projects/receipt-ocr-app/src/lib/receipts-table.ts`
- Modify: `projects/receipt-ocr-app/next.config.ts`

**Step 1: Add D1 adapter dependency**

In `package.json`, replace the memory adapter with D1:

Change:
```json
"@marlinjai/data-table-adapter-memory": "file:../data-table/packages/adapter-memory",
```

To:
```json
"@marlinjai/data-table-adapter-d1": "file:../data-table/packages/adapter-d1",
"@marlinjai/data-table-adapter-memory": "file:../data-table/packages/adapter-memory",
```

Keep memory adapter as fallback for local dev without D1.

**Step 2: Update receipts-table.ts to support both adapters**

Replace `src/lib/receipts-table.ts`:

```typescript
import { MemoryAdapter } from '@marlinjai/data-table-adapter-memory';
import type { ColumnType, DatabaseAdapter } from '@marlinjai/data-table-core';

const WORKSPACE_ID = 'receipt-ocr';
const TABLE_NAME = 'Receipts';

const RECEIPT_COLUMNS: Array<{ name: string; type: ColumnType; isPrimary?: boolean }> = [
  { name: 'Name', type: 'text', isPrimary: true },
  { name: 'Vendor', type: 'text' },
  { name: 'Gross', type: 'number' },
  { name: 'Net', type: 'number' },
  { name: 'Tax Rate', type: 'number' },
  { name: 'Date', type: 'date' },
  { name: 'Category', type: 'select' },
  { name: 'Status', type: 'select' },
  { name: 'Confidence', type: 'number' },
  { name: 'Receipt Image', type: 'url' },
  { name: 'OCR Text', type: 'text' },
];

const CATEGORY_OPTIONS = ['Food', 'Travel', 'Office', 'Utilities', 'Entertainment', 'Other'];
const CATEGORY_COLORS = ['#ef4444', '#3b82f6', '#f59e0b', '#10b981', '#8b5cf6', '#6b7280'];

const STATUS_OPTIONS = ['Pending', 'Processed', 'Rejected'];
const STATUS_COLORS = ['#f59e0b', '#10b981', '#ef4444'];

// Adapter will be set at runtime — D1 when available, otherwise MemoryAdapter
let _adapter: DatabaseAdapter | null = null;

export function setAdapter(adapter: DatabaseAdapter) {
  _adapter = adapter;
}

export function getAdapter(): DatabaseAdapter {
  if (!_adapter) {
    // Fallback to memory for local dev
    _adapter = new MemoryAdapter();
  }
  return _adapter;
}

// Alias for backwards compatibility
export const dbAdapter = new Proxy({} as DatabaseAdapter, {
  get(_target, prop, receiver) {
    return Reflect.get(getAdapter(), prop, receiver);
  },
});

let initPromise: Promise<string> | null = null;

export function getReceiptsTableId(): Promise<string> {
  if (!initPromise) {
    initPromise = initializeTable();
  }
  return initPromise;
}

async function initializeTable(): Promise<string> {
  const adapter = getAdapter();

  // Check if table already exists (for D1 persistence)
  const existingTables = await adapter.listTables(WORKSPACE_ID);
  const existing = existingTables.find((t) => t.name === TABLE_NAME);
  if (existing) return existing.id;

  const table = await adapter.createTable({
    workspaceId: WORKSPACE_ID,
    name: TABLE_NAME,
  });

  const columnIds: Record<string, string> = {};

  for (const col of RECEIPT_COLUMNS) {
    const column = await adapter.createColumn({
      tableId: table.id,
      name: col.name,
      type: col.type,
      isPrimary: col.isPrimary,
    });
    columnIds[col.name] = column.id;
  }

  const categoryColId = columnIds['Category'];
  for (let i = 0; i < CATEGORY_OPTIONS.length; i++) {
    await adapter.createSelectOption({
      columnId: categoryColId,
      name: CATEGORY_OPTIONS[i],
      color: CATEGORY_COLORS[i],
    });
  }

  const statusColId = columnIds['Status'];
  for (let i = 0; i < STATUS_OPTIONS.length; i++) {
    await adapter.createSelectOption({
      columnId: statusColId,
      name: STATUS_OPTIONS[i],
      color: STATUS_COLORS[i],
    });
  }

  await adapter.createView({
    tableId: table.id,
    name: 'Table',
    type: 'table',
    isDefault: true,
  });

  await adapter.createView({
    tableId: table.id,
    name: 'Board',
    type: 'board',
    config: {
      boardConfig: {
        groupByColumnId: statusColId,
        showEmptyGroups: true,
      },
    },
  });

  await adapter.createView({
    tableId: table.id,
    name: 'Calendar',
    type: 'calendar',
    config: {
      calendarConfig: {
        dateColumnId: columnIds['Date'],
      },
    },
  });

  return table.id;
}

export { WORKSPACE_ID };
```

**Step 3: Update next.config.ts to include D1 adapter in transpile**

```typescript
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: [
    "@marlinjai/data-table-core",
    "@marlinjai/data-table-react",
    "@marlinjai/data-table-adapter-memory",
    "@marlinjai/data-table-adapter-d1",
  ],
};

export default nextConfig;
```

**Step 4: Install dependencies**

Run: `cd "projects/receipt-ocr-app" && npm install`

**Step 5: Verify compilation**

Run: `cd "projects/receipt-ocr-app" && npx tsc --noEmit`

**Step 6: Commit**

```bash
git add projects/receipt-ocr-app/package.json \
      projects/receipt-ocr-app/src/lib/receipts-table.ts \
      projects/receipt-ocr-app/next.config.ts
git commit -m "feat: add D1 adapter support with memory fallback for local dev"
```

---

### Task 7: Set Up OpenNext Cloudflare Deployment

**Files:**
- Modify: `projects/receipt-ocr-app/package.json`
- Create: `projects/receipt-ocr-app/wrangler.jsonc`
- Create: `projects/receipt-ocr-app/open-next.config.ts`
- Modify: `projects/receipt-ocr-app/next.config.ts`
- Create: `projects/receipt-ocr-app/cloudflare-env.d.ts`

**Step 1: Install OpenNext and Wrangler**

Run: `cd "projects/receipt-ocr-app" && npm install @opennextjs/cloudflare@latest && npm install -D wrangler@latest`

**Step 2: Add deployment scripts to package.json**

Add these scripts:

```json
"preview": "opennextjs-cloudflare build && opennextjs-cloudflare preview",
"deploy": "opennextjs-cloudflare build && opennextjs-cloudflare deploy",
"cf-typegen": "wrangler types --env-interface CloudflareEnv cloudflare-env.d.ts"
```

**Step 3: Create wrangler.jsonc**

```jsonc
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "receipt-ocr-app",
  "main": ".open-next/worker.js",
  "compatibility_date": "2025-12-30",
  "compatibility_flags": ["nodejs_compat"],
  "assets": {
    "directory": ".open-next/assets",
    "binding": "ASSETS"
  },
  "d1_databases": [
    {
      "binding": "DB",
      "database_name": "receipt-ocr-db",
      "database_id": "<TO_BE_CREATED>"
    }
  ],
  "vars": {
    "NEXT_PUBLIC_STORAGE_BRAIN_URL": "https://storage-brain-api.marlin-pohl.workers.dev"
  }
}
```

Note: The `database_id` will be filled in after creating the D1 database with `wrangler d1 create receipt-ocr-db`.

**Step 4: Create open-next.config.ts**

```typescript
import { defineCloudflareConfig } from "@opennextjs/cloudflare";

export default defineCloudflareConfig({});
```

**Step 5: Update next.config.ts with OpenNext dev helper**

```typescript
import type { NextConfig } from "next";
import { initOpenNextCloudflareForDev } from "@opennextjs/cloudflare";

initOpenNextCloudflareForDev();

const nextConfig: NextConfig = {
  transpilePackages: [
    "@marlinjai/data-table-core",
    "@marlinjai/data-table-react",
    "@marlinjai/data-table-adapter-memory",
    "@marlinjai/data-table-adapter-d1",
  ],
};

export default nextConfig;
```

**Step 6: Create cloudflare-env.d.ts**

```typescript
interface CloudflareEnv {
  DB: D1Database;
  ASSETS: Fetcher;
  NEXT_PUBLIC_STORAGE_BRAIN_API_KEY: string;
  NEXT_PUBLIC_STORAGE_BRAIN_URL: string;
  GOOGLE_CLOUD_VISION_API_KEY: string;
}
```

**Step 7: Add .open-next to .gitignore**

Append `.open-next` to the project's `.gitignore` (create one if it doesn't exist).

**Step 8: Remove Vercel config**

Run: `rm -rf "projects/receipt-ocr-app/.vercel"`

**Step 9: Commit**

```bash
git add projects/receipt-ocr-app/package.json \
      projects/receipt-ocr-app/wrangler.jsonc \
      projects/receipt-ocr-app/open-next.config.ts \
      projects/receipt-ocr-app/next.config.ts \
      projects/receipt-ocr-app/cloudflare-env.d.ts \
      projects/receipt-ocr-app/.gitignore
git rm -r --cached projects/receipt-ocr-app/.vercel 2>/dev/null || true
git commit -m "feat: configure OpenNext Cloudflare deployment with D1 binding"
```

---

### Task 8: Wire D1 Adapter in Dashboard via Cloudflare Context

**Files:**
- Modify: `projects/receipt-ocr-app/src/app/dashboard/page.tsx`

**Step 1: Create a server component wrapper that gets D1 binding**

The dashboard page needs to obtain the D1 binding from Cloudflare context and pass it to the client. Since `getCloudflareContext` is server-only, we need a server component that initializes D1 and a client component for the interactive dashboard.

Replace the `DashboardPage` export at the bottom of `src/app/dashboard/page.tsx`:

The dashboard is a client component that uses the data-table hooks. For D1, we need to initialize the adapter before the page loads. The cleanest approach: create a server-side API route that the dashboard calls to initialize.

Actually, simpler approach — initialize the D1 adapter in a layout or use middleware. But since we already have `setAdapter()` and `getAdapter()` with memory fallback, the simplest path is:

Create `src/app/dashboard/layout.tsx`:

```typescript
import { getCloudflareContext } from '@opennextjs/cloudflare';
import { D1Adapter } from '@marlinjai/data-table-adapter-d1';
import { setAdapter } from '@/lib/receipts-table';

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  try {
    const { env } = await getCloudflareContext({ async: true });
    if (env.DB) {
      setAdapter(new D1Adapter(env.DB));
    }
  } catch {
    // Not running on Cloudflare — memory adapter will be used
  }

  return <>{children}</>;
}
```

**Step 2: Verify compilation**

Run: `cd "projects/receipt-ocr-app" && npx tsc --noEmit`

**Step 3: Commit**

```bash
git add projects/receipt-ocr-app/src/app/dashboard/layout.tsx
git commit -m "feat: wire D1 adapter via Cloudflare context in dashboard layout"
```

---

### Task 9: Create D1 Database and Apply Migrations

**Step 1: Create the D1 database**

Run: `cd "projects/receipt-ocr-app" && npx wrangler d1 create receipt-ocr-db`

This will output a database ID. Copy it.

**Step 2: Update wrangler.jsonc with the database ID**

Replace `<TO_BE_CREATED>` with the actual database ID returned.

**Step 3: Apply the migration**

Run: `cd "projects/receipt-ocr-app" && npx wrangler d1 execute receipt-ocr-db --remote --file="../data-table/packages/adapter-d1/migrations/0001_initial.sql"`

**Step 4: Set secrets**

Run:
```bash
cd "projects/receipt-ocr-app"
npx wrangler secret put NEXT_PUBLIC_STORAGE_BRAIN_API_KEY
npx wrangler secret put GOOGLE_CLOUD_VISION_API_KEY
```

**Step 5: Commit the wrangler.jsonc update**

```bash
git add projects/receipt-ocr-app/wrangler.jsonc
git commit -m "chore: add D1 database ID to wrangler config"
```

---

### Task 10: Build and Deploy to Cloudflare Pages

**Step 1: Test local preview**

Run: `cd "projects/receipt-ocr-app" && npm run preview`

Verify:
- Home page loads, upload zone renders
- Upload a test receipt image
- OCR processes and redirects to dashboard
- Dashboard displays extracted receipt data

**Step 2: Deploy**

Run: `cd "projects/receipt-ocr-app" && npm run deploy`

**Step 3: Verify deployment**

Visit the deployed URL and test the full flow.

**Step 4: Commit any final fixes**

```bash
git add -A projects/receipt-ocr-app/
git commit -m "chore: finalize Cloudflare Pages deployment"
```

---

### Task 11: Update Documentation and Version

**Files:**
- Modify: `projects/receipt-ocr-app/package.json` — bump to 0.3.0
- Modify: `projects/receipt-ocr-app/README.md` — update deployment info
- Modify: `projects/receipt-ocr-app/.env.example` — add GOOGLE_CLOUD_VISION_API_KEY

**Step 1: Bump version to 0.3.0**

In `package.json`, change `"version": "0.2.0"` to `"version": "0.3.0"`.

**Step 2: Update .env.example**

```env
NEXT_PUBLIC_STORAGE_BRAIN_API_KEY=sk_live_your_key_here
NEXT_PUBLIC_STORAGE_BRAIN_URL=https://storage-brain-api.marlin-pohl.workers.dev
GOOGLE_CLOUD_VISION_API_KEY=your_google_vision_api_key_here
```

**Step 3: Update README.md**

Add deployment section mentioning Cloudflare Pages + OpenNext, and the new Google Cloud Vision OCR requirement.

**Step 4: Commit and tag**

```bash
git add projects/receipt-ocr-app/
git commit -m "docs: update README, bump version to 0.3.0 for OCR overhaul"
```
