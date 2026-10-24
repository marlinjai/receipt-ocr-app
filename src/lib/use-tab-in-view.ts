'use client';

import { useEffect, type RefObject } from 'react';

/**
 * Keeps the selected tab of a sideways-scrolling tab row in view. On a phone a
 * row of eight tabs is wider than the screen; opening a page on a tab near the
 * end (from a link, or after a reload) must not leave that tab scrolled out of
 * sight. Only the row scrolls, sideways: the page never moves (which
 * `scrollIntoView` would do when the row is below the fold).
 *
 * `scroller` is the element that scrolls; the selected tab is found inside it
 * by `aria-selected="true"`. `activeKey` is whatever names the selected tab.
 */
export function useTabInView(scroller: RefObject<HTMLElement | null>, activeKey: string): void {
  useEffect(() => {
    const row = scroller.current;
    if (!row) return;
    const tab = row.querySelector<HTMLElement>('[aria-selected="true"]');
    if (!tab) return;
    const bounds = row.getBoundingClientRect();
    const box = tab.getBoundingClientRect();
    // A little of the neighbouring tab stays visible, so the row reads as one that scrolls.
    const margin = 24;
    if (box.left < bounds.left) row.scrollTo({ left: Math.max(0, row.scrollLeft - (bounds.left - box.left + margin)) });
    else if (box.right > bounds.right) row.scrollTo({ left: row.scrollLeft + (box.right - bounds.right + margin) });
  }, [scroller, activeKey]);
}
