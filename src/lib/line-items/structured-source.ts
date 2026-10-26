/**
 * The stored file of a receipt read as an electronic invoice, for the line
 * backfill: an XRechnung or ZUGFeRD invoice stored before lines were kept
 * takes its lines from its XML. Null for any other file.
 */

import 'server-only';
import { readStructuredInvoice, structuredReceiptFields, type StructuredReceiptFields } from '@/lib/einvoice';
import { downloadStoredFile } from '@/lib/stored-files';

/** Throws when the file cannot be fetched: the backfill then tries the receipt again, never reading it from its text instead. */
export async function storedInvoiceFields(fileId: string): Promise<StructuredReceiptFields | null> {
  const bytes = await downloadStoredFile(fileId);
  try {
    const structured = await readStructuredInvoice(bytes);
    return structured ? structuredReceiptFields(structured.invoice) : null;
  } catch {
    // A file that is no readable electronic invoice is read like any other receipt, from its text.
    return null;
  }
}
