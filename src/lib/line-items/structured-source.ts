/**
 * The stored file of a receipt read as an electronic invoice, for the line
 * backfill: an XRechnung or ZUGFeRD invoice stored before lines were kept
 * takes its lines from its XML. Null for any other file, and for a file that
 * cannot be fetched.
 */

import 'server-only';
import { structuredReceiptFields, type StructuredReceiptFields } from '@/lib/einvoice';
import { loadReceiptSource } from '@/lib/receipt-page-source';

export async function storedInvoiceFields(fileId: string): Promise<StructuredReceiptFields | null> {
  const source = await loadReceiptSource(fileId);
  return source.structured ? structuredReceiptFields(source.structured.invoice) : null;
}
