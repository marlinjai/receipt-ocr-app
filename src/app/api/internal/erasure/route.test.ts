import { createHmac, randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CompanyErasureDeps } from '@/lib/company-erasure';

/**
 * The erasure receiver: a signed `tenant.erased` runs the whole company
 * erasure with the real file store delete, the bank connections and (plan
 * 2026-10-22, payments across companies) the account shares, records the run
 * and answers what was not erased. Database and services are stand-ins; the
 * secret is made at run time.
 */

const eraseCompany = vi.fn();
const endCompanyBankConnections = vi.fn();
const endCompanyAccountShares = vi.fn();
const deleteStoredFile = vi.fn();
const ledger = { begin: vi.fn(), complete: vi.fn(), fail: vi.fn() };

vi.mock('next/server', () => ({ NextResponse: { json: (body: unknown, init?: ResponseInit) => Response.json(body, init) } }));
vi.mock('@/lib/prisma', () => ({ prisma: { marker: 'prisma' } }));
vi.mock('@/lib/tax/payments/bank/server', () => ({ serverBankDeps: () => null }));
vi.mock('@/lib/tax/payments/bank/service', () => ({ endCompanyBankConnections: (...a: unknown[]) => endCompanyBankConnections(...a) }));
vi.mock('@/lib/tax/payments/routing', () => ({ endCompanyAccountShares: (...a: unknown[]) => endCompanyAccountShares(...a) }));
vi.mock('@/lib/stored-files', () => ({ deleteStoredFile: (...a: unknown[]) => deleteStoredFile(...a) }));
vi.mock('@/lib/erasure-ledger', () => ({ erasureLedger: () => ledger }));
vi.mock('@/lib/company-erasure', () => ({ eraseCompany: (...a: unknown[]) => eraseCompany(...a) }));

import { ERASURE_SIGNATURE_HEADER } from '@/lib/erasure-signature';
import { POST } from './route';

const secret = randomBytes(16).toString('hex');

beforeEach(() => {
  vi.stubEnv('RECEIPTS_ERASURE_WEBHOOK_SECRET', secret);
  endCompanyBankConnections.mockResolvedValue(0);
  endCompanyAccountShares.mockResolvedValue({ shares: 1, links: 2, records: 3 });
  ledger.begin.mockImplementation(async (e: { workspaceIds: string[] }) => ({ workspaceIds: e.workspaceIds }));
  ledger.complete.mockResolvedValue(undefined);
  ledger.fail.mockResolvedValue(undefined);
  // The stand-in runs the steps the route hands in, so the test sees what the route wired.
  eraseCompany.mockImplementation(async (_db: unknown, tenantId: string, workspaceIds: string[], deps: CompanyErasureDeps) => {
    const bankConnections = await deps.endBankConnections(tenantId, workspaceIds);
    const shares = await deps.endAccountShares(tenantId, workspaceIds);
    await deps.deleteStoredFile('file-1');
    return {
      guestCopies: 0,
      guestCopiesHeld: 0,
      sharedContacts: 0,
      exportCoverage: 'no_export',
      bankConnections,
      accountShares: shares.shares,
      crossCompanyLinks: shares.links,
      crossCompanyRecords: shares.records,
      register: { tables: 1, receipts: 6, storedFiles: 1, storedFilesKept: 0, records: { receipt_reviews: 6 }, companyExports: 0 },
      notErased: [{ what: 'database_backups', days: 30 }],
    };
  });
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
  it('runs the whole company erasure with the file store, the bank connections and the account shares, and counts them', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const body = JSON.stringify({ kind: 'tenant.erased', tenant_id: 'tenant-x', workspace_ids: ['ws-x'], event_id: 'e1' });
    const res = await POST(signed(body) as never);
    expect(res.status).toBe(200);
    expect(eraseCompany).toHaveBeenCalledWith({ marker: 'prisma' }, 'tenant-x', ['ws-x'], expect.any(Object));
    expect(endCompanyBankConnections).toHaveBeenCalledWith({ marker: 'prisma' }, null, 'tenant-x', ['ws-x']);
    expect(endCompanyAccountShares).toHaveBeenCalledWith({ marker: 'prisma' }, 'tenant-x', ['ws-x']);
    expect(deleteStoredFile).toHaveBeenCalledWith('file-1');
    const answer = await res.json();
    expect(answer.erased).toMatchObject({ accountShares: 1, crossCompanyLinks: 2, crossCompanyRecords: 3, register: { receipts: 6, storedFiles: 1 } });
    expect(answer.notErased).toEqual([{ what: 'database_backups', days: 30 }]);
    expect(ledger.begin).toHaveBeenCalledWith({ eventId: 'e1', kind: 'tenant.erased', companyId: 'tenant-x', workspaceIds: ['ws-x'] });
    expect(ledger.complete).toHaveBeenCalledWith('e1', expect.objectContaining({ accountShares: 1 }));
    const line = log.mock.calls.flat().join(' ');
    expect(line).toContain('1 account shares (2 links and 3 other records between companies removed)');
    expect(line).toContain('removed 1 receipts tables with 6 rows, 1 stored files');
    log.mockRestore();
  });

  it('a failing share erasure answers 502 so the delivery is retried, and the failed run is recorded', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    endCompanyAccountShares.mockRejectedValue(new Error('database gone'));
    const res = await POST(signed(JSON.stringify({ kind: 'tenant.erased', tenant_id: 'tenant-x', workspace_ids: [], event_id: 'e2' })) as never);
    expect(res.status).toBe(502);
    expect(ledger.fail).toHaveBeenCalledWith('e2', 'failed', undefined);
    expect(ledger.complete).not.toHaveBeenCalled();
    log.mockRestore();
  });

  it('a file store that refuses answers 502 with the reason, so auth-brain sends the delivery again', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    deleteStoredFile.mockRejectedValue(Object.assign(new Error('refused'), { name: 'StoredFileEraseError' }));
    const res = await POST(signed(JSON.stringify({ kind: 'tenant.erased', tenant_id: 'tenant-x', workspace_ids: ['ws-x'], event_id: 'e3' })) as never);
    expect(res.status).toBe(502);
    expect((await res.json()).reason).toBe('stored_file_not_removed');
    log.mockRestore();
  });
});
