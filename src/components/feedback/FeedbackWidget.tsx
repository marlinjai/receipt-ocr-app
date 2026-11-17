'use client';

import { useSyncExternalStore } from 'react';

/**
 * Lumitra Feedback on the signed-in app (dogfood, go-live stage 4 of the
 * feedback service): sends feedback, optionally with a masked screenshot, to
 * the feedback service's "Receipts (dogfood)" project, which delivers it by
 * email to the owner.
 *
 * Mounted only in the /app shell (`src/app/app/layout.tsx`), behind the
 * session check, so only signed-in members see it; the public paths never
 * load the script.
 *
 * - The script is the service's own copy of the widget, pinned to one version
 *   by its Subresource Integrity (SRI) hash (the hashes are listed per version
 *   in the service's `packages/sdk/cdn-releases.json`). A new widget version
 *   means a new file name and hash here.
 * - The publishable key is public by design: it only lets this origin
 *   (https://receipts.lumitra.co) send feedback to that one project. On any
 *   other origin (local development, a preview) every send would be refused,
 *   so the widget is not rendered there at all.
 * - The widget's own floating button is off (`launcher="false"`): on a phone
 *   it would sit on the bottom bar's "Mehr". The sidebar and the "Mehr" sheet
 *   open it instead (`FeedbackMenuButton`).
 * - The interface is German, so is the widget (`locale="de"`), although the
 *   page's `lang` says "en"; dark with the app's gold, like the app.
 * - Feedback is anonymous by design while only the owner and Lumitra staff
 *   hold this app: the sender may leave a reply address in the form.
 * - The screenshot covers form fields by itself; the pages with third
 *   parties' data (contacts, the meal register's guests, payments) are marked
 *   `data-feedback-mask` and come out black.
 */
export const FEEDBACK_ORIGIN = 'https://receipts.lumitra.co';
export const FEEDBACK_API_BASE = 'https://api.feedback.lumitra.co';
export const FEEDBACK_WIDGET_SRC = `${FEEDBACK_API_BASE}/widget/feedback-widget.0.0.1.js`;
export const FEEDBACK_WIDGET_INTEGRITY = 'sha384-5/xhEMhMdE0ZSyKvAwQeen3uDRzV8pM5rKqNhJkAnT611nUTy7/YWwjF4Vil/k1i';
export const FEEDBACK_PUBLISHABLE_KEY = 'pk_live_BtnB7HRmCWAl4g1Ol_9WJ7xWChCFVnLY';
/** The app's gold (`--accent` in `globals.css`); the widget takes a literal color. */
export const FEEDBACK_ACCENT = '#e2a348';

const noSubscribe = () => () => {};

/** True only in the browser on the production origin; false on the server and everywhere else. */
export function useOnFeedbackOrigin(): boolean {
  return useSyncExternalStore(
    noSubscribe,
    () => window.location.origin === FEEDBACK_ORIGIN,
    () => false
  );
}

export default function FeedbackWidget() {
  if (!useOnFeedbackOrigin()) return null;
  return (
    <>
      {/*
        React 19 hoists a script that has both `async` and `src` into the head and loads it once per address,
        however often this renders; without `async` it would stay in place and not be deduplicated.
      */}
      <script async src={FEEDBACK_WIDGET_SRC} integrity={FEEDBACK_WIDGET_INTEGRITY} crossOrigin="anonymous" />
      <feedback-widget
        publishable-key={FEEDBACK_PUBLISHABLE_KEY}
        api-base={FEEDBACK_API_BASE}
        locale="de"
        theme="dark"
        accent={FEEDBACK_ACCENT}
        launcher="false"
      />
    </>
  );
}
