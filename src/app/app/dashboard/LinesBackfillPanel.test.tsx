// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import LinesBackfillPanel from './LinesBackfillPanel';

const result = (extra: Record<string, unknown>) => ({ read: 0, addUp: 0, differ: 0, noLines: 0, noText: [], failed: 0, unavailable: false, remaining: 0, inputTokens: 0, outputTokens: 0, ...extra });
const reply = (status: number, body: unknown) => ({ ok: status < 400, status, json: async () => body }) as Response;

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function start() {
  const user = userEvent.setup();
  render(<LinesBackfillPanel />);
  await user.click(screen.getByRole('button', { name: 'Positionen lesen' }));
  const buttons = screen.getAllByRole('button', { name: 'Positionen lesen' });
  await user.click(buttons[buttons.length - 1]);
}

describe('LinesBackfillPanel', () => {
  it('runs batch after batch until none is left, and lists the receipts without text', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(reply(200, { result: result({ read: 15, addUp: 14, differ: 1, remaining: 5 }) }))
      .mockResolvedValueOnce(reply(200, { result: result({ read: 4, addUp: 4, noText: [{ rowId: 'r9', name: 'Scan ohne Text' }], remaining: 0 }) }));
    vi.stubGlobal('fetch', fetchMock);
    await start();
    expect(await screen.findByText(/Alle Belege sind gelesen/)).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenCalledWith('/api/receipts/lines', { method: 'POST' });
    expect(screen.getByText(/Gelesen: 19 \(18 stimmen mit dem Gesamtbetrag, 1 mit Differenz\)/)).toBeTruthy();
    expect(screen.getByText('Scan ohne Text')).toBeTruthy();
  });

  it('stops when a batch makes no progress, and says the next run tries again', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(reply(200, { result: result({ read: 1, remaining: 3 }) })).mockResolvedValueOnce(reply(200, { result: result({ failed: 3, remaining: 3 }) })));
    await start();
    expect((await screen.findByRole('alert')).textContent).toContain('versucht es erneut');
  });

  it('stops when more receipts of a batch failed than were read', async () => {
    const fetchMock = vi.fn().mockResolvedValue(reply(200, { result: result({ read: 1, failed: 4, remaining: 30 }) }));
    vi.stubGlobal('fetch', fetchMock);
    await start();
    expect((await screen.findByRole('alert')).textContent).toContain('versucht es erneut');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('says when no language model is configured', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply(503, { error: 'model_unavailable', result: result({ unavailable: true, remaining: 4 }) })));
    await start();
    expect((await screen.findByRole('alert')).textContent).toContain('kein Sprachmodell');
  });
});
