// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import DashboardPhoneActions from './DashboardPhoneActions';

vi.mock('../actions', () => ({ recomputeFxRates: vi.fn() }));

afterEach(cleanup);

function actions(openMealCount = 3) {
  const props = { title: 'Receipts', openMealCount, aiOpen: false, onExport: vi.fn(), onToggleAi: vi.fn() };
  render(<DashboardPhoneActions {...props} />);
  return props;
}

describe('the dashboard actions on a phone', () => {
  it('keeps the heading and the upload in reach and the rest behind "Mehr"', () => {
    actions();
    expect(screen.getByRole('heading', { name: 'Receipts' })).toBeTruthy();
    expect(screen.getByRole('link', { name: '+ Hochladen' }).getAttribute('href')).toBe('/app');
    expect(screen.queryByRole('link', { name: /Finanzen/ })).toBeNull();
    expect(screen.getByRole('button', { name: 'Mehr' }).getAttribute('aria-expanded')).toBe('false');
  });

  it('opens the menu with every destination of the wide row, and closes it again', async () => {
    const user = userEvent.setup();
    actions();
    await user.click(screen.getByRole('button', { name: 'Mehr' }));
    expect(screen.getByRole('button', { name: 'Mehr' }).getAttribute('aria-expanded')).toBe('true');
    const hrefs = screen.getAllByRole('link').map((a) => a.getAttribute('href'));
    expect(hrefs).toEqual(['/app', '/app/overview', '/app/finance', '/app/meals', '/app/contacts', '/app/import']);
    expect(screen.getByRole('button', { name: /Recompute FX/ })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Mehr' }));
    expect(screen.queryByRole('navigation')).toBeNull();
  });

  it('counts the open business meals on their entry', async () => {
    const user = userEvent.setup();
    actions(4);
    await user.click(screen.getByRole('button', { name: 'Mehr' }));
    expect(screen.getByLabelText('4 offen')).toBeTruthy();
  });

  it('exports and opens the assistant, closing the menu each time', async () => {
    const user = userEvent.setup();
    const props = actions();
    await user.click(screen.getByRole('button', { name: 'Mehr' }));
    await user.click(screen.getByRole('button', { name: /Export CSV/ }));
    expect(props.onExport).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('navigation')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Mehr' }));
    await user.click(screen.getByRole('button', { name: /AI/ }));
    expect(props.onToggleAi).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('navigation')).toBeNull();
  });
});
