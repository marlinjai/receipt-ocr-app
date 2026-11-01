// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import DashboardPhoneActions from './DashboardPhoneActions';

afterEach(cleanup);

describe('the dashboard on a phone', () => {
  it('names the page and offers only what works on it: the places are in the bottom bar', async () => {
    const onExport = vi.fn();
    const onToggleAi = vi.fn();
    const user = userEvent.setup();
    render(<DashboardPhoneActions title="Belege" onExport={onExport} onToggleAi={onToggleAi} />);
    expect(screen.getByRole('heading', { name: 'Belege' })).toBeTruthy();
    expect(screen.queryAllByRole('link')).toHaveLength(0);

    await user.click(screen.getByRole('button', { name: 'Als CSV exportieren' }));
    expect(onExport).toHaveBeenCalledOnce();
    await user.click(screen.getByRole('button', { name: 'Assistent' }));
    expect(onToggleAi).toHaveBeenCalledOnce();
  });
});
