/**
 * Make a photo fit for upload: at most 2000 pixels on the long edge, and JPEG
 * or PNG (the only image types the receipt file column accepts). A phone photo
 * is often 12 megapixels and several megabytes, and an iPhone may hand over
 * HEIC; both are scaled and re-encoded here, in the browser. PDFs pass through.
 */

export const MAX_IMAGE_EDGE = 2000;
export const JPEG_QUALITY = 0.85;

export type PrepareImageErrorCode = 'undecodable' | 'encode_failed';

export class PrepareImageError extends Error {
  readonly code: PrepareImageErrorCode;
  constructor(code: PrepareImageErrorCode) {
    super(
      code === 'undecodable'
        ? 'This image format cannot be read by the browser. Take the photo again or save it as JPEG.'
        : 'The photo could not be converted for upload. Try again.',
    );
    this.name = 'PrepareImageError';
    this.code = code;
  }
}

/** The size to scale to: the long edge capped at `max`, aspect ratio kept, never enlarged. */
export function targetSize(width: number, height: number, max = MAX_IMAGE_EDGE): { width: number; height: number } {
  const longEdge = Math.max(width, height);
  if (longEdge <= max) return { width, height };
  const scale = max / longEdge;
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/** Whether the file must be re-encoded (wrong type, or larger than the cap). */
export function needsConversion(type: string, width: number, height: number, max = MAX_IMAGE_EDGE): boolean {
  if (type !== 'image/jpeg' && type !== 'image/png') return true;
  return Math.max(width, height) > max;
}

export function jpegName(name: string): string {
  const base = name.replace(/\.[^./\\]+$/, '');
  return `${base || 'receipt'}.jpg`;
}

export interface ImageCodec {
  /** Decode to pixel dimensions plus a handle the encoder understands. Throws when the format is unknown. */
  decode: (file: File) => Promise<{ width: number; height: number; source: unknown; release?: () => void }>;
  encodeJpeg: (source: unknown, width: number, height: number, quality: number) => Promise<Blob | null>;
}

/** The browser's own decoder and a canvas. */
export const browserCodec: ImageCodec = {
  async decode(file) {
    // `from-image` applies the camera's rotation flag, so a portrait photo stays portrait.
    const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
    return { width: bitmap.width, height: bitmap.height, source: bitmap, release: () => bitmap.close() };
  },
  async encodeJpeg(source, width, height, quality) {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    // White behind transparent pixels: JPEG has no alpha, and black would hide the text.
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(source as CanvasImageSource, 0, 0, width, height);
    return new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
  },
};

export async function prepareImage(file: File, codec: ImageCodec = browserCodec): Promise<File> {
  if (!file.type.startsWith('image/')) return file;
  let decoded: Awaited<ReturnType<ImageCodec['decode']>>;
  try {
    decoded = await codec.decode(file);
  } catch {
    throw new PrepareImageError('undecodable');
  }
  try {
    if (!needsConversion(file.type, decoded.width, decoded.height)) return file;
    const size = targetSize(decoded.width, decoded.height);
    const blob = await codec.encodeJpeg(decoded.source, size.width, size.height, JPEG_QUALITY);
    if (!blob) throw new PrepareImageError('encode_failed');
    return new File([blob], jpegName(file.name), { type: 'image/jpeg', lastModified: file.lastModified });
  } finally {
    decoded.release?.();
  }
}
