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
