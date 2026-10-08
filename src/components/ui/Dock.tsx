'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

const DOCK_ID = 'ui-dock';

function dockHost(): HTMLElement {
  let host = document.getElementById(DOCK_ID);
  if (!host) {
    host = document.createElement('div');
    host.id = DOCK_ID;
    host.className = 'ui-dock';
    document.body.appendChild(host);
  }
  return host;
}

/**
 * Renders its children into the dock: one fixed stack at the bottom edge of
 * the window that holds the batch bar and the outcome notices. Whatever
 * appears there floats above the page, so it can never push content around,
 * and several pieces from different parts of the page stack instead of
 * covering each other.
 *
 * The host element is looked up (or created once) after mount, never during
 * render. Children therefore mount one frame later, already inside the dock,
 * so an effect of theirs can rely on their elements being in the document.
 */
export default function Dock({ children }: { children: ReactNode }) {
  const [host, setHost] = useState<HTMLElement | null>(null);
  useEffect(() => {
    // The dock element is an external system this component synchronizes with.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setHost(dockHost());
  }, []);
  return host ? createPortal(children, host) : null;
}
