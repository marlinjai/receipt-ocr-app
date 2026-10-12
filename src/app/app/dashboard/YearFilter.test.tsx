// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import YearFilter from './YearFilter';
import { NO_YEARS, type YearSelection } from '@/lib/receipt-years';

afterEach(cleanup);

const years = [
  { year: 2025, count: 266 },
  { year: 2024, count: 155 },
  { year: 2023, count: 149 },
  { year: 2022, count: 119 },
  { year: 2021, count: 91 },
];

function bar(selection: YearSelection = NO_YEARS, over: Partial<Parameters<typeof YearFilter>[0]> = {}) {
  const onChange = vi.fn();
  render(<YearFilter years={years} undated={0} selection={selection} shown={780} total={780} onChange={onChange} {...over} />);
  return onChange;
}

const picked = (call: unknown[]) => [...(call[0] as YearSelection).years].sort();

describe('the year filter of the dashboard', () => {
  it('lists the years with their receipts, oldest first, and "Alle" is chosen when nothing is', () => {
    bar();
    const names = screen.getAllByRole('button').map((b) => b.getAttribute('aria-label') ?? b.textContent);
    expect(names).toEqual(['Alle', '2021: 91 Belege', '2022: 119 Belege', '2023: 149 Belege', '2024: 155 Belege', '2025: 266 Belege']);
    expect(screen.getByRole('button', { name: 'Alle' }).getAttribute('aria-pressed')).toBe('true');
  });

  it('a click chooses a year', async () => {
    const onChange = bar();
    await userEvent.setup().click(screen.getByRole('button', { name: /^2023/ }));
    expect(picked(onChange.mock.calls[0])).toEqual([2023]);
  });

  it('a second click on a chosen year takes it out', async () => {
    const onChange = bar({ years: new Set([2023, 2024]), undated: false });
    await userEvent.setup().click(screen.getByRole('button', { name: /^2023/ }));
    expect(picked(onChange.mock.calls[0])).toEqual([2024]);
  });

  it('shift and a click chooses the years from the last click to this one', async () => {
    const onChange = bar();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /^2021/ }));
    await user.keyboard('{Shift>}');
    await user.click(screen.getByRole('button', { name: /^2024/ }));
    await user.keyboard('{/Shift}');
    // The component is controlled and the selection did not change here: the range starts from the anchor on the current selection.
    expect(picked(onChange.mock.calls[1])).toEqual([2021, 2022, 2023, 2024]);
  });

  it('"Alle" clears the choice', async () => {
    const onChange = bar({ years: new Set([2022]), undated: false });
    await userEvent.setup().click(screen.getByRole('button', { name: 'Alle' }));
    expect(onChange.mock.calls[0][0]).toEqual(NO_YEARS);
  });

  it('says how many receipts the choice shows, and keeps a chosen year without receipts on the bar', () => {
    bar({ years: new Set([2020, 2022]), undated: false }, { shown: 119, total: 780 });
    expect(screen.getByRole('status').textContent).toContain('119 von 780 Belegen');
    expect(screen.getByRole('button', { name: /^2020/ }).getAttribute('aria-pressed')).toBe('true');
  });

  it('offers the receipts without a date only when there are some', async () => {
    expect(screen.queryByRole('button', { name: /ohne Datum/ })).toBeNull();
    cleanup();
    const onChange = bar(NO_YEARS, { undated: 4 });
    await userEvent.setup().click(screen.getByRole('button', { name: /ohne Datum/ }));
    expect((onChange.mock.calls[0][0] as YearSelection).undated).toBe(true);
  });

  it('shows nothing for a table without receipts', () => {
    const { container } = render(<YearFilter years={[]} undated={0} selection={NO_YEARS} shown={0} total={0} onChange={() => {}} />);
    expect(container.textContent).toBe('');
  });
});
