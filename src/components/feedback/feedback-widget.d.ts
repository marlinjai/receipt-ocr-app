import type { DetailedHTMLProps, HTMLAttributes } from 'react';

// `<feedback-widget>` is a custom element defined by the Lumitra Feedback
// script (see `FeedbackWidget.tsx`). Every attribute it reads, so JSX checks
// the names; the values are strings as in HTML.
declare module 'react' {
  namespace JSX {
    interface IntrinsicElements {
      'feedback-widget': DetailedHTMLProps<HTMLAttributes<HTMLElement>, HTMLElement> & {
        'publishable-key': string;
        /** Required: without it the widget logs a configuration error and renders nothing. */
        'api-base': string;
        locale?: 'de' | 'en';
        theme?: 'light' | 'dark' | 'auto';
        accent?: string;
        position?: 'bottom-right' | 'bottom-left';
        'privacy-url'?: string;
        labels?: string;
        'keep-query-params'?: string;
        shortcut?: string;
        /** Present means on: the shortcut also fires while typing. */
        'shortcut-in-inputs'?: boolean;
        /** `false` (or `off`) hides the floating button; anything else keeps it. */
        launcher?: 'false' | 'off';
        'user-id'?: string;
        'user-signature'?: string;
        'user-expires-at'?: string;
        'capture-src'?: string;
        'style-nonce'?: string;
      };
    }
  }
}
