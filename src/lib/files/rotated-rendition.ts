import { EncryptedPDFError, PDFDocument, degrees, type PDFImage } from 'pdf-lib';
import { initialRotation, type Rotation, type Size } from '@/lib/meals/viewer-state';

/**
 * The receipt as the viewer shows it, for opening outside the app.
 *
 * The rotation chosen in the viewer is stored with the file reference; the
 * stored file is never rewritten. To show the same picture in a new browser
 * tab, a turned copy is made in memory for each request:
 *
 * - a PDF gets the rotation added to every page's own /Rotate entry (the same
 *   rule the meal register export uses); the content stays as it is, but the
 *   file is written anew, so the copy is named as a copy (see renditionName);
 * - a JPEG or PNG is placed unchanged (no re-encoding) on a one-page PDF whose
 *   page carries the rotation, because a PDF page can be turned losslessly and
 *   the app has no image library on the server.
 *
 * Without a stored rotation the viewer opens a page that is clearly wider than
 * tall turned upright (a guess it does not store); the same guess is made here,
 * so the new tab shows what the viewer showed.
 */

export type RenditionErrorCode = 'unreadable_pdf' | 'encrypted_pdf' | 'unreadable_image' | 'unsupported_type' | 'mirrored_image';

export class RenditionError extends Error {
  readonly code: RenditionErrorCode;
  constructor(code: RenditionErrorCode, cause?: unknown) {
    super(`the turned copy could not be made (${code})`, cause === undefined ? undefined : { cause });
    this.name = 'RenditionError';
    this.code = code;
  }
}

export type Rendition =
  /** Nothing to turn: the stored file is served as it is. */
  | { kind: 'original'; rotation: 0 }
  /** A turned copy, always a PDF; `rotation` is the quarter turn applied on top of what the file shows by itself. */
  | { kind: 'pdf'; bytes: Uint8Array; rotation: Exclude<Rotation, 0> };

const PDF_TYPES = new Set(['application/pdf']);
const JPEG_TYPES = new Set(['image/jpeg', 'image/jpg', 'image/pjpeg']);
const PNG_TYPES = new Set(['image/png']);

function normalise(angle: number): Rotation {
  return ((((Math.round(angle / 90) * 90) % 360) + 360) % 360) as Rotation;
}

/** Whether a file of this type can be turned by `rotatedRendition`. */
export function canRotate(mimeType: string): boolean {
  const type = mimeType.toLowerCase().split(';')[0].trim();
  return PDF_TYPES.has(type) || JPEG_TYPES.has(type) || PNG_TYPES.has(type);
}

/**
 * Make the turned copy of one stored file. `stored` is the rotation kept on
 * the file reference, or null when none was chosen. Throws a RenditionError
 * when the file cannot be turned; it never hands back an unturned file as if
 * it were turned.
 */
export async function rotatedRendition(bytes: Uint8Array, mimeType: string, stored: Rotation | null): Promise<Rendition> {
  const type = mimeType.toLowerCase().split(';')[0].trim();
  if (PDF_TYPES.has(type)) return rotatePdf(bytes, stored);
  if (JPEG_TYPES.has(type) || PNG_TYPES.has(type)) return rotateImage(bytes, JPEG_TYPES.has(type) ? 'jpeg' : 'png', stored);
  throw new RenditionError('unsupported_type');
}

async function rotatePdf(bytes: Uint8Array, stored: Rotation | null): Promise<Rendition> {
  let doc: PDFDocument;
  try {
    doc = await PDFDocument.load(bytes, { updateMetadata: false });
  } catch (e) {
    // An encrypted PDF could be loaded with `ignoreEncryption`, but saving it writes an unreadable file.
    // pdf-lib's error classes are compiled to ES5, where `instanceof` on an Error subclass fails; its message is checked too.
    const encrypted = e instanceof EncryptedPDFError || (e instanceof Error && /\bis encrypted\b/.test(e.message));
    throw new RenditionError(encrypted ? 'encrypted_pdf' : 'unreadable_pdf', e);
  }
  const pages = doc.getPages();
  if (pages.length === 0) throw new RenditionError('unreadable_pdf');

  // The guess looks at the first page as it is shown: its own /Rotate applied.
  const first = pages[0];
  const box = first.getCropBox();
  const own = normalise(first.getRotation().angle);
  const shown: Size = own === 90 || own === 270 ? { width: box.height, height: box.width } : { width: box.width, height: box.height };
  const rotation = initialRotation(stored, shown);
  if (rotation === 0) return { kind: 'original', rotation: 0 };

  for (const page of pages) {
    page.setRotation(degrees(normalise(page.getRotation().angle + rotation)));
  }
  return { kind: 'pdf', bytes: await doc.save(), rotation };
}

