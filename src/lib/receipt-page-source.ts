import 'server-only';
import { preparePage, type PreparedPage } from '@/lib/receipt-page';
import { downloadStoredFile } from '@/lib/stored-files';

/**
 * The page of a stored receipt file, ready for the model. Never throws: a
 * file that cannot be fetched or opened is a reading without the page, which
 * the receipt then says, never a failed upload. Nothing of the file is logged.
 */
export async function loadReceiptPage(fileId: string): Promise<PreparedPage> {
  let bytes: Uint8Array;
  try {
    bytes = await downloadStoredFile(fileId);
  } catch (err) {
    console.error('[receipt-page] the stored file could not be fetched:', err instanceof Error ? err.message : 'unknown error');
    return { skipped: 'missing' };
  }
  try {
    const prepared = await preparePage(bytes);
    if (prepared.skipped) console.error('[receipt-page] the page is not given to the model:', prepared.skipped);
    return prepared;
  } catch (err) {
    console.error('[receipt-page] the stored file could not be prepared:', err instanceof Error ? err.message : 'unknown error');
    return { skipped: 'unreadable' };
  }
}
