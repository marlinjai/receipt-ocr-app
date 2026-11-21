import { createHmac, randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CompanyErasureDeps } from '@/lib/company-erasure';

/**
 * The erasure receiver, its wiring only: a signed `tenant.erased` hands the
 * company erasure the real file store delete, the bank connections and (plan
 * 2026-10-22, payments across companies) the account shares, records the run
 * and answers what was not erased. `eraseCompany` is a stand-in here that calls
 * what the route handed in; what the erasure itself does, and what the route
 * answers when it fails, is tested against the real function and a real
 * database in route.dbtest.ts. The secret is made at run time.
 */

const eraseCompany = vi.fn();
const endCompanyBankConnections = vi.fn();
const endCompanyAccountShares = vi.fn();
const eraseStoredFile = vi.fn();
const ledger = { begin: vi.fn(), acquire: vi.fn(), busy: vi.fn(), release: vi.fn(), complete: vi.fn(), fail: vi.fn() };
const lease = { token: 'lease-1', renew: vi.fn() };

vi.mock('next/server', () => ({ NextResponse: { json: (body: unknown, init?: ResponseInit) => Response.json(body, init) } }));
vi.mock('@/lib/prisma', () => ({ prisma: { marker: 'prisma' } }));
vi.mock('@/lib/tax/payments/bank/server', () => ({ serverBankDeps: () => null }));
vi.mock('@/lib/tax/payments/bank/service', () => ({ endCompanyBankConnections: (...a: unknown[]) => endCompanyBankConnections(...a) }));
vi.mock('@/lib/tax/payments/routing', () => ({ endCompanyAccountShares: (...a: unknown[]) => endCompanyAccountShares(...a) }));
vi.mock('@/lib/stored-files', () => ({ eraseStoredFile: (...a: unknown[]) => eraseStoredFile(...a) }));
vi.mock('@/lib/erasure-ledger', () => ({ erasureLedger: () => ledger }));
vi.mock('@/lib/company-erasure', () => ({ eraseCompany: (...a: unknown[]) => eraseCompany(...a) }));

import { ERASURE_SIGNATURE_HEADER } from '@/lib/erasure-signature';
import { POST } from './route';

const secret = randomBytes(16).toString('hex');

beforeEach(() => {
  vi.stubEnv('RECEIPTS_ERASURE_WEBHOOK_SECRET', secret);
  endCompanyBankConnections.mockResolvedValue({ connections: 1, sessionsLeftOpen: 0 });
  endCompanyAccountShares.mockResolvedValue({ shares: 1, links: 2, records: 3 });
  eraseStoredFile.mockResolvedValue('removed');
  ledger.begin.mockImplementation(async (e: { workspaceIds: string[] }) => ({ workspaceIds: e.workspaceIds }));
  ledger.acquire.mockResolvedValue(lease);
  lease.renew.mockResolvedValue(undefined);
  ledger.complete.mockResolvedValue(undefined);
  ledger.fail.mockResolvedValue(undefined);
  // The stand-in runs the steps the route hands in, so the test sees what the route wired.
  eraseCompany.mockImplementation(async (_db: unknown, tenantId: string, workspaceIds: string[], deps: CompanyErasureDeps) => {
    await deps.checkpoint?.();
    const bank = await deps.endBankConnections(tenantId, workspaceIds);
    const shares = await deps.endAccountShares(tenantId, workspaceIds);
    await deps.deleteStoredFile('file-1');
    return {
      guestCopies: 0,
      guestCopiesHeld: 0,
      sharedContacts: 0,
      exportCoverage: 'no_export',
      bankConnections: bank.connections,
      accountShares: shares.shares,
      crossCompanyLinks: shares.links,
      crossCompanyRecords: shares.records,
      register: { tables: 1, receipts: 6, storedFiles: 1, storedFilesAlreadyGone: 0, storedFilesKept: 0, records: { receipt_reviews: 6 }, companyExports: 0 },
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

describe('POST /api/internal/erasure (the wiring)', () => {
  it('hands the company erasure the file store, the bank connections and the account shares, records the run and counts them', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const body = JSON.stringify({ kind: 'tenant.erased', tenant_id: 'tenant-x', workspace_ids: ['ws-x'], event_id: 'e1' });
    const res = await POST(signed(body) as never);
    expect(res.status).toBe(200);
    expect(eraseCompany).toHaveBeenCalledWith({ marker: 'prisma' }, 'tenant-x', ['ws-x'], expect.any(Object));
    expect(endCompanyBankConnections).toHaveBeenCalledWith({ marker: 'prisma' }, null, 'tenant-x', ['ws-x']);
    expect(endCompanyAccountShares).toHaveBeenCalledWith({ marker: 'prisma' }, 'tenant-x', ['ws-x']);
    expect(eraseStoredFile).toHaveBeenCalledWith('file-1');
    const answer = await res.json();
    expect(answer.erased).toMatchObject({ bankConnections: 1, accountShares: 1, crossCompanyLinks: 2, crossCompanyRecords: 3, register: { receipts: 6, storedFiles: 1 } });
    expect(answer.notErased).toEqual([{ what: 'database_backups', days: 30 }]);
    expect(ledger.begin).toHaveBeenCalledWith({ eventId: 'e1', kind: 'tenant.erased', companyId: 'tenant-x', workspaceIds: ['ws-x'] });
    expect(ledger.complete).toHaveBeenCalledWith('e1', expect.objectContaining({ accountShares: 1 }), lease);
    // The route hands the erasure the checkpoint that renews the lease between its steps.
    expect(lease.renew).toHaveBeenCalledTimes(1);
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
    expect(ledger.fail).toHaveBeenCalledWith('e2', 'failed', undefined, lease);
    expect(ledger.complete).not.toHaveBeenCalled();
    log.mockRestore();
  });
});
