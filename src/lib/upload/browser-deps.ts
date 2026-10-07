'use client';

import type { FileInfo } from '@/lib/storage';
import type { OcrResult } from '@/lib/ocr-types';
import { UploadStepError } from './errors';
import { sha256Hex } from './hash';
import type { ExistingReceiptRef, PipelineDeps, SavedReceipt, UploadedFileInfo } from './pipeline';
import { prepareImage } from './prepare-image';

/** The real endpoints behind the upload pipeline, shared by the batch uploader and the phone capture. */

function uploadToPresignedUrl(presignedUrl: string, file: File, onProgress: (progress: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', presignedUrl);
    xhr.setRequestHeader('Content-Type', file.type);
    xhr.upload.addEventListener('progress', (e) => {
      if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
    });
    xhr.addEventListener('load', () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else reject(new UploadStepError('server', `Upload failed with status ${xhr.status}`));
    });
    xhr.addEventListener('error', () => reject(new UploadStepError('network', 'Upload network error')));
    xhr.addEventListener('abort', () => reject(new UploadStepError('network', 'Upload aborted')));
    xhr.send(file);
  });
}

/** `fetch` that reports a dead connection and an expired session as such. */
async function request(input: string, init: RequestInit | undefined, what: string): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(input, init);
  } catch {
    throw new UploadStepError('network', `${what}: no connection to the server.`);
  }
  if (res.status === 401) {
    throw new UploadStepError('auth', 'Your session has expired. Reload the page and sign in again.');
  }
  return res;
}

export type SaveReceipt = (
  file: UploadedFileInfo,
  ocr: OcrResult | null,
  options: { sha256: string },
) => Promise<SavedReceipt>;

export function createBrowserDeps(save: SaveReceipt): PipelineDeps {
  return {
    prepare: prepareImage,
    hash: sha256Hex,
    async checkDuplicate(sha256) {
      const res = await request(
        '/api/upload/check',
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sha256 }) },
        'Duplicate check',
      );
      if (!res.ok) {
        throw new UploadStepError('server', `Duplicate check failed (${res.status}). Nothing was uploaded; try again.`);
      }
      const body = (await res.json()) as { duplicate: ExistingReceiptRef | null };
      return body.duplicate ?? null;
    },
    async upload(file, onProgress) {
      // Step 1: request a presigned URL from our server
      const handshakeRes = await request(
        '/api/upload/request',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            fileName: file.name,
            fileType: file.type,
            fileSize: file.size,
            context: 'receipt',
            tags: { source: 'receipt-ocr-app' },
          }),
        },
        'Upload request',
      );
      if (!handshakeRes.ok) throw new UploadStepError('server', 'Upload request failed');
      const { presignedUrl, fileId } = await handshakeRes.json();

      // Step 2: upload directly to the presigned URL with progress
      await uploadToPresignedUrl(presignedUrl, file, onProgress);

      // Step 3: get the file info from our server
      const fileInfoRes = await request(`/api/upload/complete/${fileId}`, undefined, 'Upload');
      if (!fileInfoRes.ok) throw new UploadStepError('server', 'Failed to get file info');
      return (await fileInfoRes.json()) as FileInfo;
    },
    async recognize(file) {
      const ocrRes = await request(
        '/api/ocr',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ fileId: file.id, fileName: file.originalName }),
        },
        'Text recognition',
      );
      if (!ocrRes.ok) {
        const errText = await ocrRes.text().catch(() => '');
        throw new UploadStepError('server', `OCR failed (${ocrRes.status})${errText ? ': ' + errText.slice(0, 200) : ''}`);
      }
      return (await ocrRes.json()) as OcrResult;
    },
    save,
  };
}
