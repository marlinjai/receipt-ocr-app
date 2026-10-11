import 'server-only';
import { FileNotFoundError } from '@marlinjai/storage-brain-sdk';
import { getStorageClient } from '@/lib/storage';

/**
 * Remove one object from the file store for good. A file that is already gone
 * counts as removed (a retry after a half-finished delete must succeed);
 * anything else rejects, and the caller keeps the receipt.
 */
export async function deleteStoredFile(fileId: string): Promise<void> {
  try {
    await getStorageClient().deleteFile(fileId);
  } catch (e) {
    if (e instanceof FileNotFoundError || (e as { statusCode?: number })?.statusCode === 404) return;
    throw e;
  }
}

/** How long the download of one receipt file may take before the reading goes on without the page. */
const DOWNLOAD_TIMEOUT_MS = 20_000;

/**
 * The bytes of one stored file. Rejects when the store is not configured, does
 * not answer in time or does not have the file; the message names the status
 * only, never anything of the file.
 */
export async function downloadStoredFile(fileId: string): Promise<Uint8Array> {
  const apiKey = process.env.STORAGE_BRAIN_API_KEY;
  if (!apiKey) throw new Error('STORAGE_BRAIN_API_KEY is not set');
  // The same address the file and text recognition routes download from.
  const base = process.env.NEXT_PUBLIC_STORAGE_BRAIN_URL || 'https://storage-brain-api.marlin-pohl.workers.dev';
  const response = await fetch(`${base}/api/v1/files/${encodeURIComponent(fileId)}/download`, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`file store answered ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}
