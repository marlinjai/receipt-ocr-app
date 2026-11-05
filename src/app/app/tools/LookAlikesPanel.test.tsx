// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import LookAlikesPanel from './LookAlikesPanel';

const result = (extra: Record<string, unknown>) => ({
  pairs: 0,
  numbersFound: 0,
  mergedByNumber: 0,
  keptApartByNumber: 0,
  judged: 0,
  mergedByModel: 0,
  keptApartByModel: 0,
  unsure: 0,
  failed: 0,
  remaining: 0,
  unavailable: false,
  ...extra,
});
const reply = (status: number, body: unknown) => ({ ok: status < 400, status, json: async () => body }) as Response;

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function start() {
  const user = userEvent.setup();
  render(<LookAlikesPanel />);
  await user.click(screen.getByRole('button', { name: 'Duplikate klären' }));
}

describe('LookAlikesPanel', () => {
  it('runs batch after batch until none is left, and sums what was settled', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(reply(200, { result: result({ pairs: 9, numbersFound: 3, mergedByNumber: 2, keptApartByNumber: 1, judged: 3, mergedByModel: 1, keptApartByModel: 1, unsure: 1, remaining: 4 }) }))
      .mockResolvedValueOnce(reply(200, { result: result({ pairs: 4, judged: 3, mergedByModel: 2, keptApartByModel: 1, remaining: 0 }) }));
    vi.stubGlobal('fetch', fetchMock);
    await start();
    expect(await screen.findByText(/Alle Paare sind angesehen/)).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledWith('/api/receipts/look-alikes', { method: 'POST' });
    expect(screen.getByText(/Nummern nachgelesen: 3, zusammengeführt: 5, als zwei Käufe behalten: 3, nicht geklärt: 1, noch offen: 0/)).toBeTruthy();
  });

  it('stops when a run makes no progress, and says the next run tries again', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(reply(200, { result: result({ remaining: 2, failed: 2 }) })).mockResolvedValueOnce(reply(200, { result: result({ remaining: 2, failed: 2 }) })));
    await start();
    expect((await screen.findByRole('alert')).textContent).toContain('versucht es erneut');
  });

  it('says when no language model can be reached, and stops', async () => {
    const fetchMock = vi.fn().mockResolvedValue(reply(200, { result: result({ numbersFound: 1, remaining: 3, unavailable: true }) }));
    vi.stubGlobal('fetch', fetchMock);
    await start();
    expect((await screen.findByRole('alert')).textContent).toContain('Kein Sprachmodell');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('says when the session ended or the right is missing', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply(401, { error: 'unauthorized' })));
    await start();
    expect((await screen.findByRole('alert')).textContent).toContain('Anmeldung');
  });
});
