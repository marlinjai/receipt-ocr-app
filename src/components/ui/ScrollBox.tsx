'use client';

import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';

/**
 * A box whose content may be wider than the screen (a chart of many months, a table of figures): it scrolls
 * sideways itself, so the page never does. While it actually scrolls it is a named region and a tab stop, so
 * a keyboard can move it; while everything fits it is a plain box and adds nothing to the tab order.
 *
 * `pinEnd` opens it on its end (the newest months of a chart) before the first paint, and keeps it there when
 * the box changes width (a phone turned) as long as it was at its end; a person who scrolled back stays where
 * they are. `resetKey` opens it on its end again when the content changes (another number of months).
 *
 * Plan: docs/plans/2026-10-24-phone-layout.md.
 */
export default function ScrollBox({
  label,
  className,
  pinEnd = false,
  resetKey,
  children,
}: {
  /** What the box holds, said when it is a region. */
  label: string;
  className?: string;
  pinEnd?: boolean;
  resetKey?: string | number;
  children: ReactNode;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [scrolls, setScrolls] = useState(false);
  // Whether the box sits at its end: read when it changes width, kept current by the person's scrolling.
  const atEnd = useRef(true);

  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    // Every current browser scrolls an element with scrollTo; an environment without it (jsdom) stays at the start.
    const toEnd = () => (typeof el.scrollTo === 'function' ? el.scrollTo({ left: el.scrollWidth }) : undefined);
    const measure = () => {
      const overflows = el.scrollWidth > el.clientWidth;
      setScrolls(overflows);
      return overflows;
    };
    if (measure() && pinEnd) toEnd();
    atEnd.current = true;
    const onScroll = () => {
      atEnd.current = el.scrollWidth - el.clientWidth - el.scrollLeft <= 1;
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    const observer =
      typeof ResizeObserver === 'undefined'
        ? null
        : new ResizeObserver(() => {
            if (measure() && pinEnd && atEnd.current) toEnd();
          });
    observer?.observe(el);
    return () => {
      el.removeEventListener('scroll', onScroll);
      observer?.disconnect();
    };
  }, [pinEnd, resetKey]);

  return (
    <div ref={box} className={className} role={scrolls ? 'region' : undefined} aria-label={scrolls ? label : undefined} tabIndex={scrolls ? 0 : undefined}>
      {children}
    </div>
  );
}
