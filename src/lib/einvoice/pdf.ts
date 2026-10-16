/**
 * The XML a ZUGFeRD or Factur-X invoice carries inside its PDF (PDF/A-3
 * embedded file, usually named "factur-x.xml", "zugferd-invoice.xml" or
 * "xrechnung.xml"). Read with pdf-lib, which the app already uses; nothing is
 * rendered and no script in the PDF runs.
 *
 * Every step is bounded, so a small hostile file cannot keep the server busy:
 * the size of the PDF, the nodes of the name tree visited (each once), and the
 * bytes an embedded file may inflate to (inflation stops at the bound).
 */

import { Unzlib } from 'fflate';
import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFNumber, PDFRawStream, PDFString, type PDFObject } from 'pdf-lib';

/** The names the standards give the embedded invoice, preferred in this order (compared without case). */
export const EMBEDDED_INVOICE_NAMES = ['factur-x.xml', 'zugferd-invoice.xml', 'xrechnung.xml'];

/** Larger than any invoice PDF the app takes. */
export const MAX_PDF_BYTES = 25_000_000;
/** Larger than any embedded invoice. */
export const MAX_EMBEDDED_BYTES = 5_000_000;
/** More name tree nodes than any real invoice has. */
const MAX_TREE_NODES = 1_000;

function nameOf(spec: PDFDict): string | null {
  for (const key of ['UF', 'F']) {
    const value = spec.lookup(PDFName.of(key));
    if (value instanceof PDFString || value instanceof PDFHexString) return value.decodeText();
  }
  return null;
}

/** Inflate, stopping as soon as the output passes the bound. */
function inflateBounded(input: Uint8Array, limit: number): Uint8Array | null {
  const chunks: Uint8Array[] = [];
  let size = 0;
  let over = false;
  // FlateDecode is zlib data (RFC 1950), not raw deflate.
  const inflate = new Unzlib((chunk) => {
    if (over) return;
    size += chunk.length;
    if (size > limit) over = true;
    else chunks.push(chunk);
  });
  // Feed in slices so the bound is checked while inflating, not after.
  const step = 16_384;
  for (let offset = 0; offset < input.length && !over; offset += step) {
    inflate.push(input.subarray(offset, offset + step), offset + step >= input.length);
  }
  if (over) return null;
  const out = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

function bytesOf(spec: PDFDict): Uint8Array | null {
  const ef = spec.lookup(PDFName.of('EF'));
  if (!(ef instanceof PDFDict)) return null;
  const stream = ef.lookup(PDFName.of('UF')) ?? ef.lookup(PDFName.of('F'));
  if (!(stream instanceof PDFRawStream)) return null;
  const raw = stream.getContents();
  if (raw.length > MAX_EMBEDDED_BYTES) return null;
  const params = stream.dict.lookup(PDFName.of('Params'));
  const declared = params instanceof PDFDict ? params.lookup(PDFName.of('Size')) : undefined;
  if (declared instanceof PDFNumber && declared.asNumber() > MAX_EMBEDDED_BYTES) return null;
  const filter = stream.dict.lookup(PDFName.of('Filter'));
  const filters = filter instanceof PDFArray ? filter.asArray() : filter ? [filter] : [];
  if (filters.length === 0) return raw;
  // Embedded invoices are stored plain or with FlateDecode; anything else is not read.
  if (filters.length === 1 && filters[0] instanceof PDFName && filters[0].asString() === '/FlateDecode') return inflateBounded(raw, MAX_EMBEDDED_BYTES);
  return null;
}

/** Every file specification of the document: the EmbeddedFiles name tree and the associated files (AF) of PDF/A-3. */
function fileSpecs(document: PDFDocument): PDFDict[] {
  const specs: PDFDict[] = [];
  const visited = new Set<PDFDict>();
  const visit = (node: PDFObject | undefined) => {
    if (!(node instanceof PDFDict) || visited.has(node) || visited.size >= MAX_TREE_NODES) return;
    visited.add(node);
    const names = node.lookup(PDFName.of('Names'));
    if (names instanceof PDFArray) {
      for (let i = 1; i < names.size(); i += 2) {
        const spec = names.lookup(i);
        if (spec instanceof PDFDict && !specs.includes(spec)) specs.push(spec);
      }
    }
    const kids = node.lookup(PDFName.of('Kids'));
    if (kids instanceof PDFArray) for (let i = 0; i < kids.size(); i++) visit(kids.lookup(i));
  };
  const catalogNames = document.catalog.lookup(PDFName.of('Names'));
  if (catalogNames instanceof PDFDict) visit(catalogNames.lookup(PDFName.of('EmbeddedFiles')));
  const associated = document.catalog.lookup(PDFName.of('AF'));
  if (associated instanceof PDFArray) {
    for (let i = 0; i < associated.size() && i < MAX_TREE_NODES; i++) {
      const spec = associated.lookup(i);
      if (spec instanceof PDFDict && !specs.includes(spec)) specs.push(spec);
    }
  }
  return specs;
}

/**
 * Every embedded XML file of a PDF, a known invoice name first, then the
 * others in the order the document lists them; empty for an ordinary PDF, an
 * encrypted one, or one that cannot be opened. The caller reads each until
 * one is an invoice.
 */
export async function embeddedXmlFiles(pdf: Uint8Array): Promise<Array<{ name: string; xml: string }>> {
  if (pdf.length > MAX_PDF_BYTES) return [];
  let document: PDFDocument;
  let specs: PDFDict[];
  try {
    document = await PDFDocument.load(pdf, { ignoreEncryption: true, updateMetadata: false, throwOnInvalidObject: false });
    // An encrypted PDF stores its file names and contents encrypted: nothing here can be read.
    if (document.isEncrypted) return [];
    specs = fileSpecs(document);
  } catch {
    return [];
  }
  const candidates: Array<{ name: string; spec: PDFDict; rank: number; order: number }> = [];
  specs.forEach((spec, order) => {
    const name = nameOf(spec);
    if (!name || !name.toLowerCase().endsWith('.xml')) return;
    const known = EMBEDDED_INVOICE_NAMES.indexOf(name.toLowerCase());
    candidates.push({ name, spec, rank: known === -1 ? EMBEDDED_INVOICE_NAMES.length : known, order });
  });
  candidates.sort((a, b) => a.rank - b.rank || a.order - b.order);
  const files: Array<{ name: string; xml: string }> = [];
  for (const candidate of candidates) {
    try {
      const bytes = bytesOf(candidate.spec);
      if (bytes) files.push({ name: candidate.name, xml: new TextDecoder('utf-8').decode(bytes) });
    } catch {
      // A broken stream: the next file may still be the invoice.
    }
  }
  return files;
}
