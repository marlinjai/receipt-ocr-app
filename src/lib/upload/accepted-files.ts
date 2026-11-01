/**
 * The files an upload takes: photos and scans (any image), PDF documents, and
 * electronic invoices that come as a pure XML file (XRechnung; read from their
 * structured data by `src/lib/einvoice`). Shared by the batch uploader, the
 * share target of the installed app (`public/sw.js` repeats the rule as a
 * literal, a test compares them) and its manifest.
 */

export const XML_TYPES = ['application/xml', 'text/xml'] as const;

/** The `accept` attribute of a file input that takes everything an upload takes. */
export const UPLOAD_ACCEPT = 'image/*,application/pdf,.xml,application/xml,text/xml';

const isXmlName = (name: string) => /\.xml$/i.test(name.trim());

/** True for a file an upload takes. An XML file is recognised by its type or, when the browser gives none, by its name. */
export function isAcceptedUpload(file: { type: string; name: string }): boolean {
  if (file.type.startsWith('image/') || file.type === 'application/pdf') return true;
  if ((XML_TYPES as readonly string[]).includes(file.type)) return true;
  return file.type === '' && isXmlName(file.name);
}

/**
 * The file as it is sent: an XML file the browser gave no type (or the
 * generic one) is sent as `application/xml`, so the store and the reader know
 * what it is.
 */
export function withUploadType(file: File): File {
  if (!isXmlName(file.name) || (XML_TYPES as readonly string[]).includes(file.type)) return file;
  if (file.type !== '' && file.type !== 'application/octet-stream') return file;
  return new File([file], file.name, { type: 'application/xml', lastModified: file.lastModified });
}
