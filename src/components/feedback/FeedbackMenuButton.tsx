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
        document.querySelector<FeedbackWidgetElement>('feedback-widget')?.open();
      }}
    >
      <FeedbackIcon />
      <span className="app-nav-label">Feedback</span>
    </button>
  );
}
