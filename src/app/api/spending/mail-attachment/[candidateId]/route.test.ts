import { beforeEach, describe, expect, it, vi } from 'vitest';

/** The attachment download: the write check, the active company only, the mailbox's answers. Auth, database and mailbox are replaced. */

const requireAction = vi.fn();
const findMailCandidate = vi.fn();
const fetchAttachment = vi.fn();
const mailboxFor = vi.fn(async () => ({ fetchAttachment: (...a: unknown[]) => fetchAttachment(...a) }));

vi.mock('@/lib/auth', () => ({ auth: { requireAction: (...a: unknown[]) => requireAction(...a) } }));
vi.mock('@/lib/prisma', () => ({ prisma: { marker: 'prisma' } }));
vi.mock('@/lib/spending/mailbox/service', () => ({ findMailCandidate: (...a: unknown[]) => findMailCandidate(...a) }));
vi.mock('@/lib/spending/mailbox/server', () => ({ mailboxFor: (...a: unknown[]) => (mailboxFor as (...x: unknown[]) => unknown)(...a) }));

import { MailboxError } from '@/lib/spending/mailbox/port';
import { GET } from './route';
import { SANDBOX_POLICY } from '@/lib/files/served-file-headers';

const WS = { id: 'ws-a', slug: 'beispiel', role: 'member', tenantId: 't-a' };
const SESSION = { memberships: [WS], activeWorkspace: WS };
const call = (id = 'c1') => GET(new Request('http://localhost/api/spending/mail-attachment/c1'), { params: Promise.resolve({ candidateId: id }) });

beforeEach(() => {
  requireAction.mockReset();
  findMailCandidate.mockReset();
  fetchAttachment.mockReset();
  mailboxFor.mockClear();
});

describe('GET /api/spending/mail-attachment/:id', () => {
  it('answers 401 without a session and 403 without the write permission, reading nothing', async () => {
    requireAction.mockRejectedValue(Object.assign(new Error('x'), { status: 401 }));
    expect((await call()).status).toBe(401);
    requireAction.mockRejectedValue(Object.assign(new Error('x'), { status: 403 }));
    expect((await call()).status).toBe(403);
    expect(findMailCandidate).not.toHaveBeenCalled();
  });

  it("looks the candidate up in the session's active company only, and answers 404 for any other", async () => {
    requireAction.mockResolvedValue(SESSION);
    findMailCandidate.mockResolvedValue(null);
    const res = await call('c-of-another-company');
    expect(res.status).toBe(404);
    expect(findMailCandidate).toHaveBeenCalledWith({ marker: 'prisma' }, 'ws-a', 'c-of-another-company');
  });

  it("serves the attachment from that company's mailbox, never sniffed, never cached", async () => {
    requireAction.mockResolvedValue(SESSION);
    findMailCandidate.mockResolvedValue({ messageId: 'm1', partIndex: 0, fileName: 'Rechnung.pdf' });
    fetchAttachment.mockResolvedValue({ bytes: new TextEncoder().encode('%PDF-1.4'), mimeType: 'application/pdf', fileName: 'Rechnung.pdf' });
    const res = await call();
    expect(res.status).toBe(200);
    expect(mailboxFor).toHaveBeenCalledWith({ marker: 'prisma' }, 'ws-a');
    expect(fetchAttachment).toHaveBeenCalledWith('m1', 0, 'Rechnung.pdf');
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
    expect(res.headers.get('Content-Disposition')).toContain("filename*=UTF-8''Rechnung.pdf");
    expect(await res.text()).toBe('%PDF-1.4');
    expect(res.headers.get('Content-Security-Policy')).toBeNull();
  });

  it('an attachment that is no PDF or picture is sandboxed, so nothing in it runs', async () => {
    requireAction.mockResolvedValue(SESSION);
    findMailCandidate.mockResolvedValue({ messageId: 'm1', partIndex: 0, fileName: 'rechnung.xml' });
    fetchAttachment.mockResolvedValue({ bytes: new TextEncoder().encode('<Invoice/>'), mimeType: 'application/xml', fileName: 'rechnung.xml' });
    const res = await call();
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(res.headers.get('Content-Security-Policy')).toBe(SANDBOX_POLICY);
  });

  it.each([
    ['not_found', 404],
    ['auth_failed', 502],
    ['too_large', 413],
    ['not_configured', 503],
  ] as const)('maps a mailbox %s to %s', async (code, status) => {
    requireAction.mockResolvedValue(SESSION);
    findMailCandidate.mockResolvedValue({ messageId: 'm1', partIndex: 0, fileName: 'R.pdf' });
    fetchAttachment.mockRejectedValue(new MailboxError(code));
    const res = await call();
    expect(res.status).toBe(status);
    expect(await res.json()).toEqual({ error: code });
  });

  it('answers a database failure with a stable code', async () => {
    requireAction.mockResolvedValue(SESSION);
    findMailCandidate.mockRejectedValue(new Error('database gone'));
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await call();
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: 'unavailable' });
    spy.mockRestore();
  });
});
