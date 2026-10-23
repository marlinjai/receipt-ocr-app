import { MAX_ATTACHMENT_BYTES, READABLE_TYPES, MailboxError, unconfiguredMailbox, type MailAttachment, type MailCandidate, type MailSearch, type MailboxPort } from './port';

/**
 * The mailbox adapter for Google Workspace mail, read through the Gmail
 * interface with plain `fetch` (no extra package), read-only
 * (`gmail.readonly`). The expenses address delivers into a larger mailbox, so
 * the search is limited to mail delivered to that address.
 *
 * Off until the server holds all five settings (Infisical, receipts project;
 * see the README, "Ausgaben-Postfach"): `SPENDING_MAILBOX_CLIENT_ID` and
 * `SPENDING_MAILBOX_CLIENT_SECRET` (a Google Open Authorization (OAuth)
 * client), `SPENDING_MAILBOX_REFRESH_TOKEN` (granted once by the mailbox owner
 * for the read-only mail scope), `SPENDING_MAILBOX_ADDRESS` (the address the
 * invoices are sent to) and `SPENDING_MAILBOX_WORKSPACE_ID` (the one company
 * the mailbox belongs to).
 */

export const GMAIL_READONLY_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const API = 'https://gmail.googleapis.com/gmail/v1/users/me';
/** Mails looked at per search: an invoice is among the first few hits or not there. */
export const MAX_MESSAGES = 10;
/** The parts of a mail the search reads. */
const MESSAGE_FIELDS = 'id,internalDate,payload(headers,filename,mimeType,body(attachmentId,size),parts(filename,mimeType,body(attachmentId,size),parts(filename,mimeType,body(attachmentId,size),parts)))';

export interface GmailConfig {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  address: string;
  /** The workspace (company) the mailbox belongs to. */
  workspaceId: string;
}

export const MAILBOX_SETTINGS = [
  'SPENDING_MAILBOX_CLIENT_ID',
  'SPENDING_MAILBOX_CLIENT_SECRET',
  'SPENDING_MAILBOX_REFRESH_TOKEN',
  'SPENDING_MAILBOX_ADDRESS',
  'SPENDING_MAILBOX_WORKSPACE_ID',
] as const;

export function gmailConfigFromEnv(env: Record<string, string | undefined> = process.env): GmailConfig | { missing: string[] } {
  const missing = MAILBOX_SETTINGS.filter((k) => !env[k]?.trim());
  if (missing.length > 0) return { missing };
  return {
    clientId: (env.SPENDING_MAILBOX_CLIENT_ID as string).trim(),
    clientSecret: (env.SPENDING_MAILBOX_CLIENT_SECRET as string).trim(),
    refreshToken: (env.SPENDING_MAILBOX_REFRESH_TOKEN as string).trim(),
    address: (env.SPENDING_MAILBOX_ADDRESS as string).trim(),
    workspaceId: (env.SPENDING_MAILBOX_WORKSPACE_ID as string).trim(),
  };
}

const gmailDay = (iso: string) => iso.replace(/-/g, '/');
const quote = (text: string) => `"${text.replace(/"/g, '')}"`;

/** The amount as invoices write it: "29,99" and "29.99", and "1.234,56" / "1,234.56" above a thousand. */
export function amountSpellings(cents: number): string[] {
  const euros = Math.floor(cents / 100);
  const rest = String(cents % 100).padStart(2, '0');
  const grouped = (sep: string) => String(euros).replace(/\B(?=(\d{3})+(?!\d))/g, sep);
  const out = new Set([`${euros},${rest}`, `${euros}.${rest}`, `${grouped('.')},${rest}`, `${grouped(',')}.${rest}`]);
  return [...out];
}

