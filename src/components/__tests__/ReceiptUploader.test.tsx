// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { PipelineDeps, SavedReceipt } from '@/lib/upload/pipeline';

/**
 * The batch uploader with the network replaced. What is pinned here: every file
 * keeps the company it was dropped for, through "upload anyway", and a copy of
 * the file in another company is a warning the user resolves.
 */

const steps = { checkDuplicate: vi.fn(), uploaded: [] as File[] };
vi.mock('@/lib/upload/browser-deps', () => ({
  createBrowserDeps: (
    save: (f: unknown, o: unknown, opts: { sha256: string; workspaceId: string }) => Promise<SavedReceipt>,
    workspaceId: string,
  ): PipelineDeps => ({
    prepare: async (f) => f,
    hash: async () => 'a'.repeat(64),
    checkDuplicate: (sha256) => steps.checkDuplicate(sha256, workspaceId),
    upload: async (f: File) => {
      steps.uploaded.push(f);
      return { id: 'file-1', originalName: f.name, fileType: f.type };
    },
    recognize: async () => ({ fullText: 'Rechnung 12,50', blocks: [], confidence: 0.9 }),
    save: (file, ocr, options) => save(file, ocr, { ...options, workspaceId }),
  }),
}));

import ReceiptUploader from '../ReceiptUploader';

const SAVED: SavedReceipt = { rowId: 'row-1', possibleDuplicateOf: null, category: 'Software & Lizenzen', isMeal: false, attention: null };
const onProcessFile = vi.fn();
const onAllComplete = vi.fn();
const onDiscardRow = vi.fn();

function pdf(name = 'rechnung.pdf') {
  return new File([new Uint8Array([1, 2, 3])], name, { type: 'application/pdf' });
}

function mount(workspaceId: string, complete = onAllComplete) {
  return render(<ReceiptUploader workspaceId={workspaceId} onProcessFile={onProcessFile} onAllComplete={complete} onDiscardRow={onDiscardRow} />);
}

function drop(container: HTMLElement, file = pdf()) {
  fireEvent.change(container.querySelector('input[type="file"]')!, { target: { files: [file] } });
}

beforeEach(() => {
  for (const fn of [steps.checkDuplicate, onProcessFile, onAllComplete, onDiscardRow]) fn.mockReset();
  steps.uploaded = [];
  steps.checkDuplicate.mockResolvedValue({ existing: null, elsewhere: [] });
  onProcessFile.mockResolvedValue(SAVED);
});
afterEach(cleanup);

describe('the company a file goes into', () => {
  it('forward: checked and saved in the company the page names', async () => {
    const { container } = mount('ws-zwei');
    drop(container);
    await waitFor(() => expect(onProcessFile).toHaveBeenCalledTimes(1));
    expect(steps.checkDuplicate).toHaveBeenCalledWith('a'.repeat(64), 'ws-zwei');
    expect(onProcessFile.mock.calls[0][1]).toEqual({ sha256: 'a'.repeat(64), workspaceId: 'ws-zwei' });
  });

  it('backtrack: "upload anyway" after the duplicate stop goes to the company the file was dropped for, even after the page changed company', async () => {
    steps.checkDuplicate.mockResolvedValueOnce({ existing: { rowId: 'row-0', name: 'Hosting Oktober' }, elsewhere: [] });
    const user = userEvent.setup();
    const { container, rerender } = mount('ws-eins');
    drop(container);
    expect(await screen.findByText(/already attached to “Hosting Oktober”/)).toBeTruthy();
    rerender(<ReceiptUploader workspaceId="ws-zwei" onProcessFile={onProcessFile} onAllComplete={onAllComplete} onDiscardRow={onDiscardRow} />);
    await user.click(screen.getByRole('button', { name: 'Upload anyway' }));
    await waitFor(() => expect(onProcessFile).toHaveBeenCalledTimes(1));
    expect(onProcessFile.mock.calls[0][1]).toMatchObject({ workspaceId: 'ws-eins' });
  });

  it('the same file in another company: saved, warned with that name, nothing moves on by itself, and it can be discarded', async () => {
    steps.checkDuplicate.mockResolvedValue({ existing: null, elsewhere: ['Firma Zwei'] });
    onDiscardRow.mockResolvedValue(undefined);
    const user = userEvent.setup();
    // Its own callback: a hand-off timer left by an earlier test must not count here.
    const complete = vi.fn();
    const { container } = mount('ws-eins', complete);
    drop(container);
    expect(await screen.findByText(/exactly this file is already in your company Firma Zwei/)).toBeTruthy();
    await new Promise((r) => setTimeout(r, 1300));
    expect(complete).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Discard the new one' }));
    await waitFor(() => expect(onDiscardRow).toHaveBeenCalledWith('row-1'));
    expect(await screen.findByText(/the new receipt was removed again/)).toBeTruthy();
  });

  it('"keep both" leaves the receipt in this company too', async () => {
    steps.checkDuplicate.mockResolvedValue({ existing: null, elsewhere: ['Firma Zwei'] });
    const user = userEvent.setup();
    const { container } = mount('ws-eins');
    drop(container);
    await screen.findByText(/already in your company Firma Zwei/);
    await user.click(screen.getByRole('button', { name: 'Keep both' }));
    expect(await screen.findByText(/this receipt stays in this company too/)).toBeTruthy();
    expect(onDiscardRow).not.toHaveBeenCalled();
  });
});

describe('which files are taken', () => {
  it('an e-invoice as XML is uploaded, typed as XML even when the browser gave no type; other files are left out', async () => {
    const { container } = mount('ws-eins');
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    expect(input.accept).toContain('.xml');
    const xml = new File(['<Invoice/>'], 'xrechnung.xml', { type: '' });
    const text = new File(['x'], 'notiz.txt', { type: 'text/plain' });
    fireEvent.change(input, { target: { files: [xml, text] } });
    await waitFor(() => expect(onProcessFile).toHaveBeenCalledTimes(1));
    expect(steps.uploaded.map((f) => [f.name, f.type])).toEqual([['xrechnung.xml', 'application/xml']]);
  });
});
