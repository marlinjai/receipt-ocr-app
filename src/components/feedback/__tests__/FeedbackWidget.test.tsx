// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import FeedbackWidget from '../FeedbackWidget';
import FeedbackMenuButton from '../FeedbackMenuButton';

afterEach(cleanup);

describe('Lumitra Feedback on any other origin', () => {
  it('renders nothing, since the publishable key accepts only https://receipts.lumitra.co', () => {
    const { container } = render(
      <>
        <FeedbackWidget />
        <FeedbackMenuButton />
      </>
    );
    expect(container.innerHTML).toBe('');
    expect(document.querySelector('script[src*="feedback-widget"]')).toBeNull();
  });
});