/** The Gmail search: delivered to the expenses address (also by blind copy or forwarding), with an attachment, in the window, naming the vendor and the amount. */
export function buildQuery(address: string, query: MailSearch): string {
  const after = new Date(Date.parse(`${query.fromDay}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
  const before = new Date(Date.parse(`${query.toDay}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
  const vendor = query.vendorWords.filter((w) => w.trim().length >= 2).map(quote);
  const amounts = amountSpellings(query.amountCents).map(quote);
  return [
    `{to:${address} deliveredto:${address}}`,
    'has:attachment',
    `after:${gmailDay(after)}`,
    `before:${gmailDay(before)}`,
    vendor.length > 0 ? `{${vendor.join(' ')}}` : '',
    `{${amounts.join(' ')}}`,
  ]
    .filter(Boolean)
    .join(' ');
}

interface GmailPart {
  filename?: string;
  mimeType?: string;
  body?: { attachmentId?: string; size?: number };
  parts?: GmailPart[];
}

interface GmailMessage {
  id: string;
  internalDate?: string;
  payload?: GmailPart & { headers?: Array<{ name: string; value: string }> };
}

/** Every attachment in a message's part tree that the upload path can read. */
export function readableAttachments(message: GmailMessage): Array<{ attachmentId: string; fileName: string; mimeType: string; size?: number }> {
  const out: Array<{ attachmentId: string; fileName: string; mimeType: string; size?: number }> = [];
  const walk = (part: GmailPart | undefined) => {
    if (!part) return;
    const type = (part.mimeType ?? '').toLowerCase();
    const byName = /\.pdf$/i.test(part.filename ?? '') ? 'application/pdf' : type;
    if (part.body?.attachmentId && part.filename && READABLE_TYPES.includes(byName)) {
      out.push({ attachmentId: part.body.attachmentId, fileName: part.filename, mimeType: byName, ...(part.body.size !== undefined ? { size: part.body.size } : {}) });
    }
    for (const child of part.parts ?? []) walk(child);
  };
  walk(message.payload);
  return out;
}

const header = (message: GmailMessage, name: string) => message.payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? '';

function base64UrlToBytes(data: string): Uint8Array {
  return new Uint8Array(Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64'));
}

export function createGmailMailbox(config: GmailConfig, fetchImpl: typeof fetch = fetch): MailboxPort {
  let token: { value: string; until: number } | null = null;

  async function accessToken(signal?: AbortSignal): Promise<string> {
    if (token && token.until > Date.now() + 30_000) return token.value;
    let res: Response;
    try {
      const timeout = AbortSignal.timeout(15_000);
      res = await fetchImpl(TOKEN_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: config.clientId, client_secret: config.clientSecret, refresh_token: config.refreshToken, grant_type: 'refresh_token' }),
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
    } catch (e) {
      throw new MailboxError('unavailable', e instanceof Error ? e.message : 'network error');
    }
    // A revoked or expired grant answers 400 or 401: the owner has to grant access again.
    if (res.status === 400 || res.status === 401) throw new MailboxError('auth_failed', `token endpoint answered ${res.status}`);
    if (!res.ok) throw new MailboxError('unavailable', `token endpoint answered ${res.status}`);
    const body = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!body.access_token) throw new MailboxError('auth_failed', 'no access token');
    token = { value: body.access_token, until: Date.now() + (body.expires_in ?? 3600) * 1000 };
    return token.value;
  }

  async function get<T>(path: string, signal?: AbortSignal): Promise<T> {
    let res: Response;
    try {
      const timeout = AbortSignal.timeout(15_000);
      res = await fetchImpl(`${API}${path}`, { headers: { Authorization: `Bearer ${await accessToken(signal)}` }, signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
    } catch (e) {
      if (e instanceof MailboxError) throw e;
      throw new MailboxError('unavailable', e instanceof Error ? e.message : 'network error');
    }
    if (res.status === 401) throw new MailboxError('auth_failed', 'mail interface answered 401');
    if (res.status === 403 || res.status === 429) {
      // Gmail answers 403 for a rate limit too: that is a pause, not a revoked grant.
      const body = (await res.json().catch(() => ({}))) as { error?: { errors?: Array<{ reason?: string }> } };
      const reason = body.error?.errors?.[0]?.reason ?? '';
      if (res.status === 429 || /rateLimit|quota/i.test(reason)) throw new MailboxError('unavailable', `rate limited (${reason || res.status})`);
      throw new MailboxError('auth_failed', `mail interface answered 403 ${reason}`.trim());
    }
    if (res.status === 404) throw new MailboxError('not_found');
    if (!res.ok) throw new MailboxError('unavailable', `mail interface answered ${res.status}`);
    return (await res.json()) as T;
  }

  return {
    status: () => ({ configured: true }),
    async search(query: MailSearch, signal?: AbortSignal): Promise<MailCandidate[]> {
      const q = buildQuery(config.address, query);
      const list = await get<{ messages?: Array<{ id: string }> }>(`/messages?maxResults=${MAX_MESSAGES}&q=${encodeURIComponent(q)}`, signal);
      // Three mails at a time, only the fields needed.
      const ids = (list.messages ?? []).map((m) => m.id);
      const messages: Array<GmailMessage | null> = [];
      for (let i = 0; i < ids.length; i += 3) {
        messages.push(
          ...(await Promise.all(
            ids.slice(i, i + 3).map((id) =>
              get<GmailMessage>(`/messages/${encodeURIComponent(id)}?format=full&fields=${encodeURIComponent(MESSAGE_FIELDS)}`, signal).catch((e) => {
                // A mail deleted between the list and the read is simply not there.
                if (e instanceof MailboxError && e.code === 'not_found') return null;
                throw e;
              }),
            ),
          )),
        );
      }
      const out: MailCandidate[] = [];
      for (const message of messages) {
        if (!message) continue;
        const receivedDay = message.internalDate ? new Date(Number(message.internalDate)).toISOString().slice(0, 10) : query.fromDay;
        for (const [partIndex, a] of readableAttachments(message).entries()) {
          out.push({ messageId: message.id, partIndex, fileName: a.fileName, mimeType: a.mimeType, receivedDay, subject: header(message, 'Subject'), from: header(message, 'From') });
        }
      }
      return out;
    },
    async fetchAttachment(messageId: string, partIndex: number, fileName: string): Promise<MailAttachment> {
      const message = await get<GmailMessage>(`/messages/${encodeURIComponent(messageId)}?format=full`);
      const meta = readableAttachments(message)[partIndex];
      if (!meta || meta.fileName !== fileName) throw new MailboxError('not_found');
      // Too large for a receipt: refused before downloading it (the check after decoding stays as a backstop).
      if (meta.size !== undefined && meta.size > MAX_ATTACHMENT_BYTES) throw new MailboxError('too_large');
      const body = await get<{ data?: string }>(`/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(meta.attachmentId)}`);
      if (!body.data) throw new MailboxError('not_found');
      const bytes = base64UrlToBytes(body.data);
      if (bytes.byteLength > MAX_ATTACHMENT_BYTES) throw new MailboxError('too_large');
      return { bytes, mimeType: meta.mimeType, fileName: meta.fileName };
    },
  };
}

/**
 * The mailbox of a workspace: the Gmail adapter for the company the mailbox
 * belongs to, off for every other company, and off with the missing settings
 * named when it is not set up. Callers go through `mailboxFor` (`server.ts`),
 * which also lets a company receiving private payments of the mailbox's
 * company use it.
 */
export function serverMailbox(workspaceId: string, env: Record<string, string | undefined> = process.env): MailboxPort {
  const config = gmailConfigFromEnv(env);
  if ('missing' in config) return unconfiguredMailbox(config.missing);
  if (config.workspaceId !== workspaceId) return unconfiguredMailbox([], 'other_company');
  return createGmailMailbox(config);
}
