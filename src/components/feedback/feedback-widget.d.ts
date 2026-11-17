import type { DetailedHTMLProps, HTMLAttributes } from 'react';

/** The `<feedback-widget>` custom element of Lumitra Feedback, configured by attributes. */
declare module 'react' {
  namespace JSX {
    interface IntrinsicElements {
      'feedback-widget': DetailedHTMLProps<HTMLAttributes<HTMLElement>, HTMLElement> & {
        'publishable-key': string;
        'api-base': string;
        locale?: 'de' | 'en';
        'privacy-url'?: string;
      };
    }
  }
}
