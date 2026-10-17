'use client';

import type { FileStorageAdapter, UploadedFile } from '@marlinjai/data-table-core';
import { acceptedKindsLabel } from './receipt-file-accept';

/**
 * Client-side FileStorageAdapter for the data-table: uploads go through the
 * app's presigned Storage Brain flow (the browser never sees the API key),
 * URLs are the auth-gated /api/files proxy.
 *
 * `delete` is deliberately a no-op: a Storage Brain object may be referenced
 * by more than one row, so removing the FILE REFERENCE (which the table does
 * separately) is the meaningful delete; the object itself is never destroyed.
 */

/** The one list of file types a receipt takes by hand: PDF, PNG, JPEG, and an e-invoice as pure XML (XRechnung). */
export const ACCEPTED_RECEIPT_TYPES = ['application/pdf', 'image/png', 'image/jpeg', 'application/xml', 'text/xml'];
export const MAX_RECEIPT_FILE_BYTES = 20 * 1024 * 1024;

/** Returns a human-readable rejection reason, or null when the file is fine. */
export function validateReceiptFile(file: File): string | null {
  // A browser may give an XML file no type at all: its name says what it is.
  const xmlByName = file.type === '' && /\.xml$/i.test(file.name.trim());
  if (!ACCEPTED_RECEIPT_TYPES.includes(file.type) && !xmlByName) return `Only ${acceptedKindsLabel(ACCEPTED_RECEIPT_TYPES)} files are supported.`;
  if (file.size > MAX_RECEIPT_FILE_BYTES) return 'File is larger than 20 MB.';
  return null;
}

export class PresignedStorageBrainAdapter implements FileStorageAdapter {
  async upload(file: File | Blob): Promise<UploadedFile> {
    const name = file instanceof File ? file.name : 'file';
    const handshake = await fetch('/api/upload/request', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fileName: name,
        fileType: file.type,
        fileSize: file.size,
        context: 'receipt',
        tags: { source: 'row-attach' },
      }),
    });
    if (!handshake.ok) throw new Error('Upload request failed');
    const { presignedUrl, fileId } = (await handshake.json()) as { presignedUrl: string; fileId: string };
    const put = await fetch(presignedUrl, { method: 'PUT', headers: { 'Content-Type': file.type }, body: file });
    if (!put.ok) throw new Error(`Upload failed (${put.status})`);
    return {
      id: fileId,
      url: `/api/files/${fileId}`,
      originalName: name,
      mimeType: file.type,
      sizeBytes: file.size,
    };
  }

  async delete(): Promise<void> {
    /* ref-only delete; see module docblock */
  }

  async getUrl(fileId: string): Promise<string> {
    return `/api/files/${fileId}`;
  }
}
