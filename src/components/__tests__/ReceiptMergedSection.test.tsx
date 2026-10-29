// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { MergedReceiptView } from '@/app/app/duplicate-actions';

const getMergedReceipts = vi.fn();
const restoreMerged = vi.fn();
vi.mock('@/app/app/duplicate-actions', () => ({
  getMergedReceipts: (...a: unknown[]) => getMergedReceipts(...a),
  restoreMerged: (...a: unknown[]) => restoreMerged(...a),
}));

import ReceiptMergedSection from '../ReceiptMergedSection';

afterEach(() => {
  cleanup();
  getMergedReceipts.mockReset();
  restoreMerged.mockReset();
});

const COPY: MergedReceiptView = { rowId: 'r2', name: 'Hosting März (PDF)', reason: 'same_invoice', invoiceNumber: 'RE-2026-0042', mergedAt: '2026-10-29T10:00:00.000Z' };

describe('ReceiptMergedSection', () => {
  it('shows nothing while nothing was merged into the receipt', async () => {
    getMergedReceipts.mockResolvedValue({ ok: true, value: [] });
    const { container } = render(<ReceiptMergedSection rowId="r1" version="v1" />);
    await waitFor(() => expect(getMergedReceipts).toHaveBeenCalledWith('r1'));
    expect(container.textContent).toBe('');
  });

  it('lists what was merged and why, and a restore brings it back and reloads the table', async () => {
    getMergedReceipts.mockResolvedValue({ ok: true, value: [COPY, { ...COPY, rowId: 'r3', name: 'Foto', reason: 'same_file', invoiceNumber: null }] });
    restoreMerged.mockResolvedValue({ ok: true, value: [{ ...COPY, rowId: 'r3', name: 'Foto', reason: 'same_file', invoiceNumber: null }] });
    const onRestored = vi.fn();
    render(<ReceiptMergedSection rowId="r1" version="v1" onRestored={onRestored} />);
    expect(await screen.findByText(/„Hosting März \(PDF\)“: gleiche Rechnungsnummer RE-2026-0042, am 29\.10\.2026/)).toBeTruthy();
    expect(screen.getByText(/„Foto“: dieselbe Datei/)).toBeTruthy();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Hosting März (PDF) wiederherstellen' }));
    expect(restoreMerged).toHaveBeenCalledWith('r1', 'r2');
    expect(await screen.findByText('„Hosting März (PDF)“ ist wieder ein eigener Beleg.')).toBeTruthy();
    expect(screen.queryByText(/gleiche Rechnungsnummer RE-2026-0042/)).toBeNull();
    expect(onRestored).toHaveBeenCalledTimes(1);
  });

  it('a failed restore says why and leaves the list as it is', async () => {
    getMergedReceipts.mockResolvedValue({ ok: true, value: [COPY] });
    restoreMerged.mockResolvedValue({ ok: false, error: 'not_found' });
    const onRestored = vi.fn();
    render(<ReceiptMergedSection rowId="r1" version="v1" onRestored={onRestored} />);
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Hosting März (PDF) wiederherstellen' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/nicht mehr zusammengeführt/);
    expect(screen.getByText(/gleiche Rechnungsnummer RE-2026-0042/)).toBeTruthy();
    expect(onRestored).not.toHaveBeenCalled();
  });

  it('a list that could not be loaded says so', async () => {
    getMergedReceipts.mockResolvedValue({ ok: false, error: 'forbidden' });
    render(<ReceiptMergedSection rowId="r1" version="v1" />);
    expect((await screen.findByRole('alert')).textContent).toMatch(/Berechtigung/);
  });
});
