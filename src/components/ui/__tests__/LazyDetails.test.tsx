// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import LazyDetails from '../LazyDetails';

afterEach(cleanup);

const rows = (n: number) => (
  <ul>
    {Array.from({ length: n }, (_, i) => (
      <li key={i}>Zeile {i}</li>
    ))}
  </ul>
);

const toggle = (details: HTMLDetailsElement, open: boolean) =>
  act(() => {
    details.open = open;
    fireEvent(details, new Event('toggle'));
  });

describe('LazyDetails', () => {
  it('builds nothing of its content while closed, only the summary', () => {
    const { container } = render(<LazyDetails summary="Zahlungen (500)">{rows(500)}</LazyDetails>);
    expect(screen.getByText('Zahlungen (500)')).toBeTruthy();
    expect(container.querySelectorAll('li')).toHaveLength(0);
  });

  it('builds the content on the first open and keeps it after closing', () => {
    const { container } = render(<LazyDetails summary="Zahlungen (500)">{rows(500)}</LazyDetails>);
    const details = container.querySelector('details')!;
    toggle(details, true);
    expect(container.querySelectorAll('li')).toHaveLength(500);
    toggle(details, false);
    expect(container.querySelectorAll('li')).toHaveLength(500);
  });

  it('a toggle that closes (the browser fires one for a details closed by script) builds nothing', () => {
    const { container } = render(<LazyDetails summary="Zahlungen">{rows(3)}</LazyDetails>);
    toggle(container.querySelector('details')!, false);
    expect(container.querySelectorAll('li')).toHaveLength(0);
  });
});
