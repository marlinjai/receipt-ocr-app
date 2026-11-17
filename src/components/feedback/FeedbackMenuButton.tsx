'use client';

import { useEffect, useState } from 'react';
import { FeedbackIcon } from '@/app/app/dashboard/dashboard-icons';
import { useOnFeedbackOrigin } from './FeedbackWidget';

/** The part of `<feedback-widget>` this app calls. */
interface FeedbackWidgetElement extends HTMLElement {
  open(): void;
}

/**
 * Opens Lumitra Feedback (`FeedbackWidget`, whose own floating button is off).
 * Shown only once the widget's script has defined the element, so a blocked or
 * failed script, or another origin, leaves no dead entry in the menu.
 */
export default function FeedbackMenuButton({ onOpen }: { onOpen?: () => void }) {
  const onOrigin = useOnFeedbackOrigin();
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!onOrigin) return;
    let live = true;
    void customElements.whenDefined('feedback-widget').then(() => {
      if (live) setReady(true);
    });
    return () => {
      live = false;
    };
  }, [onOrigin]);

  if (!ready) return null;
  return (
    <button
      type="button"
      className="app-nav-link app-nav-button"
      title="Feedback senden"
      onClick={() => {
        onOpen?.();
        // Two frames later the sheet that held this entry is gone and has given the focus back to "Mehr", so the
        // widget remembers "Mehr" as the place to return the focus to when its form closes, not this vanished entry.
        requestAnimationFrame(() =>
          requestAnimationFrame(() => document.querySelector<FeedbackWidgetElement>('feedback-widget')?.open())
        );
      }}
    >
      <FeedbackIcon />
      <span className="app-nav-label">Feedback</span>
    </button>
  );
}
