import { createHash } from 'node:crypto';
import type { DeliveryOutcome, NotificationChannel, NotificationMessage, Recipient } from './port';

/**
 * E-mail through Resend's HTTP interface (the mail service the suite already
 * uses), with plain `fetch`: no extra package. Off until the server holds
 * `RESEND_API_KEY` and `SPENDING_MAIL_FROM` (a sender on a domain verified at
 * Resend) and `APP_BASE_URL` (so the mail can link back into the app).
 */

export interface EmailConfig {
  apiKey: string;
  from: string;
  baseUrl: string;
}

export function emailConfigFromEnv(env: Record<string, string | undefined> = process.env): EmailConfig | null {
  const apiKey = env.RESEND_API_KEY?.trim();
  const from = env.SPENDING_MAIL_FROM?.trim();
  const baseUrl = env.APP_BASE_URL?.trim();
  return apiKey && from && baseUrl ? { apiKey, from, baseUrl: baseUrl.replace(/\/+$/, '') } : null;
}

const escapeHtml = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function renderEmail(message: NotificationMessage, baseUrl: string): { subject: string; text: string; html: string } {
  const url = `${baseUrl}${message.path}`;
  return {
    subject: message.title,
    text: `${message.body}\n\n${url}\n`,
    html: `<!doctype html><html lang="de"><head><meta charset="utf-8"></head><body><p>${escapeHtml(message.body)}</p><p><a href="${escapeHtml(url)}">In der App öffnen</a></p></body></html>`,
  };
}

/**
 * The key the mail service drops repeated sends by: one per notification and
 * address, so a retry after the address changed is a new send, not a conflict.
 */
export function idempotencyKey(recipient: Recipient, message: NotificationMessage): string {
  const address = createHash('sha256').update((recipient.email ?? '').toLowerCase()).digest('hex').slice(0, 16);
  return `${recipient.workspaceId}:${message.subjectKey}:${address}`;
}

export function createEmailChannel(config: EmailConfig | null, fetchImpl: typeof fetch = fetch): NotificationChannel {
  return {
    name: 'email',
    async send(recipient: Recipient, message: NotificationMessage): Promise<DeliveryOutcome> {
      if (!config) return { status: 'unavailable', detail: 'e-mail is not configured on the server' };
      if (!recipient.email) return { status: 'unavailable', detail: 'no address set' };
      const mail = renderEmail(message, config.baseUrl);
      let res: Response;
      try {
        res = await fetchImpl('https://api.resend.com/emails', {
          method: 'POST',
          headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey(recipient, message) },
          body: JSON.stringify({ from: config.from, to: [recipient.email], subject: mail.subject, text: mail.text, html: mail.html }),
          signal: AbortSignal.timeout(15_000),
        });
      } catch (e) {
        return { status: 'failed', detail: e instanceof Error ? e.message : 'network error' };
      }
      if (res.ok) return { status: 'sent' };
      return { status: 'failed', detail: `mail service answered ${res.status}` };
    },
  };
}
