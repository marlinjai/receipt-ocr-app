/**
 * Receipt Image cell URL convention (client-safe, pure).
 *
 * App uploads store PDFs as `/api/files/<id>/thumbnail` (a placeholder SVG the
 * table can render as an <img>; the lightbox strips the suffix to load the real
 * PDF into an iframe) and raster images as bare `/api/files/<id>`. The attach
 * feature initially wrote bare URLs for PDFs too, which broke both previews;
 * these helpers encode the convention and repair the old form.
 */

const isPdfName = (name: string) => name.toLowerCase().endsWith('.pdf');

/** Cell URL for a freshly uploaded source file. */
export function receiptImageUrl(fileId: string, fileName: string): string {
  return isPdfName(fileName) ? `/api/files/${fileId}/thumbnail` : `/api/files/${fileId}`;
}

/**
 * Given an existing cell value and the source file's name, return the corrected
 * URL if the value is a bare `/api/files/<id>` pointing at a PDF, else null
 * (nothing to fix). Non-app URLs and already-correct values are left alone.
 */
export function repairedImageUrl(existing: string, fileName: string): string | null {
  const m = existing.trim().match(/^\/api\/files\/([A-Za-z0-9-]+)$/);
  if (!m || !isPdfName(fileName)) return null;
  return `/api/files/${m[1]}/thumbnail`;
}
