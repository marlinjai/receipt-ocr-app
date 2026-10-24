'use client';

import { useSyncExternalStore } from 'react';

/**
 * Below this width the app shows its phone layout. It is Tailwind's `sm`
 * breakpoint, so a component that switches in JavaScript and a class that
 * switches with `sm:` change at the same width.
 */
export const PHONE_QUERY = '(max-width: 639px)';

function subscribe(onChange: () => void): () => void {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return () => {};
  const query = window.matchMedia(PHONE_QUERY);
  query.addEventListener('change', onChange);
  return () => query.removeEventListener('change', onChange);
}

function snapshot(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia(PHONE_QUERY).matches;
}

/**
 * True while the window is phone-narrow, false while it is wider, and it
 * follows the window as it turns or is resized. Null on the server and during
 * hydration, when the width is not known yet: a component that draws one
 * layout or the other draws neither until then, so a phone never mounts the
 * wide layout only to swap it out one render later.
 */
export function usePhone(): boolean | null {
  return useSyncExternalStore<boolean | null>(subscribe, snapshot, () => null);
}
