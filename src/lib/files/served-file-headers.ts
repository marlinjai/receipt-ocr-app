/**
 * Headers that keep a stored file, served inline from the app's own domain,
 * from running anything there.
 *
 * Receipts are uploaded by people and arrive by mail, so a stored file is
 * untrusted. A browser shows an XML file (an XRechnung, say) as a document,
 * and XML in the XHTML namespace, an SVG or an HTML file runs its scripts
 * with the logged-in session of whoever opens it. So:
 *
 * - every file is sent with `X-Content-Type-Options: nosniff`, so the browser
 *   never guesses a more dangerous type than the one stated;
 * - everything but a PDF and a raster image is sent in a sandbox with no
 *   permissions at all (the Content-Security-Policy `SANDBOX_POLICY` below):
 *   it is still shown, but nothing in it runs or loads. Inline
 *   styles and `data:` pictures are allowed only so the browser's own XML
 *   viewer can draw its tree (it injects both); in a sandbox with no scripts
 *   and an opaque origin they can reach nothing. A PDF is left out because a
 *   sandbox stops the browser's own PDF viewer, which runs no document script
 *   on the app's origin anyway.
 *
 * The type is the one stated at upload, so it is not proof of the content:
 * a file labelled PDF or PNG could be HTML. `nosniff` is what makes the short
 * list of unsandboxed types safe: the browser then treats the file strictly as
 * the stated type, and a disguised file merely fails to show. Never drop it.
 */

const RASTER_IMAGES = new Set(['image/png', 'image/jpeg', 'image/jpg', 'image/pjpeg', 'image/gif', 'image/webp', 'image/avif', 'image/bmp']);

export const SANDBOX_POLICY = "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:";

export function servedFileHeaders(contentType: string): Record<string, string> {
  const type = contentType.toLowerCase().split(';')[0].trim();
  const passive = type === 'application/pdf' || RASTER_IMAGES.has(type);
  return passive
    ? { 'X-Content-Type-Options': 'nosniff' }
    : { 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': SANDBOX_POLICY };
}
