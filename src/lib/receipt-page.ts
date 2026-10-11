/**
 * The page of a receipt as a language model is given it: the image, or the
 * PDF pages, cut to what one reading may cost.
 *
 * The limits are the plan's (docs/plans/2026-10-11-vision-reading.md). Beyond
 * them the page is not sent and the receipt is read from its recognized text
 * alone, which the caller records on the receipt.
 */

/** A PDF of up to this many pages is sent whole. */
export const PDF_MAX_PAGES = 6;
/** Of a longer one: the head, with vendor and date ... */
export const PDF_HEAD_PAGES = 3;
/** ... and the end, with the totals. */
export const PDF_TAIL_PAGES = 2;
/** The most bytes of a PDF that are sent, after the cut to head and end. */
export const PDF_MAX_BYTES = 8 * 1024 * 1024;
/** The most bytes of an image that are sent. Uploaded photos are already scaled to 2,000 pixels in the browser. */
export const IMAGE_MAX_BYTES = 3.5 * 1024 * 1024;

export type PageMediaType = 'application/pdf' | 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif';

export interface ReceiptPage {
  mediaType: PageMediaType;
  /** The bytes, base64 without line breaks. */
  base64: string;
  /** For a PDF: how many of its pages are in `base64`, and how many it has. */
  pagesSent?: number;
  pagesTotal?: number;
}

/** Why a page is not given to the model. */
export type PageSkip =
  /** The file could not be fetched from the store. */
  | 'missing'
  /** Not a PDF or an image the model reads, or a PDF that cannot be opened (damaged, password-protected). */
  | 'unreadable'
  /** Over the byte limit. */
  | 'too_large';

export type PreparedPage = { page: ReceiptPage; skipped?: undefined } | { page?: undefined; skipped: PageSkip };

const startsWith = (bytes: Uint8Array, signature: number[], offset = 0) => signature.every((byte, i) => bytes[offset + i] === byte);

/** The type by the file's first bytes. A name or a stored content type can be wrong; the bytes are what is sent. */
export function sniffMediaType(bytes: Uint8Array): PageMediaType | null {
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47])) return 'image/png';
  if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38])) return 'image/gif';
  if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8)) return 'image/webp';
  // The header of a PDF may stand anywhere in its first 1,024 bytes.
  for (let i = 0; i < Math.min(bytes.length - 4, 1024); i++) {
    if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46], i)) return 'application/pdf';
  }
  return null;
}

/** The pages of a long PDF that are sent, as zero-based indexes: the head and the end. */
export function pagesToSend(total: number): number[] {
  if (total <= PDF_MAX_PAGES) return Array.from({ length: total }, (_, i) => i);
  const head = Array.from({ length: PDF_HEAD_PAGES }, (_, i) => i);
  const tail = Array.from({ length: PDF_TAIL_PAGES }, (_, i) => total - PDF_TAIL_PAGES + i);
  return [...head, ...tail];
}

const toBase64 = (bytes: Uint8Array) => Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64');

/** Cut a stored file to the page a model is given, or say why it is not given one. */
export async function preparePage(bytes: Uint8Array): Promise<PreparedPage> {
  const mediaType = sniffMediaType(bytes);
  if (!mediaType) return { skipped: 'unreadable' };
  if (mediaType !== 'application/pdf') {
    return bytes.byteLength > IMAGE_MAX_BYTES ? { skipped: 'too_large' } : { page: { mediaType, base64: toBase64(bytes) } };
  }

  const { PDFDocument } = await import('pdf-lib');
  let source: Awaited<ReturnType<typeof PDFDocument.load>>;
  let total: number;
  try {
    source = await PDFDocument.load(bytes);
    // A damaged file can load and still have no page tree to count.
    total = source.getPageCount();
  } catch {
    // Damaged or password-protected. Without a page count nothing bounds what a reading would cost.
    return { skipped: 'unreadable' };
  }
  if (total === 0) return { skipped: 'unreadable' };
  const wanted = pagesToSend(total);
  let sent = bytes;
  if (wanted.length < total) {
    try {
      const cut = await PDFDocument.create();
      for (const copied of await cut.copyPages(source, wanted)) cut.addPage(copied);
      sent = await cut.save();
    } catch {
      return { skipped: 'unreadable' };
    }
  }
  if (sent.byteLength > PDF_MAX_BYTES) return { skipped: 'too_large' };
  return { page: { mediaType, base64: toBase64(sent), pagesSent: wanted.length, pagesTotal: total } };
}
