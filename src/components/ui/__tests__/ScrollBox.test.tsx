// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import ScrollBox from '../ScrollBox';

/**
 * jsdom lays nothing out and has no ResizeObserver: the box's widths, its scrolling and the observer are
 * played by hand here, the way a browser reports them.
 */

let contentWidth = 952;
let boxWidth = 305;
let observers: Array<() => void> = [];
const hadScrollTo = Object.prototype.hasOwnProperty.call(HTMLElement.prototype, 'scrollTo');
const originalScrollTo = HTMLElement.prototype.scrollTo;

beforeEach(() => {
  contentWidth = 952;
  boxWidth = 305;
  observers = [];
  vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockImplementation(() => contentWidth);
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(() => boxWidth);
  HTMLElement.prototype.scrollTo = function (this: HTMLElement, options?: ScrollToOptions | number) {
    const left = typeof options === 'object' ? (options.left ?? 0) : 0;
    this.scrollLeft = Math.max(0, Math.min(left, contentWidth - boxWidth));
    this.dispatchEvent(new Event('scroll'));
  } as typeof HTMLElement.prototype.scrollTo;
  vi.stubGlobal(
    'ResizeObserver',
    class {
      private readonly callback: () => void;
      constructor(callback: () => void) {
        this.callback = callback;
      }
      observe() {
        observers.push(this.callback);
      }
      disconnect() {
        observers = observers.filter((o) => o !== this.callback);
      }
    },
  );
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  if (hadScrollTo) HTMLElement.prototype.scrollTo = originalScrollTo;
  else delete (HTMLElement.prototype as { scrollTo?: unknown }).scrollTo;
});

/** The box changes width (a phone turned) and the browser tells the observers. */
function resize(width: number) {
  boxWidth = width;
  act(() => observers.forEach((o) => o()));
}

/** The person scrolls the box to a place. */
function scrollTo(box: HTMLElement, left: number) {
  act(() => {
    box.scrollLeft = left;
    box.dispatchEvent(new Event('scroll'));
  });
}

describe('ScrollBox', () => {
  it('is a named region and a tab stop while its content is wider than it is', () => {
    render(<ScrollBox label="EUR by month">x</ScrollBox>);
    const box = screen.getByRole('region', { name: 'EUR by month' });
    expect(box.tabIndex).toBe(0);
  });

  it('is a plain box outside the tab order while everything fits, and becomes a region when it stops fitting', () => {
    boxWidth = 1200;
    const { container } = render(<ScrollBox label="EUR by month">x</ScrollBox>);
    const box = container.firstElementChild as HTMLElement;
    expect(screen.queryByRole('region')).toBeNull();
    expect(box.hasAttribute('tabindex')).toBe(false);
    resize(300);
    expect(screen.getByRole('region', { name: 'EUR by month' }).tabIndex).toBe(0);
  });

  it('opens on its end when asked to, and leaves the start alone otherwise', () => {
    render(
      <>
        <ScrollBox label="pinned" pinEnd>
          x
        </ScrollBox>
        <ScrollBox label="plain">y</ScrollBox>
      </>,
    );
    expect(screen.getByRole('region', { name: 'pinned' }).scrollLeft).toBe(952 - 305);
    expect(screen.getByRole('region', { name: 'plain' }).scrollLeft).toBe(0);
  });

  it('stays at its end when it changes width while it was there', () => {
    render(
      <ScrollBox label="EUR by month" pinEnd>
        x
      </ScrollBox>,
    );
    const box = screen.getByRole('region', { name: 'EUR by month' });
    resize(600);
    expect(box.scrollLeft).toBe(952 - 600);
    resize(300);
    expect(box.scrollLeft).toBe(952 - 300);
  });

  it('stays where the person scrolled it when it changes width', () => {
    render(
      <ScrollBox label="EUR by month" pinEnd>
        x
      </ScrollBox>,
    );
    const box = screen.getByRole('region', { name: 'EUR by month' });
    scrollTo(box, 0);
    resize(600);
    expect(box.scrollLeft).toBe(0);
  });

  it('opens on its end again when its content changes', () => {
    const view = render(
      <ScrollBox label="EUR by month" pinEnd resetKey={30}>
        x
      </ScrollBox>,
    );
    const box = screen.getByRole('region', { name: 'EUR by month' });
    scrollTo(box, 0);
    contentWidth = 1200;
    view.rerender(
      <ScrollBox label="EUR by month" pinEnd resetKey={40}>
        x
      </ScrollBox>,
    );
    expect(box.scrollLeft).toBe(1200 - 305);
  });

  it('stops listening when it goes', () => {
    const view = render(<ScrollBox label="EUR by month">x</ScrollBox>);
    expect(observers).toHaveLength(1);
    view.unmount();
    expect(observers).toHaveLength(0);
  });
});
