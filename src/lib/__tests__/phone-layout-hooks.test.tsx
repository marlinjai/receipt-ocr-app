// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { useRef, useState } from 'react';
import { PHONE_QUERY, usePhone } from '@/lib/use-phone';
import { useTabInView } from '@/lib/use-tab-in-view';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** A `matchMedia` whose answer the test sets, telling its listeners like a browser does. */
function fakeMedia(initial: boolean) {
  let matches = initial;
  const listeners = new Set<() => void>();
  const matchMedia = vi.fn((query: string) => ({
    get matches() {
      return query === PHONE_QUERY ? matches : false;
    },
    media: query,
    addEventListener: (_: string, fn: () => void) => listeners.add(fn),
    removeEventListener: (_: string, fn: () => void) => listeners.delete(fn),
  }));
  vi.stubGlobal('matchMedia', matchMedia);
  return {
    set(next: boolean) {
      matches = next;
      listeners.forEach((fn) => fn());
    },
    listeners,
  };
}

function Probe() {
  return <p>{usePhone() ? 'phone' : 'wide'}</p>;
}

describe('usePhone', () => {
  it('is true below the small breakpoint and follows the window as it turns', () => {
    const media = fakeMedia(true);
    render(<Probe />);
    expect(screen.getByText('phone')).toBeTruthy();
    act(() => media.set(false));
    expect(screen.getByText('wide')).toBeTruthy();
    act(() => media.set(true));
    expect(screen.getByText('phone')).toBeTruthy();
  });

  it('stops listening when the component goes', () => {
    const media = fakeMedia(false);
    const view = render(<Probe />);
    expect(media.listeners.size).toBe(1);
    view.unmount();
    expect(media.listeners.size).toBe(0);
  });

  it('asks for the same width as the `sm:` classes switch at', () => {
    expect(PHONE_QUERY).toBe('(max-width: 639px)');
  });
});

/** A tab row 300 wide with four tabs of 120 each, laid out by hand (jsdom has no layout). */
function Tabs() {
  const row = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState('a');
  useTabInView(row, active);
  return (
    <div ref={row} data-testid="row">
      {['a', 'b', 'c', 'd'].map((key, i) => (
        <button key={key} role="tab" aria-selected={active === key} data-left={i * 120} onClick={() => setActive(key)}>
          {key}
        </button>
      ))}
    </div>
  );
}

function layOut() {
  const row = screen.getByTestId('row');
  row.getBoundingClientRect = () => ({ left: 0, right: 300 }) as DOMRect;
  // jsdom does not scroll; this one moves the row like a browser, never past its start.
  row.scrollTo = ((options: ScrollToOptions) => {
    row.scrollLeft = Math.max(0, options.left ?? 0);
  }) as typeof row.scrollTo;
  for (const tab of row.querySelectorAll<HTMLElement>('[role=tab]')) {
    tab.getBoundingClientRect = () => {
      const left = Number(tab.dataset.left) - row.scrollLeft;
      return { left, right: left + 120 } as DOMRect;
    };
  }
  return row;
}

describe('useTabInView', () => {
  it('scrolls the row sideways so a tab beyond its right edge shows, and back for one beyond its left edge', () => {
    render(<Tabs />);
    const row = layOut();
    act(() => screen.getByText('d').click());
    // d spans 360 to 480 in a row 300 wide: scrolled by 180 plus the margin that shows a bit of the next tab.
    expect(row.scrollLeft).toBe(204);
    act(() => screen.getByText('a').click());
    expect(row.scrollLeft).toBe(0);
  });

  it('leaves the row alone when the open tab is already in view', () => {
    render(<Tabs />);
    const row = layOut();
    act(() => screen.getByText('b').click());
    expect(row.scrollLeft).toBe(0);
  });
});
