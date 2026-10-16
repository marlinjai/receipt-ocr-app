import { describe, expect, it, vi } from 'vitest';
import { amountSpellings, buildQuery, createGmailMailbox, gmailConfigFromEnv, readableAttachments, serverMailbox } from '../mailbox/gmail';
import { MailboxError, mailWordsFor, searchFor, unconfiguredMailbox } from '../mailbox/port';
import { DOWNLOAD_STATUS, contentDisposition } from '../mailbox/download';

/** Every address and name here is invented; the credentials are made up at run time. */
const fake = (label: string) => `${label}-${Math.random().toString(36).slice(2)}`;
const config = () => ({ clientId: fake('client'), clientSecret: fake('secret'), refreshToken: fake('refresh'), address: 'expenses@example.com', workspaceId: 'ws-owner' });
const search = (words: string[] = ['zyx handel']) => searchFor({ bookingDay: '2026-05-10', amountCents: -2999 }, words)!;

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const message = {
  id: 'm1',
  internalDate: String(Date.parse('2026-05-09T10:00:00Z')),
  payload: {
    headers: [
      { name: 'Subject', value: 'Ihre Rechnung' },
      { name: 'From', value: 'billing@zyx.example' },
    ],
    parts: [
      { mimeType: 'text/plain', filename: '', body: {} },
      { mimeType: 'application/octet-stream', filename: 'Rechnung-4711.PDF', body: { attachmentId: 'att-a' } },
      { mimeType: 'multipart/mixed', parts: [{ mimeType: 'image/png', filename: 'beleg.png', body: { attachmentId: 'att-b' } }] },
      { mimeType: 'application/zip', filename: 'archiv.zip', body: { attachmentId: 'att-c' } },
    ],
  },
};

describe('search building', () => {
  it('spells the amount the ways invoices write it', () => {
    expect(amountSpellings(2999)).toEqual(['29,99', '29.99']);
    expect(amountSpellings(123_456)).toEqual(['1234,56', '1234.56', '1.234,56', '1,234.56']);
  });

  it('searches mail to the expenses address with an attachment, in the window, naming vendor and amount', () => {
    const q = buildQuery('expenses@example.com', search(['zyx handel', 'zyx']));
    expect(q).toBe('{to:expenses@example.com deliveredto:expenses@example.com} has:attachment after:2026/04/25 before:2026/05/14 {"zyx handel" "zyx"} {"29,99" "29.99"}');
  });

  it('does not search for a payment that names nobody: an amount alone finds any mail', () => {
    expect(searchFor({ bookingDay: '2026-05-10', amountCents: -500 }, [])).toBeNull();
    expect(searchFor({ bookingDay: '2026-05-10', amountCents: -500 }, ['', ' x '])).toBeNull();
  });
});

describe('attachments', () => {
  it('finds the readable attachments anywhere in the mail, a PDF also by its name', () => {
    expect(readableAttachments(message)).toEqual([
      { attachmentId: 'att-a', fileName: 'Rechnung-4711.PDF', mimeType: 'application/pdf' },
      { attachmentId: 'att-b', fileName: 'beleg.png', mimeType: 'image/png' },
    ]);
  });
});

describe('configuration', () => {
  it('is off until all five settings are there, and says which are missing', () => {
    expect(gmailConfigFromEnv({})).toEqual({
      missing: ['SPENDING_MAILBOX_CLIENT_ID', 'SPENDING_MAILBOX_CLIENT_SECRET', 'SPENDING_MAILBOX_REFRESH_TOKEN', 'SPENDING_MAILBOX_ADDRESS', 'SPENDING_MAILBOX_WORKSPACE_ID'],
    });
    expect(serverMailbox('ws-owner', {}).status()).toMatchObject({ configured: false });
  });

  it('belongs to one company: for every other one it is off', () => {
    const env = {
      SPENDING_MAILBOX_CLIENT_ID: fake('c'),
      SPENDING_MAILBOX_CLIENT_SECRET: fake('s'),
      SPENDING_MAILBOX_REFRESH_TOKEN: fake('r'),
      SPENDING_MAILBOX_ADDRESS: 'expenses@example.com',
      SPENDING_MAILBOX_WORKSPACE_ID: 'ws-owner',
    };
    expect(serverMailbox('ws-owner', env).status()).toEqual({ configured: true });
    expect(serverMailbox('ws-other', env).status()).toEqual({ configured: false, missing: [], reason: 'other_company' });
  });

  it('an unconfigured mailbox refuses every call instead of pretending', async () => {
    const off = unconfiguredMailbox(['X']);
    await expect(off.search(search())).rejects.toMatchObject({ code: 'not_configured' });
    await expect(off.fetchAttachment('m', 0, 'f')).rejects.toBeInstanceOf(MailboxError);
  });
});

describe('Gmail adapter, more', () => {
  it('skips a mail deleted between the list and the read', async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const u = String(url);
      if (u.includes('oauth2')) return json({ access_token: fake('a'), expires_in: 3600 });
      if (u.includes('/messages?')) return json({ messages: [{ id: 'gone' }, { id: 'm1' }] });
      if (u.includes('/messages/gone')) return json({}, 404);
      if (u.includes('/messages/m1')) return json(message);
      return json({}, 500);
    });
    const found = await createGmailMailbox(config(), fetchImpl as unknown as typeof fetch).search(search());
    expect(found.map((f) => f.fileName)).toEqual(['Rechnung-4711.PDF', 'beleg.png']);
  });

  it('refuses an attachment larger than a receipt can be', async () => {
    const big = Buffer.alloc(20 * 1024 * 1024 + 1).toString('base64url');
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const u = String(url);
      if (u.includes('oauth2')) return json({ access_token: fake('a'), expires_in: 3600 });
      if (u.includes('/attachments/')) return json({ data: big });
      return json(message);
    });
    await expect(createGmailMailbox(config(), fetchImpl as unknown as typeof fetch).fetchAttachment('m1', 0, 'Rechnung-4711.PDF')).rejects.toMatchObject({ code: 'too_large' });
  });
});

