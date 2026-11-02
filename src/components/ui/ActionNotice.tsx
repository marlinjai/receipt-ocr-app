'use client';

import { useEffect, useRef } from 'react';
import type { MealBatchNotice } from '@/lib/meals/batch';
import Dock from './Dock';

/** A notice with a running number, so the same wording twice is still a new notice. */
export interface ActionNoticeState extends MealBatchNotice {
  seq: number;
}

/** How long a notice that reports no failure stays before it leaves on its own. */
const NOTICE_LIFETIME_MS = 8000;

/**
 * The outcome of the last list action, shown in the dock at the bottom edge
 * so it does not move the page.
 *
 * It takes the focus when nothing else holds it: the button that started the
 * action is usually gone by then (its entry left the list, or the batch bar
 * closed), and without this the focus would fall back to the top of the page.
 * An answer can come while the person is on another row or typing in a form, and
 * then the focus stays there: the notice is announced either way. A failure is
 * announced as an alert and stays until it is closed. Anything else leaves on its
 * own, but never while the focus is still on it.
 */
export default function ActionNotice(props: { notice: ActionNoticeState; onDismiss: () => void }) {
  return (
    <Dock>
      <NoticeCard {...props} />
    </Dock>
  );
}

/** Is the person working somewhere? The body and a heading kept as a place for the focus are nobody's work. */
function focusInUse(): boolean {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement) || active === document.body) return false;
  return active.tabIndex !== -1 || active.matches('input, textarea, select, button, a, [contenteditable]');
}

/** Mounts only once it is inside the dock, so its focus effect finds its element in the document. */
function NoticeCard({ notice, onDismiss }: { notice: ActionNoticeState; onDismiss: () => void }) {
  const cardRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLParagraphElement>(null);
  const expired = useRef(false);

  useEffect(() => {
    if (!focusInUse()) textRef.current?.focus();
  }, []);

  useEffect(() => {
    if (notice.tone === 'danger') return;
    const timer = setTimeout(() => {
      if (cardRef.current?.contains(document.activeElement)) expired.current = true;
      else onDismiss();
    }, NOTICE_LIFETIME_MS);
    return () => clearTimeout(timer);
  }, [notice.tone, onDismiss]);

  return (
    <div
      ref={cardRef}
      className="ui-dock-card ui-dock-notice flex items-start gap-2 py-2.5 pl-4 pr-2"
      data-tone={notice.tone}
      onBlur={(e) => {
        if (expired.current && !cardRef.current?.contains(e.relatedTarget as Node | null)) onDismiss();
      }}
    >
      <p
        ref={textRef}
        tabIndex={-1}
        role={notice.tone === 'danger' ? 'alert' : 'status'}
        className="min-w-0 flex-1 py-1 text-sm leading-relaxed outline-none"
      >
        {notice.text}
      </p>
      <button type="button" className="ui-btn ui-btn-sm ui-btn-ghost ui-btn-icon shrink-0" aria-label="Hinweis schließen" onClick={onDismiss}>
        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">
          <path d="M4 4l8 8M12 4l-8 8" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      </button>
    </div>
  );
}
