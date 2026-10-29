// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import InvoiceNumbersPanel from './InvoiceNumbersPanel';

const result = (extra: Record<string, unknown>) => ({ looked: 0, found: 0, merged: 0, remaining: 0, ...extra });
const reply = (status: number, body: unknown) => ({ ok: status < 400, status, json: async () => body }) as Response;

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function start(onMerged = vi.fn()) {
  const user = userEvent.setup();
  render(<InvoiceNumbersPanel onMerged={onMerged} />);
  await user.click(screen.getByRole('button', { name: 'Rechnungsnummern lesen' }));
  const buttons = screen.getAllByRole('button', { name: 'Rechnungsnummern lesen' });
  await user.click(buttons[buttons.length - 1]);
  return onMerged;
}

describe('InvoiceNumbersPanel', () => {
  it('runs batch after batch until none is left, sums what it did, and reloads the table when receipts were merged', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(reply(200, { result: result({ looked: 400, found: 310, merged: 3, remaining: 120 }) }))
      .mockResolvedValueOnce(reply(200, { result: result({ looked: 120, found: 90, merged: 1, remaining: 0 }) }));
    vi.stubGlobal('fetch', fetchMock);
    const onMerged = await start();
    expect(await screen.findByText(/Alle Belege sind angesehen/)).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledWith('/api/receipts/invoice-numbers', { method: 'POST' });
    expect(screen.getByText(/Angesehen: 520, davon mit Nummer: 400, als doppelt archiviert: 4, noch offen: 0/)).toBeTruthy();
    expect(onMerged).toHaveBeenCalledTimes(1);
  });

  it('nothing merged: the table is not reloaded', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply(200, { result: result({ looked: 3, remaining: 0 }) })));
    const onMerged = await start();
    await screen.findByText(/Alle Belege sind angesehen/);
    expect(onMerged).not.toHaveBeenCalled();
  });

  it('stops when a run makes no progress, and says the next run tries again', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(reply(200, { result: result({ looked: 1, remaining: 3 }) })).mockResolvedValueOnce(reply(200, { result: result({ remaining: 3 }) })));
    await start();
    expect((await screen.findByRole('alert')).textContent).toContain('versucht es erneut');
  });

  it('says when the session ended or the right is missing', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply(403, { error: 'forbidden' })));
    await start();
    expect((await screen.findByRole('alert')).textContent).toContain('Berechtigung');
  });
});
