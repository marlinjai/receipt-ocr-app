import { PDFDocument, degrees } from 'pdf-lib';
import { zlibSync } from 'fflate';

/**
 * Small receipt files built in the test itself: PDFs with pdf-lib, a PNG by
 * hand, and a JPEG whose header names any size (pdf-lib reads only the header
 * of a JPEG, it never decodes the picture).
 */

/** A PDF with one page per size given; `ownRotation` is written as the page's own /Rotate. */
export async function pdfFile(pages: { width: number; height: number; ownRotation?: number }[]): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (const p of pages) {
    const page = doc.addPage([p.width, p.height]);
    page.drawText('Beleg', { x: 10, y: 10, size: 12 });
    if (p.ownRotation) page.setRotation(degrees(p.ownRotation));
  }
  return doc.save();
}

export async function pageRotations(bytes: Uint8Array): Promise<number[]> {
  const doc = await PDFDocument.load(bytes);
  return doc.getPages().map((p) => p.getRotation().angle);
}

export async function pageSizes(bytes: Uint8Array): Promise<{ width: number; height: number }[]> {
  const doc = await PDFDocument.load(bytes);
  return doc.getPages().map((p) => p.getSize());
}

// A valid baseline 1x1 greyscale JPEG; its frame header is rewritten to any size.
const TINY_JPEG =
  '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=';

function exifSegment(orientation: number, littleEndian: boolean): Uint8Array {
  const tiff = new Uint8Array(8 + 2 + 12 + 4);
  const view = new DataView(tiff.buffer);
  view.setUint16(0, littleEndian ? 0x4949 : 0x4d4d);
  view.setUint16(2, 42, littleEndian);
  view.setUint32(4, 8, littleEndian);
  view.setUint16(8, 1, littleEndian);
  view.setUint16(10, 0x0112, littleEndian);
  view.setUint16(12, 3, littleEndian);
  view.setUint32(14, 1, littleEndian);
  view.setUint16(18, orientation, littleEndian);
  const body = new Uint8Array(6 + tiff.length);
  body.set([0x45, 0x78, 0x69, 0x66, 0, 0]);
  body.set(tiff, 6);
  const segment = new Uint8Array(4 + body.length);
  segment[0] = 0xff;
  segment[1] = 0xe1;
  new DataView(segment.buffer).setUint16(2, body.length + 2);
  segment.set(body, 4);
  return segment;
}

export function jpegFile(width: number, height: number, orientation?: number, littleEndian = true): Uint8Array {
  const base = Uint8Array.from(Buffer.from(TINY_JPEG, 'base64'));
  // Find the frame header (FFC0) and write the size into it.
  for (let i = 2; i < base.length - 8; i++) {
    if (base[i] === 0xff && (base[i + 1] === 0xc0 || base[i + 1] === 0xc2)) {
      const view = new DataView(base.buffer, base.byteOffset);
      view.setUint16(i + 5, height);
      view.setUint16(i + 7, width);
      break;
    }
  }
  if (orientation === undefined) return base;
  const exif = exifSegment(orientation, littleEndian);
  const out = new Uint8Array(base.length + exif.length);
  out.set(base.subarray(0, 2));
  out.set(exif, 2);
  out.set(base.subarray(2), 2 + exif.length);
  return out;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  const typed = new Uint8Array(4 + data.length);
  typed.set(Buffer.from(type, 'ascii'));
  typed.set(data, 4);
  out.set(typed, 4);
  view.setUint32(8 + data.length, crc32(typed));
  return out;
}

/** A plain white greyscale PNG of the given size. */
export function pngFile(width: number, height: number): Uint8Array {
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header.set([8, 0, 0, 0, 0], 8);
  const raw = new Uint8Array((width + 1) * height).fill(255);
  for (let y = 0; y < height; y++) raw[y * (width + 1)] = 0;
  const parts = [
    Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', zlibSync(raw)),
    chunk('IEND', new Uint8Array(0)),
  ];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}
