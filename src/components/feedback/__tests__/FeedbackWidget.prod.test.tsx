// @vitest-environment jsdom
// @vitest-environment-options { "url": "https://receipts.lumitra.co/app" }
import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import FeedbackWidget, { FEEDBACK_WIDGET_INTEGRITY, FEEDBACK_WIDGET_SRC } from '../FeedbackWidget';
import FeedbackMenuButton from '../FeedbackMenuButton';

afterEach(cleanup);

describe('Lumitra Feedback on the production origin', () => {
  it('loads the pinned script and configures the widget without its floating button', () => {
    render(<FeedbackWidget />);
    const script = document.querySelector(`script[src="${FEEDBACK_WIDGET_SRC}"]`);
    expect(script).not.toBeNull();
    expect(script?.getAttribute('integrity')).toBe(FEEDBACK_WIDGET_INTEGRITY);
    expect(script?.getAttribute('crossorigin')).toBe('anonymous');
    const el = document.querySelector('feedback-widget');
    expect(el?.getAttribute('locale')).toBe('de');
    expect(el?.getAttribute('theme')).toBe('dark');
    expect(el?.getAttribute('launcher')).toBe('false');
    expect(el?.getAttribute('publishable-key')).toMatch(/^pk_live_/);
  });

  it('shows the menu entry once the element is defined, and the entry opens it', async () => {
    let opened = 0;
    let closedSheet = 0;
    render(
      <>
        <FeedbackWidget />
        <FeedbackMenuButton onOpen={() => closedSheet++} />
      </>
    );
    expect(screen.queryByRole('button', { name: /Feedback/ })).toBeNull();
    await act(async () => {
      customElements.define(
        'feedback-widget',
        class extends HTMLElement {
          open() {
            opened++;
          }
        }
      );
      await customElements.whenDefined('feedback-widget');
    });
    await userEvent.click(await screen.findByRole('button', { name: /Feedback/ }));
    expect(opened).toBe(1);
    expect(closedSheet).toBe(1);
  });
});
