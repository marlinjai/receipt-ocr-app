// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import GroupPanel from './GroupPanel';
import { columns, dinner, emptyGroup, group, hotel } from '@/lib/groups/__tests__/fixture';

afterEach(cleanup);

function panel(overrides: Partial<Parameters<typeof GroupPanel>[0]> = {}) {
  const props = {
    group,
    receipts: [hotel, dinner],
    columns,
    busy: false,
    onClose: vi.fn(),
    onOpenReceipt: vi.fn(),
    onTakeOut: vi.fn(),
    onDissolve: vi.fn(),
    ...overrides,
  };
  render(<GroupPanel {...props} />);
  return props;
}

describe('the panel of a group', () => {
  it('names the group and the sum of its receipts in euros, not the group’s own value', () => {
    panel();
    expect(screen.getByRole('dialog', { name: 'Messe' })).toBeTruthy();
    const summary = screen.getByText(/2 Belege, zusammen/).textContent ?? '';
    expect(summary).toContain('140,00');
    expect(summary).not.toContain('999');
    expect(summary).toContain('Die Gruppe selbst zählt nicht als Beleg.');
  });

  it('takes one receipt out', async () => {
    const user = userEvent.setup();
    const props = panel();
    await user.click(screen.getAllByRole('button', { name: 'Herausnehmen' })[1]);
    expect(props.onTakeOut).toHaveBeenCalledWith('dinner');
  });

  it('opens a receipt', async () => {
    const user = userEvent.setup();
    const props = panel();
    await user.click(screen.getByText('Hotel'));
    expect(props.onOpenReceipt).toHaveBeenCalledWith(hotel);
  });

  it('dissolves the group', async () => {
    const user = userEvent.setup();
    const props = panel();
    await user.click(screen.getByRole('button', { name: 'Gruppe auflösen' }));
    expect(props.onDissolve).toHaveBeenCalledTimes(1);
  });

  it('says how to fill an empty group', () => {
    panel({ group: emptyGroup, receipts: [] });
    expect(screen.getByRole('dialog', { name: 'Leere Gruppe' })).toBeTruthy();
    expect(screen.getByText(/Die Gruppe ist leer/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Herausnehmen' })).toBeNull();
  });
});
