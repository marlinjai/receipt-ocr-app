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
 * True while the window is phone-narrow, and it follows the window as it turns
 * or is resized. The server renders the wide layout (it cannot know the width);
 * the phone layout takes over on the first render in the browser.
 */
export function usePhone(): boolean {
  return useSyncExternalStore(subscribe, snapshot, () => false);
}
