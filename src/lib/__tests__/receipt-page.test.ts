import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { IMAGE_MAX_BYTES, PDF_MAX_BYTES, pagesToSend, preparePage, sniffMediaType } from '../receipt-page';

async function pdf(pages: number): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i++) doc.addPage([200, 200 + i]);
  return doc.save();
}

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46]);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

describe('sniffMediaType: the bytes decide, not the name', () => {
  it('knows the types the model reads', async () => {
    expect(sniffMediaType(JPEG)).toBe('image/jpeg');
    expect(sniffMediaType(PNG)).toBe('image/png');
    expect(sniffMediaType(new TextEncoder().encode('GIF89a...'))).toBe('image/gif');
    expect(sniffMediaType(new TextEncoder().encode('RIFF0000WEBPVP8 '))).toBe('image/webp');
    expect(sniffMediaType(await pdf(1))).toBe('application/pdf');
    expect(sniffMediaType(new TextEncoder().encode('\n\n%PDF-1.4 ...'))).toBe('application/pdf');
  });

  it('knows nothing else', () => {
    expect(sniffMediaType(new TextEncoder().encode('<html>not found</html>'))).toBeNull();
    expect(sniffMediaType(new Uint8Array())).toBeNull();
  });
});

describe('pagesToSend', () => {
  it('a short PDF whole, a long one as its head and its end', () => {
    expect(pagesToSend(1)).toEqual([0]);
    expect(pagesToSend(6)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(pagesToSend(7)).toEqual([0, 1, 2, 5, 6]);
    expect(pagesToSend(40)).toEqual([0, 1, 2, 38, 39]);
  });
});

describe('preparePage', () => {
  it('sends an image as it is', async () => {
    const prepared = await preparePage(JPEG);
    expect(prepared.page).toEqual({ mediaType: 'image/jpeg', base64: Buffer.from(JPEG).toString('base64') });
  });

  it('sends a PDF of several pages whole and says how many', async () => {
    const bytes = await pdf(3);
    const prepared = await preparePage(bytes);
    expect(prepared.page).toMatchObject({ mediaType: 'application/pdf', pagesSent: 3, pagesTotal: 3 });
    expect(prepared.page!.base64).toBe(Buffer.from(bytes).toString('base64'));
  });

  it('cuts a long PDF to its first three and last two pages', async () => {
    const prepared = await preparePage(await pdf(12));
    expect(prepared.page).toMatchObject({ pagesSent: 5, pagesTotal: 12 });
    const cut = await PDFDocument.load(Buffer.from(prepared.page!.base64, 'base64'));
    // Page i of the source is 200 + i high: the head and the end, in order.
    expect(cut.getPages().map((p) => p.getHeight())).toEqual([200, 201, 202, 210, 211]);
  });

  it('does not send what is over the limit', async () => {
    const image = new Uint8Array(IMAGE_MAX_BYTES + 1);
    image.set(JPEG);
    expect(await preparePage(image)).toEqual({ skipped: 'too_large' });
    const doc = await PDFDocument.create();
    const page = doc.addPage([200, 200]);
    // Random bytes do not compress, so the file itself is over the limit.
    doc.attach(randomBytes(PDF_MAX_BYTES + 1024), 'noise.bin', { mimeType: 'application/octet-stream' });
    page.drawText('x');
    expect(await preparePage(await doc.save({ useObjectStreams: false }))).toEqual({ skipped: 'too_large' });
  });

  it('does not send what it cannot open', async () => {
    expect(await preparePage(new TextEncoder().encode('<html>not found</html>'))).toEqual({ skipped: 'unreadable' });
    expect(await preparePage(new TextEncoder().encode('%PDF-1.7\nthis is not a PDF at all'))).toEqual({ skipped: 'unreadable' });
  });
});
