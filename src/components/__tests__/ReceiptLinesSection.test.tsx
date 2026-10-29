// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReceiptLinesView } from '@/lib/line-items/service';
import type { StoredLine } from '@/lib/line-items/store';

const getReceiptLines = vi.fn();
const setReceiptLineKind = vi.fn();
vi.mock('@/app/app/line-items-actions', () => ({
  getReceiptLines: (...a: unknown[]) => getReceiptLines(...a),
  setReceiptLineKind: (...a: unknown[]) => setReceiptLineKind(...a),
}));

import ReceiptLinesSection from '../ReceiptLinesSection';

afterEach(() => {
  cleanup();
  getReceiptLines.mockReset();
  setReceiptLineKind.mockReset();
});

const line = (id: string, text: string, grossCents: number, kind: StoredLine['kind'], extra: Partial<StoredLine> = {}): StoredLine => ({
  id, rowId: 'r1', position: 0, text, quantity: 1, unitPriceCents: grossCents, grossCents, netCents: null, taxRate: 19, readKind: kind, kind, answered: false, ...extra,
});
const view = (extra: Partial<ReceiptLinesView> = {}): ReceiptLinesView => ({
  lines: [line('l1', 'Cappuccino', 780, 'drink_out', { quantity: 2, unitPriceCents: 390 }), line('l2', 'Croque', 950, 'meal_out')],
  reading: { outcome: 'lines', source: 'reading', textCut: false, retried: false },
  check: { sumCents: 1730, totalCents: 1730, differenceCents: 0, addsUp: true, basis: 'gross', tipCents: 0 },
  currency: 'EUR',
  ...extra,
});

describe('ReceiptLinesSection', () => {
  it('lists every line with what it cost and its kind (resume: what is stored is shown)', async () => {
    getReceiptLines.mockResolvedValue({ ok: true, value: view() });
    render(<ReceiptLinesSection rowId="r1" version="v1" />);
    expect(await screen.findByText('Cappuccino')).toBeTruthy();
    expect(screen.getByText('7,80 €')).toBeTruthy();
    expect(screen.getByText('2 × 3,90 €')).toBeTruthy();
    expect((screen.getByLabelText('Art von Croque') as HTMLSelectElement).value).toBe('meal_out');
    expect(screen.queryByText(/Positionen ergeben/)).toBeNull();
  });

  it('shows a line printed before tax with its gross, and names the printed net beneath it', async () => {
    const plan = line('l1', 'Plus plan', 2618, 'software_services', { netCents: 2200, unitPriceCents: 2200 });
    getReceiptLines.mockResolvedValue({ ok: true, value: view({ lines: [plan, line('l2', 'Croque', 950, 'meal_out')], check: { sumCents: 2200, totalCents: 2200, differenceCents: 0, addsUp: true, basis: 'net', tipCents: 0 } }) });
    render(<ReceiptLinesSection rowId="r1" version="v1" />);
    expect(await screen.findByText('26,18 €')).toBeTruthy();
    expect(screen.getByText('netto 22,00 €')).toBeTruthy();
    // A line without a net names none.
    expect(screen.getAllByText(/^netto /)).toHaveLength(1);
  });

  it('says by how much the lines miss the total', async () => {
    getReceiptLines.mockResolvedValue({ ok: true, value: view({ check: { sumCents: 4120, totalCents: 4210, differenceCents: -90, addsUp: false, basis: 'gross', tipCents: 0 } }) });
    render(<ReceiptLinesSection rowId="r1" version="v1" />);
    expect((await screen.findByText(/Positionen ergeben 41,20 €, Beleg 42,10 €/)).textContent).toContain('nicht aufgeschlüsselt');
  });

  it('changes a kind and shows that it is remembered for the shop', async () => {
    getReceiptLines.mockResolvedValue({ ok: true, value: view() });
    setReceiptLineKind.mockResolvedValue({ ok: true, value: view({ lines: [line('l1', 'Cappuccino', 780, 'coffee_tea', { readKind: 'drink_out', answered: true }), line('l2', 'Croque', 950, 'meal_out')] }) });
    const user = userEvent.setup();
    render(<ReceiptLinesSection rowId="r1" version="v1" />);
    await user.selectOptions(await screen.findByLabelText('Art von Cappuccino'), 'coffee_tea');
    expect(setReceiptLineKind).toHaveBeenCalledWith('r1', 'l1', 'coffee_tea');
    expect(await screen.findByText(/gilt für diesen Text bei diesem Händler/)).toBeTruthy();
  });

  it('shows a failed change at its line, and the lines stay', async () => {
    getReceiptLines.mockResolvedValue({ ok: true, value: view() });
    setReceiptLineKind.mockResolvedValue({ ok: false, error: 'forbidden' });
    const user = userEvent.setup();
    render(<ReceiptLinesSection rowId="r1" version="v1" />);
    await user.selectOptions(await screen.findByLabelText('Art von Croque'), 'groceries');
    expect((await screen.findByRole('alert')).textContent).toContain('Berechtigung');
    expect(screen.getByText('Cappuccino')).toBeTruthy();
  });

  it('says when the lines were not read yet, have no text, or failed, and offers a retry when loading fails', async () => {
    getReceiptLines.mockResolvedValueOnce({ ok: true, value: view({ lines: [], reading: null, check: null }) });
    const { unmount } = render(<ReceiptLinesSection rowId="r1" version="v1" />);
    expect(await screen.findByText(/noch nicht gelesen/)).toBeTruthy();
    unmount();
    getReceiptLines.mockResolvedValueOnce({ ok: true, value: view({ lines: [], reading: { outcome: 'no_text', source: 'backfill', textCut: false, retried: false }, check: null }) });
    render(<ReceiptLinesSection rowId="r2" version="v1" />);
    expect(await screen.findByText(/kein erkannter Text gespeichert/)).toBeTruthy();
    cleanup();
    getReceiptLines.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({ ok: true, value: view() });
    const user = userEvent.setup();
    render(<ReceiptLinesSection rowId="r3" version="v1" />);
    await user.click(await screen.findByRole('button', { name: 'Erneut laden' }));
    await waitFor(() => expect(screen.getByText('Croque')).toBeTruthy());
  });

  it('after the attempt limit points to reading the page again, instead of promising another run', async () => {
    getReceiptLines.mockResolvedValueOnce({ ok: true, value: view({ lines: [], reading: { outcome: 'failed', source: 'backfill', textCut: false, retried: false }, check: null }) });
    render(<ReceiptLinesSection rowId="r1" version="v1" />);
    expect((await screen.findByText(/nach mehreren Versuchen/)).textContent).toContain('Seite neu lesen');
  });

  it('loads afresh when the receipt was read again (backtrack)', async () => {
    getReceiptLines.mockResolvedValueOnce({ ok: true, value: view() }).mockResolvedValueOnce({ ok: true, value: view({ lines: [line('l3', 'Quiche', 1730, 'meal_out')] }) });
    const { rerender } = render(<ReceiptLinesSection rowId="r1" version="v1" />);
    expect(await screen.findByText('Croque')).toBeTruthy();
    rerender(<ReceiptLinesSection rowId="r1" version="v2" />);
    expect(await screen.findByText('Quiche')).toBeTruthy();
    expect(screen.queryByText('Croque')).toBeNull();
  });
});
