import { beforeEach, describe, expect, it, vi } from 'vitest';

const requireReceiptsSession = vi.fn();
const loadOfflineReceipts = vi.fn();

vi.mock('@/lib/auth-guards', async () => {
  class ReceiptsAuthError extends Error {
    constructor(readonly status: 401 | 403 | 404) {
      super(String(status));
    }
  }
  return { ReceiptsAuthError, requireReceiptsSession: () => requireReceiptsSession() };
});
vi.mock('@/lib/auth-workspace', () => ({
  sessionWorkspaceId: (s: { activeWorkspace: { id: string } }) => s.activeWorkspace.id,
  sessionCompanyName: () => 'Firma A',
}));
vi.mock('@/lib/offline/snapshot', () => ({ loadOfflineReceipts: (...args: unknown[]) => loadOfflineReceipts(...args) }));
vi.mock('@/lib/prisma', () => ({ prisma: {} }));

import { ReceiptsAuthError } from '@/lib/auth-guards';
import { GET } from './route';

beforeEach(() => {
  requireReceiptsSession.mockReset();
  loadOfflineReceipts.mockReset();
});

describe('GET /api/receipts/offline', () => {
  it('401 without a session, and nothing is read', async () => {
    requireReceiptsSession.mockRejectedValue(new (ReceiptsAuthError as unknown as new (s: number) => Error)(401));
    const response = await GET();
    expect(response.status).toBe(401);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(loadOfflineReceipts).not.toHaveBeenCalled();
  });

  it('503, not 401, when the session cannot be checked: the device keeps its list', async () => {
    requireReceiptsSession.mockRejectedValue(new Error('auth service down'));
    const response = await GET();
    expect(response.status).toBe(503);
    expect(loadOfflineReceipts).not.toHaveBeenCalled();
  });

  it('the receipts of the company the session has open, never stored by a cache', async () => {
    requireReceiptsSession.mockResolvedValue({ activeWorkspace: { id: 'ws-a' } });
    loadOfflineReceipts.mockResolvedValue([{ id: 'r1' }]);
    const response = await GET();
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ workspaceId: 'ws-a', company: 'Firma A', receipts: [{ id: 'r1' }] });
    expect(loadOfflineReceipts.mock.calls[0][1]).toBe('ws-a');
  });

  it('500 with a plain reason when the read fails, and the log carries no content', async () => {
    requireReceiptsSession.mockResolvedValue({ activeWorkspace: { id: 'ws-a' } });
    loadOfflineReceipts.mockRejectedValue(new Error('Coop AG 12,50'));
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const response = await GET();
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'read_failed' });
    expect(JSON.stringify(log.mock.calls)).not.toContain('Coop');
    log.mockRestore();
  });
});
