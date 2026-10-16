import 'server-only';
import { preparePage, type PreparedPage } from '@/lib/receipt-page';
import { downloadStoredFile } from '@/lib/stored-files';
import { readStructuredInvoice, type StructuredReading } from '@/lib/einvoice';

/**
 * The page of a stored receipt file, ready for the model. Never throws: a
 * file that cannot be fetched or opened is a reading without the page, which
 * the receipt then says, never a failed upload. Nothing of the file is logged.
 */
export async function loadReceiptPage(fileId: string): Promise<PreparedPage> {
  return (await loadReceiptSource(fileId)).page;
}

/** The page for the model and, for an electronic invoice, its structured data: from one download of the stored file. */
export interface ReceiptSource {
  page: PreparedPage;
  /** Null for every ordinary receipt, and where the file could not be fetched or its XML not read. */
  structured: StructuredReading | null;
}

/**
 * The stored file, fetched once: its page for the model, and its structured
 * invoice data where it is an XRechnung or a ZUGFeRD or Factur-X PDF. Never
 * throws; nothing of the file is logged.
 */
export async function loadReceiptSource(fileId: string): Promise<ReceiptSource> {
  let bytes: Uint8Array;
  try {
    bytes = await downloadStoredFile(fileId);
  } catch (err) {
    console.error('[receipt-page] the stored file could not be fetched:', err instanceof Error ? err.message : 'unknown error');
    return { page: { skipped: 'missing' }, structured: null };
  }
  let structured: StructuredReading | null = null;
  try {
    structured = await readStructuredInvoice(bytes);
  } catch (err) {
    // An XML that cannot be read is a receipt read from its page, as before.
    console.error('[receipt-page] the structured invoice data could not be read:', err instanceof Error ? err.name : 'unknown error');
  }
  return { page: await preparedPage(bytes), structured };
}

async function preparedPage(bytes: Uint8Array): Promise<PreparedPage> {
  try {
    const prepared = await preparePage(bytes);
    if (prepared.skipped) console.error('[receipt-page] the page is not given to the model:', prepared.skipped);
    return prepared;
  } catch (err) {
    console.error('[receipt-page] the stored file could not be prepared:', err instanceof Error ? err.message : 'unknown error');
    return { skipped: 'unreadable' };
  }
}
