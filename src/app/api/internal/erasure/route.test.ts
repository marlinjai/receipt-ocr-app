import { createHmac, randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The erasure receiver: a signed `tenant.erased` ends the company's contacts,
 * its bank connections and (plan 2026-10-22, payments across companies) its
 * account shares with what tied the two companies' records, and counts each.
 * Database and services are stand-ins; the secret is made at run time.
 */

const eraseCompanyContacts = vi.fn();
const endCompanyBankConnections = vi.fn();
const endCompanyAccountShares = vi.fn();

vi.mock('next/server', () => ({ NextResponse: { json: (body: unknown, init?: ResponseInit) => Response.json(body, init) } }));
vi.mock('@/lib/prisma', () => ({ prisma: { marker: 'prisma' } }));
vi.mock('@/lib/tax/payments/bank/server', () => ({ serverBankDeps: () => null }));
vi.mock('@/lib/tax/payments/bank/service', () => ({ endCompanyBankConnections: (...a: unknown[]) => endCompanyBankConnections(...a) }));
vi.mock('@/lib/tax/payments/routing', () => ({ endCompanyAccountShares: (...a: unknown[]) => endCompanyAccountShares(...a) }));
vi.mock('@/lib/erasure', async (original) => ({ ...(await original<typeof import('@/lib/erasure')>()), eraseCompanyContacts: (...a: unknown[]) => eraseCompanyContacts(...a) }));

import { ERASURE_SIGNATURE_HEADER } from '@/lib/erasure-signature';
import { POST } from './route';

const secret = randomBytes(16).toString('hex');

beforeEach(() => {
  vi.stubEnv('RECEIPTS_ERASURE_WEBHOOK_SECRET', secret);
  eraseCompanyContacts.mockResolvedValue({ guestCopies: 0, guestCopiesHeld: 0, sharedContacts: 0, exportCoverage: 'no_export' });
  endCompanyBankConnections.mockResolvedValue(0);
  endCompanyAccountShares.mockResolvedValue({ shares: 1, links: 2, records: 3 });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

function signed(body: string) {
  const signature = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
  return new Request('http://localhost/api/internal/erasure', { method: 'POST', body, headers: { [ERASURE_SIGNATURE_HEADER]: signature } });
}

describe('POST /api/internal/erasure', () => {
  it('ends the company\'s account shares with the records that tied the two companies, and counts them', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const body = JSON.stringify({ kind: 'tenant.erased', tenant_id: 'tenant-x', workspace_ids: ['ws-x'], event_id: 'e1' });
    const res = await POST(signed(body) as never);
    expect(res.status).toBe(200);
    expect(endCompanyAccountShares).toHaveBeenCalledWith({ marker: 'prisma' }, 'tenant-x', ['ws-x']);
    expect((await res.json()).erased).toMatchObject({ accountShares: 1, crossCompanyLinks: 2, crossCompanyRecords: 3 });
    expect(log.mock.calls.flat().join(' ')).toContain('1 account shares (2 links and 3 other records between companies removed)');
    log.mockRestore();
  });

  it('a failing share erasure answers 502 so the delivery is retried', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    endCompanyAccountShares.mockRejectedValue(new Error('database gone'));
    const res = await POST(signed(JSON.stringify({ kind: 'tenant.erased', tenant_id: 'tenant-x', workspace_ids: [] })) as never);
    expect(res.status).toBe(502);
    log.mockRestore();
  });
});
