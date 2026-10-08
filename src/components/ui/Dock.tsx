'use client';

import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';

const DOCK_ID = 'ui-dock';

function dockHost(): HTMLElement | null {
  if (typeof document === 'undefined') return null;
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
 * Only ever rendered in response to something the user did, so it has no
 * server-rendered counterpart to match.
 */
export default function Dock({ children }: { children: ReactNode }) {
  const host = dockHost();
  return host ? createPortal(children, host) : null;
}
