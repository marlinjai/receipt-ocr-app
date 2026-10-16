/**
 * The XML a ZUGFeRD or Factur-X invoice carries inside its PDF (PDF/A-3
 * embedded file, usually named "factur-x.xml", "zugferd-invoice.xml" or
 * "xrechnung.xml"). Read with pdf-lib, which the app already uses; nothing is
 * rendered and no script in the PDF runs.
 */

import { decodePDFRawStream, PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFRawStream, PDFString, type PDFObject } from 'pdf-lib';

/** The names the standards give the embedded invoice, preferred in this order (compared without case). */
export const EMBEDDED_INVOICE_NAMES = ['factur-x.xml', 'zugferd-invoice.xml', 'xrechnung.xml'];

/** Larger than any embedded invoice: a bound for a hostile file. */
const MAX_EMBEDDED_BYTES = 5_000_000;

function nameOf(spec: PDFDict): string | null {
  for (const key of ['UF', 'F']) {
    const value = spec.lookup(PDFName.of(key));
    if (value instanceof PDFString || value instanceof PDFHexString) return value.decodeText();
  }
  return null;
}

function bytesOf(spec: PDFDict): Uint8Array | null {
  const ef = spec.lookup(PDFName.of('EF'));
  if (!(ef instanceof PDFDict)) return null;
  const stream = ef.lookup(PDFName.of('UF')) ?? ef.lookup(PDFName.of('F'));
  if (!(stream instanceof PDFRawStream)) return null;
  const bytes = decodePDFRawStream(stream).decode();
  return bytes.length > MAX_EMBEDDED_BYTES ? null : bytes;
}

/** Every file specification of the document: the EmbeddedFiles name tree and the associated files (AF) of PDF/A-3. */
function fileSpecs(document: PDFDocument): PDFDict[] {
  const specs: PDFDict[] = [];
  const visit = (node: PDFObject | undefined, depth: number) => {
    if (!(node instanceof PDFDict) || depth > 10) return;
    const names = node.lookup(PDFName.of('Names'));
    if (names instanceof PDFArray) {
      for (let i = 1; i < names.size(); i += 2) {
        const spec = names.lookup(i);
        if (spec instanceof PDFDict) specs.push(spec);
      }
    }
    const kids = node.lookup(PDFName.of('Kids'));
    if (kids instanceof PDFArray) for (let i = 0; i < kids.size(); i++) visit(kids.lookup(i), depth + 1);
  };
  const catalogNames = document.catalog.lookup(PDFName.of('Names'));
  if (catalogNames instanceof PDFDict) visit(catalogNames.lookup(PDFName.of('EmbeddedFiles')), 0);
  const associated = document.catalog.lookup(PDFName.of('AF'));
  if (associated instanceof PDFArray) {
    for (let i = 0; i < associated.size(); i++) {
      const spec = associated.lookup(i);
      if (spec instanceof PDFDict && !specs.includes(spec)) specs.push(spec);
    }
  }
  return specs;
}

/**
 * The embedded invoice XML of a PDF, or null when it carries none (an
 * ordinary PDF) or cannot be opened. A known invoice name is preferred; any
 * other embedded XML file is offered last, and the caller decides by reading
 * it whether it is an invoice.
 */
export async function embeddedInvoiceXml(pdf: Uint8Array): Promise<{ name: string; xml: string } | null> {
  let document: PDFDocument;
  try {
    document = await PDFDocument.load(pdf, { ignoreEncryption: true, updateMetadata: false, throwOnInvalidObject: false });
  } catch {
    return null;
  }
  let specs: PDFDict[];
  try {
    specs = fileSpecs(document);
  } catch {
    // A PDF without a readable catalog carries nothing we can find.
    return null;
  }
  const candidates: Array<{ name: string; spec: PDFDict; rank: number }> = [];
  for (const spec of specs) {
    const name = nameOf(spec);
    if (!name || !name.toLowerCase().endsWith('.xml')) continue;
    const known = EMBEDDED_INVOICE_NAMES.findIndex((n) => n.toLowerCase() === name.toLowerCase());
    candidates.push({ name, spec, rank: known === -1 ? EMBEDDED_INVOICE_NAMES.length : known });
  }
  candidates.sort((a, b) => a.rank - b.rank);
  for (const candidate of candidates) {
    try {
      const bytes = bytesOf(candidate.spec);
      if (bytes) return { name: candidate.name, xml: new TextDecoder('utf-8').decode(bytes) };
    } catch {
      // A broken stream: try the next file.
    }
  }
  return null;
}
