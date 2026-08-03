import { receiptImageUrl } from '@/lib/sheet-import/image-url';

/**
 * Client-side upload of a receipt file into Storage Brain via the presigned
 * flow, shared by every "put a file on an existing row" surface (detail-panel
 * button/paste/drop, table-cell upload/drop). Returns the Receipt Image CELL
 * value (`/thumbnail` form for PDFs).
 */

export const ACCEPTED_RECEIPT_TYPES = ['application/pdf', 'image/png', 'image/jpeg'];
export const MAX_RECEIPT_FILE_BYTES = 20 * 1024 * 1024;

/** Returns a human-readable rejection reason, or null when the file is fine. */
export function validateReceiptFile(file: File): string | null {
  if (!ACCEPTED_RECEIPT_TYPES.includes(file.type)) return 'Only PDF, PNG, or JPEG files are supported.';
  if (file.size > MAX_RECEIPT_FILE_BYTES) return 'File is larger than 20 MB.';
  return null;
}

export async function uploadReceiptFile(file: File): Promise<string> {
  const handshake = await fetch('/api/upload/request', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      fileName: file.name,
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
  return receiptImageUrl(fileId, file.name);
}
