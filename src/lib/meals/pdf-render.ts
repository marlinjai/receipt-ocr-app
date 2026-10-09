/**
 * Draw one page of a PDF receipt as a picture, in the browser.
 *
 * A PDF shown in a browser frame cannot be turned, zoomed, dragged or fitted
 * to its panel. Rendered to a picture it can, with the same code that shows a
 * photographed receipt. The renderer (pdf.js) is loaded only when a PDF is
 * actually opened, so it stays out of every other page.
 */

export interface RenderedPage {
  /** An object URL of the page as a PNG. The caller revokes it when done. */
  url: string;
  /** Size of the page in CSS pixels at 100 percent. */
  width: number;
  height: number;
  /** How many pages the document has. */
  pageCount: number;
}

/** Long edge of the rendered picture: sharp when zoomed in, small enough to draw at once. */
const TARGET_LONG_EDGE = 2400;
const MAX_RENDER_SCALE = 4;

export async function renderPdfPage(fileUrl: string, pageNumber: number, signal?: AbortSignal): Promise<RenderedPage> {
  const response = await fetch(fileUrl, { credentials: 'same-origin', signal });
  if (!response.ok) throw new Error(`receipt download failed (${response.status})`);
  const data = new Uint8Array(await response.arrayBuffer());

  const pdfjs = await import('pdfjs-dist');
  if (!pdfjs.GlobalWorkerOptions.workerSrc) {
    pdfjs.GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).toString();
  }
  const task = pdfjs.getDocument({ data });
  const doc = await task.promise;
  try {
    const page = await doc.getPage(Math.min(Math.max(1, pageNumber), doc.numPages));
    // Scale 1 is the page at 72 points per inch, with the page's own /Rotate entry applied.
    const base = page.getViewport({ scale: 1 });
    const scale = Math.min(MAX_RENDER_SCALE, TARGET_LONG_EDGE / Math.max(base.width, base.height));
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    const context = canvas.getContext('2d');
    if (!context) throw new Error('no drawing surface for the receipt');
    await page.render({ canvas, canvasContext: context, viewport }).promise;
    if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
    if (!blob) throw new Error('the receipt page could not be drawn');
    return { url: URL.createObjectURL(blob), width: base.width, height: base.height, pageCount: doc.numPages };
  } finally {
    void task.destroy();
  }
}
