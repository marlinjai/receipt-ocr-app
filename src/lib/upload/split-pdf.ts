/**
 * Split a multi-page PDF into one file per page ("one receipt per page"), in
 * the browser. Each page then runs through the normal per-file pipeline, which
 * sidesteps the text recognition route's five-page limit and its merging of all
 * pages into one receipt.
 */

export type SplitPdfErrorCode = 'unreadable' | 'encrypted' | 'too_many_pages';

export class SplitPdfError extends Error {
  readonly code: SplitPdfErrorCode;
  constructor(code: SplitPdfErrorCode) {
    super(code);
    this.name = 'SplitPdfError';
    this.code = code;
  }
}

/** A scan batch far beyond this is almost certainly the wrong file. */
export const SPLIT_MAX_PAGES = 200;

export function splitPdfMessage(code: SplitPdfErrorCode): string {
  switch (code) {
    case 'encrypted':
      return 'This PDF is password-protected and cannot be split. Remove the protection or upload the pages separately.';
    case 'too_many_pages':
      return `This PDF has more than ${SPLIT_MAX_PAGES} pages. Split it into smaller files first.`;
    default:
      return 'This PDF could not be read, so it was not split. Check the file or upload the pages separately.';
  }
}

function pageName(original: string, page: number, total: number): string {
  const base = original.replace(/\.pdf$/i, '');
  const width = String(total).length;
  return `${base}-seite-${String(page).padStart(width, '0')}.pdf`;
}

/**
 * Returns one single-page PDF per page, in order. A one-page PDF is returned
 * unchanged (same File object). Throws SplitPdfError.
 */
export async function splitPdfPages(file: File): Promise<File[]> {
  const { PDFDocument } = await import('pdf-lib');
  let source: Awaited<ReturnType<typeof PDFDocument.load>>;
  try {
    source = await PDFDocument.load(await file.arrayBuffer());
  } catch (e) {
    const message = e instanceof Error ? e.message.toLowerCase() : '';
    throw new SplitPdfError(message.includes('encrypt') ? 'encrypted' : 'unreadable');
  }
  const total = source.getPageCount();
  if (total <= 1) return [file];
  if (total > SPLIT_MAX_PAGES) throw new SplitPdfError('too_many_pages');

  const pages: File[] = [];
  for (let i = 0; i < total; i++) {
    const single = await PDFDocument.create();
    const [copied] = await single.copyPages(source, [i]);
    single.addPage(copied);
    const bytes = await single.save();
    pages.push(
      new File([bytes as BlobPart], pageName(file.name, i + 1, total), {
        type: 'application/pdf',
        lastModified: file.lastModified,
      }),
    );
  }
  return pages;
}
