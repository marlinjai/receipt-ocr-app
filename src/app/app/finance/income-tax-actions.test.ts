import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The income tax server actions without a database: the session, the
 * services and the statement are stand-ins, so what is tested is the action's
 * own contract (year check, error codes, the fresh statement as answer).
 */

const services = vi.hoisted(() => ({
  saveWageEntry: vi.fn(),
  deleteWageEntry: vi.fn(),
  saveReturnItem: vi.fn(),
  deleteReturnItem: vi.fn(),
  saveChurchMonths: vi.fn(),
  saveFederalState: vi.fn(),
  loadStatement: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({ auth: { requireAction: vi.fn(async () => ({ memberships: [] })) } }));
vi.mock('@/lib/auth-workspace', async (original) => ({
  ...(await original<typeof import('@/lib/auth-workspace')>()),
  sessionWorkspaceId: () => 'ws-1',
  requireSessionTenantId: () => 'tenant-1',
}));
vi.mock('@/lib/prisma', () => ({ prisma: {} }));
vi.mock('@/lib/tax/service', () => ({ loadStatement: services.loadStatement }));
vi.mock('@/lib/tax/income-tax/service', async (original) => ({
  ...(await original<typeof import('@/lib/tax/income-tax/service')>()),
  saveWageEntry: services.saveWageEntry,
  deleteWageEntry: services.deleteWageEntry,
  saveReturnItem: services.saveReturnItem,
  deleteReturnItem: services.deleteReturnItem,
  saveChurchMonths: services.saveChurchMonths,
  saveFederalState: services.saveFederalState,
}));

import { IncomeTaxServiceError } from '@/lib/tax/income-tax/service';
import { removeWage, saveTaxReturnItem, saveWage } from './income-tax-actions';

beforeEach(() => {
  for (const fn of Object.values(services)) fn.mockReset();
  services.loadStatement.mockResolvedValue({ year: 2026 });
});

describe('income tax actions', () => {
  it('saves a pay slip of the year on screen and answers with the fresh statement', async () => {
    const result = await saveWage(2026, null, { year: 2026, employer: 'Arbeitgeber', month: 1 });
    expect(result).toEqual({ ok: true, value: { year: 2026 } });
    expect(services.saveWageEntry).toHaveBeenCalledWith({}, { workspaceId: 'ws-1', tenantId: 'tenant-1' }, null, expect.objectContaining({ year: 2026 }));
    expect(services.loadStatement).toHaveBeenCalledWith({}, 'ws-1', 2026);
  });

  it('refuses a save for another year than the one on screen, before any write', async () => {
    expect(await saveWage(2026, null, { year: 2025, employer: 'Arbeitgeber', month: 1 })).toEqual({ ok: false, error: 'invalid_input', detail: 'invalid_year' });
    expect(await saveTaxReturnItem(2026, null, { year: 2025, key: 'special.donations', amountCents: 100 })).toEqual({
      ok: false,
      error: 'invalid_input',
      detail: 'invalid_year',
    });
    expect(services.saveWageEntry).not.toHaveBeenCalled();
    expect(services.saveReturnItem).not.toHaveBeenCalled();
  });

  it('reports a missing entry and a taken month with their codes', async () => {
    services.deleteWageEntry.mockRejectedValue(new IncomeTaxServiceError('wage_not_found'));
    expect(await removeWage(2026, 'w-1')).toEqual({ ok: false, error: 'not_found', detail: 'wage_not_found' });
    services.saveWageEntry.mockRejectedValue(new IncomeTaxServiceError('wage_entry_taken'));
    expect(await saveWage(2026, null, { year: 2026 })).toEqual({ ok: false, error: 'invalid_input', detail: 'wage_entry_taken' });
  });
});