describe('Gmail adapter', () => {
  function server(overrides: Partial<Record<'token' | 'list' | 'message' | 'attachment', Response>> = {}) {
    return vi.fn(async (url: string | URL | Request) => {
      const u = String(url);
      if (u.includes('oauth2.googleapis.com')) return overrides.token ?? json({ access_token: fake('access'), expires_in: 3600 });
      if (u.includes('/attachments/')) return overrides.attachment ?? json({ data: Buffer.from('%PDF-1.4').toString('base64url') });
      if (u.includes('/messages/m1')) return overrides.message ?? json(message);
      if (u.includes('/messages?')) return overrides.list ?? json({ messages: [{ id: 'm1' }] });
      return new Response('', { status: 500 });
    });
  }

  it('finds the attachments of matching mails, with their place, name and day', async () => {
    const fetchImpl = server();
    const box = createGmailMailbox(config(), fetchImpl as unknown as typeof fetch);
    const found = await box.search(search());
    expect(found).toEqual([
      { messageId: 'm1', partIndex: 0, fileName: 'Rechnung-4711.PDF', mimeType: 'application/pdf', receivedDay: '2026-05-09', subject: 'Ihre Rechnung', from: 'billing@zyx.example' },
      { messageId: 'm1', partIndex: 1, fileName: 'beleg.png', mimeType: 'image/png', receivedDay: '2026-05-09', subject: 'Ihre Rechnung', from: 'billing@zyx.example' },
    ]);
    // The access token is fetched once and reused.
    expect(fetchImpl.mock.calls.filter(([u]) => String(u).includes('oauth2')).length).toBe(1);
  });

  it('downloads an attachment by its place, checking the name, with the attachment id read anew', async () => {
    const fetchImpl = server();
    const box = createGmailMailbox(config(), fetchImpl as unknown as typeof fetch);
    const file = await box.fetchAttachment('m1', 0, 'Rechnung-4711.PDF');
    expect(new TextDecoder().decode(file.bytes)).toBe('%PDF-1.4');
    expect(file).toMatchObject({ mimeType: 'application/pdf', fileName: 'Rechnung-4711.PDF' });
    await expect(box.fetchAttachment('m1', 0, 'anderer-name.pdf')).rejects.toMatchObject({ code: 'not_found' });
    await expect(box.fetchAttachment('m1', 5, 'x')).rejects.toMatchObject({ code: 'not_found' });
  });

  it('reports a revoked grant as an authorization failure, and an outage as unavailable', async () => {
    const revoked = createGmailMailbox(config(), server({ token: json({ error: 'invalid_grant' }, 400) }) as unknown as typeof fetch);
    await expect(revoked.search(search())).rejects.toMatchObject({ code: 'auth_failed' });
    const forbidden = createGmailMailbox(config(), server({ list: json({ error: { errors: [{ reason: 'insufficientPermissions' }] } }, 403) }) as unknown as typeof fetch);
    await expect(forbidden.search(search())).rejects.toMatchObject({ code: 'auth_failed' });
    // A rate limit is answered with 403 too: a pause, not a revoked grant.
    const limited = createGmailMailbox(config(), server({ list: json({ error: { errors: [{ reason: 'userRateLimitExceeded' }] } }, 403) }) as unknown as typeof fetch);
    await expect(limited.search(search())).rejects.toMatchObject({ code: 'unavailable' });
    const tooMany = createGmailMailbox(config(), server({ list: json({}, 429) }) as unknown as typeof fetch);
    await expect(tooMany.search(search())).rejects.toMatchObject({ code: 'unavailable' });
    const down = createGmailMailbox(config(), server({ list: json({}, 503) }) as unknown as typeof fetch);
    await expect(down.search(search())).rejects.toMatchObject({ code: 'unavailable' });
    const offline = createGmailMailbox(config(), vi.fn(async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch);
    await expect(offline.search(search())).rejects.toMatchObject({ code: 'unavailable' });
  });
});

describe('download helpers', () => {
  it('names the file in both forms, escaping what the extended form does not allow', () => {
    expect(contentDisposition("Rechnung (März)'s.pdf")).toBe(`attachment; filename="Rechnung (M_rz)'s.pdf"; filename*=UTF-8''Rechnung%20%28M%C3%A4rz%29%27s.pdf`);
    expect(contentDisposition('a"b.pdf')).toContain('filename="a_b.pdf"');
  });
  it('maps every failure to a status', () => {
    expect(DOWNLOAD_STATUS).toEqual({ not_found: 404, not_configured: 503, auth_failed: 502, unavailable: 502, too_large: 413 });
  });
});

describe('mailWordsFor', () => {
  it('keeps umlauts and drops the legal form, adds a long first word, the key and the aliases', () => {
    expect(mailWordsFor('Müller Werkzeug GmbH', 'mueller werkzeug', ['mw shop'])).toEqual(['Müller Werkzeug', 'Müller', 'mueller werkzeug', 'mw shop']);
    expect(mailWordsFor('PAYPAL EUROPE S.A.R.L. ET CIE S.C.A.', 'paypal europe s a r l et cie s c a')).toEqual(['PAYPAL EUROPE', 'PAYPAL', 'paypal europe s a r l et cie s c a']);
    expect(mailWordsFor('Zyx Handel', 'zyx handel')).toEqual(['Zyx Handel', 'zyx handel']);
  });
});
