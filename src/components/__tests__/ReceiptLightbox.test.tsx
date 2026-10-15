// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

/**
 * The fullscreen preview: its close button is a proper 40 pixel target that
 * sits above the viewer (never on top of the viewer's own tools), takes the
 * focus on open, and Escape or the button closes the preview.
 */

vi.mock('@/lib/meals/pdf-render', () => ({ renderPdfPage: vi.fn() }));

import ReceiptLightbox from '../ReceiptLightbox';

const file = { refId: 'ref-1', fileId: 'f-1', fileUrl: '/api/files/f-1', mimeType: 'image/jpeg', originalName: 'beleg.jpg', rotation: null };

afterEach(cleanup);

describe('ReceiptLightbox', () => {
  it('the close button is a 40 pixel target with an icon, a name and a tooltip, and has the focus', () => {
    render(<ReceiptLightbox file={file} onClose={() => {}} />);
    const close = screen.getByRole('button', { name: 'Close preview' });
    expect(close.className).toContain('h-10');
    expect(close.className).toContain('w-10');
    expect(close.getAttribute('title')).toBe('Close preview (Esc)');
    expect(close.querySelector('svg')!.getAttribute('width')).toBe('20');
    expect(document.activeElement).toBe(close);
  });

  it('the close button is not inside the viewer, so it cannot cover the viewer tools', () => {
    render(<ReceiptLightbox file={file} onClose={() => {}} />);
    const close = screen.getByRole('button', { name: 'Close preview' });
    expect(close.closest('.ui-viewer')).toBeNull();
    expect(close.style.position).toBe('');
  });

  it('closes with the button and with Escape', () => {
    const onClose = vi.fn();
    render(<ReceiptLightbox file={file} onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: 'Close preview' }));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