async function rotateImage(bytes: Uint8Array, format: 'jpeg' | 'png', stored: Rotation | null): Promise<Rendition> {
  // A browser shows a JPEG turned by its camera orientation flag, and so does
  // the viewer; a PDF ignores the flag, so it is applied by hand here.
  const orientation = format === 'jpeg' ? jpegOrientation(bytes) : 1;
  // Flags 5 to 8 lay the picture on its side, so its sides swap on screen.
  const onItsSide = orientation >= 5;

  const doc = await PDFDocument.create();
  let image: PDFImage;
  try {
    image = format === 'jpeg' ? await doc.embedJpg(bytes) : await doc.embedPng(bytes);
  } catch (e) {
    throw new RenditionError('unreadable_image', e);
  }
  const shown: Size = onItsSide ? { width: image.height, height: image.width } : { width: image.width, height: image.height };
  const rotation = initialRotation(stored, shown);
  if (rotation === 0) return { kind: 'original', rotation: 0 };
  const own = ORIENTATION_TURN[orientation];
  if (own === undefined) throw new RenditionError('mirrored_image');

  // One pixel is one point: the picture keeps its own size, and any PDF viewer fits it to the window.
  const page = doc.addPage([image.width, image.height]);
  page.drawImage(image, { x: 0, y: 0, width: image.width, height: image.height });
  page.setRotation(degrees(normalise(own + rotation)));
  return { kind: 'pdf', bytes: await doc.save(), rotation };
}

/**
 * The camera orientation flags (EXIF tag 0x0112) that are a pure turn, as the
 * clockwise turn a browser applies. 2, 4, 5 and 7 also mirror the picture,
 * which a PDF page rotation cannot reproduce; they are left out on purpose.
 */
const ORIENTATION_TURN: Record<number, Rotation | undefined> = { 1: 0, 3: 180, 6: 90, 8: 270 };

/**
 * The orientation flag of a JPEG, or 1 (as taken) when it has none or the
 * metadata cannot be read: a browser shows such a file as it is, too.
 */
export function jpegOrientation(bytes: Uint8Array): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 4 || view.getUint16(0) !== 0xffd8) return 1;
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    const marker = view.getUint16(offset);
    if ((marker & 0xff00) !== 0xff00) return 1;
    // Start of scan: the picture data begins, no metadata follows.
    if (marker === 0xffda) return 1;
    const length = view.getUint16(offset + 2);
    if (length < 2) return 1;
    if (marker === 0xffe1) {
      const found = exifOrientation(view, offset + 4, Math.min(offset + 2 + length, bytes.length));
      if (found !== null) return found;
    }
    offset += 2 + length;
  }
  return 1;
}

function exifOrientation(view: DataView, start: number, end: number): number | null {
  // "Exif\0\0", then a TIFF header.
  if (start + 14 > end || view.getUint32(start) !== 0x45786966 || view.getUint16(start + 4) !== 0) return null;
  const tiff = start + 6;
  const order = view.getUint16(tiff);
  if (order !== 0x4949 && order !== 0x4d4d) return null;
  const little = order === 0x4949;
  const ifd = tiff + view.getUint32(tiff + 4, little);
  if (ifd + 2 > end) return null;
  const count = view.getUint16(ifd, little);
  for (let i = 0; i < count; i++) {
    const entry = ifd + 2 + i * 12;
    if (entry + 12 > end) return null;
    if (view.getUint16(entry, little) === 0x0112) {
      const value = view.getUint16(entry + 8, little);
      return value >= 1 && value <= 8 ? value : 1;
    }
  }
  return null;
}

/**
 * The file name for what is served. The stored file keeps its own name. A
 * turned copy is a rewritten file (a signature or an archive format in the
 * original does not survive it), so its name says so: "<name> (gedreht).pdf".
 * Kept to a sane length, cut between characters (never inside one), and free
 * of path separators and control characters.
 */
export function renditionName(originalName: string, rendition: Rendition): string {
  const clean = originalName.replace(/[\u0000-\u001f\u007f/\\]/g, ' ').trim() || 'Beleg';
  if (rendition.kind === 'original') return cut(clean, 200);
  const base = clean.replace(/\.[^.]+$/, '').trim() || 'Beleg';
  return `${cut(base, 180)} (gedreht).pdf`;
}

/** The first `max` characters, counted as characters (code points), so an emoji is never split. */
function cut(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length <= max ? text : chars.slice(0, max).join('');
}

/**
 * A Content-Disposition value that shows the file in the browser and names it
 * for a download, with umlauts kept (RFC 6266 and RFC 5987) and a plain
 * fallback for old clients.
 */
export function inlineDisposition(name: string): string {
  const fallback = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  const encoded = encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `inline; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}
