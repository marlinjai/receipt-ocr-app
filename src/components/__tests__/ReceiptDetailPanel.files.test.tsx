// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';

/**
 * The file list of the receipt side panel: each row's buttons are 40 pixel
 * targets with a 20 pixel icon, a name and a tooltip, the selected file is
 * marked, and the buttons still do what they did. The meal section and the
 * server actions are replaced; the panel and the viewer are the real code.
 */

vi.mock('@/lib/meals/pdf-render', () => ({ renderPdfPage: vi.fn(() => new Promise(() => {})) }));
vi.mock('@/app/app/meals/actions', () => ({ saveReceiptRotation: vi.fn() }));
vi.mock('../meals/MealPanelSection', () => ({ default: () => null }));

import ReceiptDetailPanel from '../ReceiptDetailPanel';

const IMAGE_COL = 'col-image';
const files = [
  { id: 'ref-1', fileId: 'f-1', fileUrl: '/api/files/f-1', originalName: 'kassenbon.pdf', mimeType: 'application/pdf', sizeBytes: 1024 },
  { id: 'ref-2', fileId: 'f-2', fileUrl: '/api/files/f-2', originalName: 'foto.jpg', mimeType: 'image/jpeg', sizeBytes: 2048 },
];

function renderPanel(onDeleteFile = vi.fn().mockResolvedValue(undefined)) {
  const row = { id: 'row-1', tableId: 't-1', cells: { [IMAGE_COL]: files }, createdAt: new Date(), updatedAt: new Date() };
  const columns = [{ id: IMAGE_COL, tableId: 't-1', name: 'Receipt Image', type: 'file', position: 0, width: 100, isPrimary: false, config: {}, createdAt: new Date() }];
  render(
    <ReceiptDetailPanel
      row={row as never}
      columns={columns as never}
      selectOptions={new Map()}
      onClose={() => {}}
      onDeleteFile={onDeleteFile}
    />,
  );
  return onDeleteFile;
}

afterEach(cleanup);

describe('ReceiptDetailPanel: file row buttons', () => {
  it('preview and remove are 40 pixel targets with a hidden 20 pixel icon, a name and a tooltip', () => {
    renderPanel();
    for (const [name, title] of [
      ['Preview foto.jpg', 'Full-size preview'],
      ['Remove foto.jpg', 'Remove file'],
    ]) {
      const button = screen.getByRole('button', { name });
      expect(button.className).toContain('h-10');
      expect(button.className).toContain('w-10');
      expect(button.className).toContain('focus-visible:outline-2');
      expect(button.getAttribute('type')).toBe('button');
      expect(button.getAttribute('title')).toBe(title);
      const icon = button.querySelector('svg')!;
      expect(icon.getAttribute('width')).toBe('20');
      expect(icon.getAttribute('aria-hidden')).toBe('true');
    }
  });

  it('remove is red only on hover, preview light: each sets its own hover colour', () => {
    renderPanel();
    expect(screen.getByRole('button', { name: 'Remove foto.jpg' }).className).toContain('hover:text-red-400');
    expect(screen.getByRole('button', { name: 'Remove foto.jpg' }).className).not.toContain('hover:text-gray-100');
    expect(screen.getByRole('button', { name: 'Preview foto.jpg' }).className).toContain('hover:text-gray-100');
  });

  it('remove still removes that file', () => {
    const onDeleteFile = renderPanel();
    fireEvent.click(screen.getByRole('button', { name: 'Remove foto.jpg' }));
    expect(onDeleteFile).toHaveBeenCalledWith('row-1', IMAGE_COL, 'f-2');
  });

  it('the file name button is a 40 pixel target that marks the file shown', () => {
    renderPanel();
    const list = screen.getByRole('list');
    const first = within(list).getByRole('button', { name: /^kassenbon\.pdf/ });
    const second = within(list).getByRole('button', { name: /^foto\.jpg/ });
    expect(first.className).toContain('min-h-10');
    expect(first.getAttribute('type')).toBe('button');
    expect(first.getAttribute('aria-current')).toBe('true');
    expect(second.getAttribute('aria-current')).toBeNull();
    fireEvent.click(second);
    expect(second.getAttribute('aria-current')).toBe('true');
    expect(first.getAttribute('aria-current')).toBeNull();
  });

  it('the Expand button is named by its visible text and opens the full-size preview', () => {
    renderPanel();
    const expand = screen.getByRole('button', { name: 'Expand' });
    expect(expand.getAttribute('title')).toBe('Open full-size preview');
    expect(expand.className).toContain('min-h-10');
    fireEvent.click(expand);
    expect(screen.getByRole('dialog', { name: 'Receipt preview' })).toBeTruthy();
  });
});
