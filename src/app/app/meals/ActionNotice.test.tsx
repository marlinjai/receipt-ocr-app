// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

vi.mock('./actions', () => ({ markMealsNotMeal: vi.fn(), deleteMealReceipts: vi.fn(), restoreMeals: vi.fn() }));

import { ActionNotice } from './useReceiptActions';

/**
 * The outcome notice floats in the dock, so it cannot move the page. These
 * tests cover where it is rendered and how long it stays.
 */

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('ActionNotice', () => {
  it('renders into the dock at the document body, outside the element it was rendered from, and takes the focus', () => {
    const { container } = render(
      <div data-testid="list">
        <ActionNotice notice={{ seq: 1, tone: 'ok', text: '2 Belege gelöscht.' }} onDismiss={vi.fn()} />
      </div>,
    );
    const notice = screen.getByRole('status');
    expect(notice.textContent).toBe('2 Belege gelöscht.');
    expect(container.contains(notice)).toBe(false);
    expect(document.getElementById('ui-dock')!.contains(notice)).toBe(true);
    expect(document.activeElement).toBe(notice);
  });

  it('can be closed by hand', () => {
    const onDismiss = vi.fn();
    render(<ActionNotice notice={{ seq: 1, tone: 'warn', text: 'x' }} onDismiss={onDismiss} />);
    fireEvent.click(screen.getByRole('button', { name: 'Hinweis schließen' }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('a notice without a failure leaves on its own, but not while the focus is still on it', () => {
    const onDismiss = vi.fn();
    render(
      <>
        <button type="button">woanders</button>
        <ActionNotice notice={{ seq: 1, tone: 'ok', text: 'x' }} onDismiss={onDismiss} />
      </>,
    );
    act(() => vi.advanceTimersByTime(8000));
    // Still focused: taking it away now would drop the focus to the top of the page.
    expect(onDismiss).not.toHaveBeenCalled();
    act(() => screen.getByRole('button', { name: 'woanders' }).focus());
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('leaves after its time once the user has moved on', () => {
    const onDismiss = vi.fn();
    render(
      <>
        <button type="button">woanders</button>
        <ActionNotice notice={{ seq: 1, tone: 'ok', text: 'x' }} onDismiss={onDismiss} />
      </>,
    );
    act(() => screen.getByRole('button', { name: 'woanders' }).focus());
    act(() => vi.advanceTimersByTime(7999));
    expect(onDismiss).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('a failure is an alert and stays until it is closed', () => {
    const onDismiss = vi.fn();
    render(
      <>
        <button type="button">woanders</button>
        <ActionNotice notice={{ seq: 1, tone: 'danger', text: 'Datei nicht gelöscht' }} onDismiss={onDismiss} />
      </>,
    );
    expect(screen.getByRole('alert').textContent).toBe('Datei nicht gelöscht');
    act(() => screen.getByRole('button', { name: 'woanders' }).focus());
    act(() => vi.advanceTimersByTime(60_000));
    expect(onDismiss).not.toHaveBeenCalled();
  });
});
