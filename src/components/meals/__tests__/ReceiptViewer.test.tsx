// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

/**
 * The receipt viewer: rotation (state, keyboard, storing it), zoom and fit,
 * and the PDF path. The PDF renderer is replaced; the state logic it drives
 * is the real one (also covered on its own in `viewer-state.test.ts`).
 */

const renderPdfPage = vi.fn();
vi.mock('@/lib/meals/pdf-render', () => ({ renderPdfPage: (...a: unknown[]) => renderPdfPage(...a) }));

import ReceiptViewer, { type ViewerFile } from '../ReceiptViewer';

function image(overrides: Partial<ViewerFile> = {}): ViewerFile {
  return { refId: 'ref-1', fileId: 'f-1', fileUrl: '/api/files/f-1', mimeType: 'image/jpeg', originalName: 'beleg.jpg', rotation: null, ...overrides };
}
const pdf = (overrides: Partial<ViewerFile> = {}) => image({ mimeType: 'application/pdf', originalName: 'scan.pdf', ...overrides });

/** jsdom loads no pictures: report a size the way a browser would after loading. */
function loadImage(width: number, height: number) {
  // Hidden until its size is known, so it is looked up in the document, not by role.
  const img = document.querySelector('img.ui-viewer-page') as HTMLImageElement;
  Object.defineProperty(img, 'naturalWidth', { value: width, configurable: true });
  Object.defineProperty(img, 'naturalHeight', { value: height, configurable: true });
  fireEvent.load(img);
  return img;
}

const angleOf = (img: HTMLElement) => Number(/rotate\((-?\d+)deg\)/.exec(img.style.transform)?.[1]);
const panel = () => screen.getByRole('group', { name: 'Belegansicht' });
const status = () => screen.getAllByRole('status').map((s) => s.textContent).join(' ');

beforeEach(() => {
  renderPdfPage.mockReset();
  vi.useFakeTimers({ shouldAdvanceTime: true });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('ReceiptViewer: rotation', () => {
  it('opens with the stored rotation, whatever the shape of the page', () => {
    render(<ReceiptViewer files={[image({ rotation: 180 })]} />);
    const img = loadImage(900, 300);
    expect(angleOf(img)).toBe(180);
    expect(status()).toContain('Gedreht um 180 Grad');
  });

  it('a stored "upright" is respected: a wide page is not turned again', () => {
    render(<ReceiptViewer files={[image({ rotation: 0 })]} />);
    expect(angleOf(loadImage(900, 300))).toBe(0);
  });

  it('without a stored rotation a wide page opens turned upright, and that guess is not stored', () => {
    const onRotate = vi.fn().mockResolvedValue(true);
    render(<ReceiptViewer files={[image()]} onRotate={onRotate} />);
    expect(angleOf(loadImage(900, 300))).toBe(90);
    act(() => vi.advanceTimersByTime(2000));
    expect(onRotate).not.toHaveBeenCalled();
  });

  it('a tall page without a stored rotation stays as it is', () => {
    render(<ReceiptViewer files={[image()]} />);
    expect(angleOf(loadImage(300, 900))).toBe(0);
  });

  it('the buttons turn by a quarter each way and are named for screen readers', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<ReceiptViewer files={[image({ rotation: 0 })]} />);
    const img = loadImage(300, 900);
    await user.click(screen.getByRole('button', { name: 'Nach rechts drehen' }));
    expect(angleOf(img)).toBe(90);
    await user.click(screen.getByRole('button', { name: 'Nach links drehen' }));
    await user.click(screen.getByRole('button', { name: 'Nach links drehen' }));
    // Drawn as -90 (it turns on from where it was); the rotation itself is 270.
    expect(angleOf(img)).toBe(-90);
    expect(status()).toContain('Gedreht um 270 Grad');
  });

  it('stores the rotation once for several quick turns: the last one', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const onRotate = vi.fn().mockResolvedValue(true);
    const file = image({ rotation: 0 });
    render(<ReceiptViewer files={[file]} onRotate={onRotate} />);
    loadImage(300, 900);
    const right = screen.getByRole('button', { name: 'Nach rechts drehen' });
    await user.click(right);
    await user.click(right);
    await user.click(right);
    expect(onRotate).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(400));
    expect(onRotate).toHaveBeenCalledTimes(1);
    expect(onRotate).toHaveBeenCalledWith(file, 270);
  });

  it('says so when the rotation could not be stored, and keeps the view turned', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const onRotate = vi.fn().mockResolvedValue(false);
    render(<ReceiptViewer files={[image({ rotation: 0 })]} onRotate={onRotate} />);
    const img = loadImage(300, 900);
    await user.click(screen.getByRole('button', { name: 'Nach rechts drehen' }));
    act(() => vi.advanceTimersByTime(400));
    expect((await screen.findByRole('alert')).textContent).toContain('Die Drehung konnte nicht gespeichert werden');
    expect(angleOf(img)).toBe(90);
  });

  it('a rejected save is reported the same way', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<ReceiptViewer files={[image({ rotation: 0 })]} onRotate={vi.fn().mockRejectedValue(new Error('offline'))} />);
    loadImage(300, 900);
    await user.click(screen.getByRole('button', { name: 'Nach rechts drehen' }));
    act(() => vi.advanceTimersByTime(400));
    expect(await screen.findByRole('alert')).toBeTruthy();
  });
});

