/**
 * Lumitra Feedback on the signed-in app (dogfood, go-live stage 4 of the
 * feedback service): a floating button that sends feedback, optionally with a
 * masked screenshot, to the feedback service's "receipts" project, which
 * delivers it by email to the owner.
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
 *   (https://receipts.lumitra.co) send feedback to that one project.
 * - The interface is German, so is the widget (`locale="de"`), although the
 *   page's `lang` says "en".
 * - The screenshot covers form fields by itself; the receipt image and the
 *   tables stay readable in it, which is intended: they are this app's data,
 *   seen by its own members, and the screenshot is off until ticked.
 */
export const FEEDBACK_API_BASE = 'https://api.feedback.lumitra.co';
export const FEEDBACK_WIDGET_SRC = `${FEEDBACK_API_BASE}/widget/feedback-widget.0.0.1.js`;
export const FEEDBACK_WIDGET_INTEGRITY = 'sha384-5/xhEMhMdE0ZSyKvAwQeen3uDRzV8pM5rKqNhJkAnT611nUTy7/YWwjF4Vil/k1i';
export const FEEDBACK_PUBLISHABLE_KEY = 'pk_live_BtnB7HRmCWAl4g1Ol_9WJ7xWChCFVnLY';

export default function FeedbackWidget() {
  return (
    <>
      {/* React 19 hoists an async script into the head and loads it once. */}
      <script async src={FEEDBACK_WIDGET_SRC} integrity={FEEDBACK_WIDGET_INTEGRITY} crossOrigin="anonymous" />
      {/* The widget adds its own shadow root and attributes once its script runs, so hydration leaves it alone. */}
      <feedback-widget
        publishable-key={FEEDBACK_PUBLISHABLE_KEY}
        api-base={FEEDBACK_API_BASE}
        locale="de"
        suppressHydrationWarning
      />
    </>
  );
}
