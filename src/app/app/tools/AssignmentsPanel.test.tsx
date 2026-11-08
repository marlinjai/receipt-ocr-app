// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import AssignmentsPanel from './AssignmentsPanel';

const result = (extra: Record<string, unknown>) => ({ candidates: 0, decided: 0, set: 0, suggested: 0, cleared: 0, failed: 0, remaining: 0, answersRecorded: 0, superseded: 0, unavailable: false, ...extra });
const reply = (status: number, body: unknown) => ({ ok: status < 400, status, json: async () => body }) as Response;

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function start() {
  const user = userEvent.setup();
  render(<AssignmentsPanel />);
  await user.click(screen.getByRole('button', { name: 'Zuordnungen entscheiden' }));
}

describe('AssignmentsPanel', () => {
  it('runs batch after batch until none is left, and sums what was set and suggested', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(reply(200, { result: result({ candidates: 30, decided: 20, set: 15, suggested: 5, remaining: 10 }) }))
      .mockResolvedValueOnce(reply(200, { result: result({ candidates: 10, decided: 10, set: 6, suggested: 3, failed: 1, remaining: 0 }) }));
    vi.stubGlobal('fetch', fetchMock);
    await start();
    expect(await screen.findByText(/Alle offenen Belege sind angesehen/)).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledWith('/api/receipts/assignments', { method: 'POST' });
    expect(screen.getByText(/Automatisch zugeordnet: 21, mit Vorschlag offen: 8, nicht beantwortet: 1, noch offen: 0/)).toBeTruthy();
  });

  it('stops when a run makes no progress, and says the next run tries again', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply(200, { result: result({ remaining: 2, failed: 2 }) })));
    await start();
    expect((await screen.findByRole('alert')).textContent).toContain('versucht es erneut');
  });

  it('goes on after a run that decided receipts but left the count where it was (cleared or failed ones)', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(reply(200, { result: result({ decided: 3, suggested: 3, remaining: 4 }) }))
      .mockResolvedValueOnce(reply(200, { result: result({ decided: 2, set: 1, failed: 1, remaining: 4 }) }))
      .mockResolvedValueOnce(reply(200, { result: result({ decided: 4, set: 4, remaining: 0 }) }));
    vi.stubGlobal('fetch', fetchMock);
    await start();
    expect(await screen.findByText(/Alle offenen Belege sind angesehen/)).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('says when no language model can be reached, and that nothing was set', async () => {
    const fetchMock = vi.fn().mockResolvedValue(reply(200, { result: result({ remaining: 3, unavailable: true }) }));
    vi.stubGlobal('fetch', fetchMock);
    await start();
    expect((await screen.findByRole('alert')).textContent).toContain('nichts zugeordnet');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('a refused or failed request says what to do', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply(403, { error: 'forbidden' })));
    await start();
    expect((await screen.findByRole('alert')).textContent).toContain('Berechtigung');
  });
});