describe('ReceiptViewer: keyboard', () => {
  it('r rotates, Shift+r rotates back, plus and minus zoom, 0 fits, while the viewer has the focus', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<ReceiptViewer files={[image({ rotation: 0 })]} />);
    const img = loadImage(300, 900);
    panel().focus();
    await user.keyboard('r');
    expect(angleOf(img)).toBe(90);
    await user.keyboard('{Shift>}R{/Shift}');
    expect(angleOf(img)).toBe(0);
    await user.keyboard('+');
    await user.keyboard('+');
    expect(status()).toContain('Zoom 156 Prozent');
    await user.keyboard('-');
    expect(status()).toContain('Zoom 125 Prozent');
    await user.keyboard('0');
    expect(status()).toContain('Zoom 100 Prozent');
  });

  it('the keys do nothing while the focus is elsewhere, so typing an "r" in the form never turns the receipt', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(
      <>
        <input aria-label="Anlass" />
        <ReceiptViewer files={[image({ rotation: 0 })]} />
      </>,
    );
    const img = loadImage(300, 900);
    await user.type(screen.getByLabelText('Anlass'), 'r+0-');
    expect(angleOf(img)).toBe(0);
    expect(status()).toContain('Zoom 100 Prozent');
    // Nor from a button inside the viewer: a key there belongs to the button.
    screen.getByRole('button', { name: 'Vergrößern' }).focus();
    await user.keyboard('r');
    expect(angleOf(img)).toBe(0);
  });

  it('the panel can be reached with Tab and describes its keys', () => {
    render(<ReceiptViewer files={[image()]} />);
    expect(panel().tabIndex).toBe(0);
    const described = document.getElementById(panel().getAttribute('aria-describedby')!);
    expect(described?.textContent).toContain('R dreht');
  });
});

describe('ReceiptViewer: zoom and fit', () => {
  it('cannot zoom out below the whole page; "Einpassen" is offered only when there is something to reset', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<ReceiptViewer files={[image({ rotation: 0 })]} />);
    loadImage(300, 900);
    expect(screen.getByRole('button', { name: 'Verkleinern' })).toHaveProperty('disabled', true);
    expect(screen.getByRole('button', { name: 'Einpassen' })).toHaveProperty('disabled', true);
    await user.click(screen.getByRole('button', { name: 'Vergrößern' }));
    expect(screen.getByRole('button', { name: 'Einpassen' })).toHaveProperty('disabled', false);
    await user.click(screen.getByRole('button', { name: 'Einpassen' }));
    expect(status()).toContain('Zoom 100 Prozent');
  });

  it('rotating a zoomed receipt shows it whole again', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<ReceiptViewer files={[image({ rotation: 0 })]} />);
    loadImage(300, 900);
    await user.click(screen.getByRole('button', { name: 'Vergrößern' }));
    await user.click(screen.getByRole('button', { name: 'Nach rechts drehen' }));
    expect(status()).toContain('Gedreht um 90 Grad, Zoom 100 Prozent');
  });
});

describe('ReceiptViewer: files', () => {
  it('a PDF receipt is drawn to a picture and then behaves like a photo', async () => {
    renderPdfPage.mockResolvedValue({ url: 'blob:page-1', width: 842, height: 298, pageCount: 1 });
    render(<ReceiptViewer files={[pdf()]} />);
    expect(screen.getByText('Beleg wird geladen…')).toBeTruthy();
    const img = (await screen.findByRole('img')) as HTMLImageElement;
    expect(renderPdfPage).toHaveBeenCalledWith('/api/files/f-1', 1, expect.anything());
    expect(img.getAttribute('src')).toBe('blob:page-1');
    // A sideways scan: opened turned upright.
    expect(angleOf(img)).toBe(90);
    expect(document.querySelector('iframe')).toBeNull();
  });

  it('a PDF with several pages can be paged through', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderPdfPage.mockImplementation(async (_url: string, page: number) => ({ url: `blob:page-${page}`, width: 300, height: 900, pageCount: 3 }));
    render(<ReceiptViewer files={[pdf({ rotation: 0 })]} />);
    await screen.findByText('Seite 1 von 3');
    expect(screen.getByRole('button', { name: 'Vorherige Seite' })).toHaveProperty('disabled', true);
    await user.click(screen.getByRole('button', { name: 'Nächste Seite' }));
    await screen.findByText('Seite 2 von 3');
    expect((screen.getByRole('img') as HTMLImageElement).getAttribute('src')).toBe('blob:page-2');
  });

  it('a receipt that cannot be loaded says so and offers to open the file itself', async () => {
    renderPdfPage.mockRejectedValue(new Error('broken'));
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    render(<ReceiptViewer files={[pdf()]} />);
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('„scan.pdf“ konnte nicht geladen werden');
    expect(within(alert).getByRole('link', { name: 'In neuem Tab öffnen' }).getAttribute('href')).toBe('/api/files/f-1');
    quiet.mockRestore();
  });

  it('a broken image file says so too', () => {
    render(<ReceiptViewer files={[image()]} />);
    fireEvent.error(document.querySelector('img.ui-viewer-page')!);
    expect(screen.getByRole('alert').textContent).toContain('konnte nicht geladen werden');
  });

  it('no file: says so, no toolbar', () => {
    render(<ReceiptViewer files={[]} />);
    expect(screen.getByText('Zu diesem Beleg ist keine Datei hinterlegt.')).toBeTruthy();
    expect(screen.queryByRole('toolbar')).toBeNull();
  });

  it('with several files each one keeps its own rotation', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<ReceiptViewer files={[image({ rotation: 90 }), image({ refId: 'ref-2', fileId: 'f-2', fileUrl: '/api/files/f-2', rotation: 270 })]} />);
    expect(angleOf(loadImage(300, 900))).toBe(90);
    await user.click(screen.getByRole('button', { name: 'Datei 2' }));
    await waitFor(() => expect(document.querySelector('img.ui-viewer-page')!.getAttribute('src')).toBe('/api/files/f-2'));
    expect(angleOf(loadImage(300, 900))).toBe(270);
  });
});
