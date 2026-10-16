import type { MailboxError } from './port';

/** Pieces of the mail attachment download route (src/app/api/spending/mail-attachment), kept here so they can be tested. */

/** The HTTP status for each way a download can fail, with a stable code the page turns into words. */
export const DOWNLOAD_STATUS: Record<MailboxError['code'], number> = {
  not_found: 404,
  not_configured: 503,
  auth_failed: 502,
  unavailable: 502,
  too_large: 413,
};

/** A file name for `Content-Disposition` (RFC 5987 extended form, with a plain ASCII fallback). */
export function contentDisposition(fileName: string): string {
  const encoded = encodeURIComponent(fileName).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  const ascii = fileName.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_') || 'rechnung';
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}
