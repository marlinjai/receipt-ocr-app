// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import GroupBar from './GroupBar';

afterEach(cleanup);

const groups = [
  { id: 'g1', name: 'Kunde' },
  { id: 'g2', name: 'Messe' },
];

function bar(overrides: Partial<Parameters<typeof GroupBar>[0]> = {}) {
  const props = {
    groups,
    receiptCount: 0,
    inGroupCount: 0,
    busy: false,
    onCreate: vi.fn(async () => true),
    onMoveInto: vi.fn(),
    onTakeOut: vi.fn(),
    ...overrides,
  };
  render(<GroupBar {...props} />);
  return props;
}

describe('the group controls of the dashboard', () => {
  it('without a selection offer an empty group only', () => {
    bar();
    expect(screen.getByRole('button', { name: 'Neue Gruppe' })).toBeTruthy();
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(screen.queryByRole('button', { name: /aus der Gruppe nehmen/ })).toBeNull();
  });

  it('create a group with the name typed, and close the form when it worked', async () => {
    const user = userEvent.setup();
    const props = bar({ receiptCount: 2 });
    await user.click(screen.getByRole('button', { name: 'Neue Gruppe mit 2 Belegen' }));
    await user.type(screen.getByLabelText('Name der neuen Gruppe'), 'Messe{Enter}');
    expect(props.onCreate).toHaveBeenCalledWith('Messe');
    expect(screen.queryByLabelText('Name der neuen Gruppe')).toBeNull();
  });

  it('keep the form and the name when the group was not created', async () => {
    const user = userEvent.setup();
    bar({ onCreate: vi.fn(async () => false) });
    await user.click(screen.getByRole('button', { name: 'Neue Gruppe' }));
    await user.type(screen.getByLabelText('Name der neuen Gruppe'), 'Messe');
    await user.click(screen.getByRole('button', { name: 'Leer anlegen' }));
    expect((screen.getByLabelText('Name der neuen Gruppe') as HTMLInputElement).value).toBe('Messe');
  });

  it('do not create a group without a name, and Escape drops the form', async () => {
    const user = userEvent.setup();
    const props = bar();
    await user.click(screen.getByRole('button', { name: 'Neue Gruppe' }));
    expect((screen.getByRole('button', { name: 'Leer anlegen' }) as HTMLButtonElement).disabled).toBe(true);
    await user.type(screen.getByLabelText('Name der neuen Gruppe'), '   {Enter}');
    expect(props.onCreate).not.toHaveBeenCalled();
    await user.keyboard('{Escape}');
    expect(screen.queryByLabelText('Name der neuen Gruppe')).toBeNull();
  });

  it('put the selected receipts into the group chosen', async () => {
    const user = userEvent.setup();
    const props = bar({ receiptCount: 1 });
    await user.selectOptions(screen.getByLabelText('1 Beleg in eine Gruppe legen'), 'g2');
    expect(props.onMoveInto).toHaveBeenCalledWith('g2');
  });

  it('offer no group to move into when there is none', () => {
    bar({ receiptCount: 3, groups: [] });
    expect(screen.queryByRole('combobox')).toBeNull();
  });

  it('take out only the receipts that lie in a group, and say how many', async () => {
    const user = userEvent.setup();
    const props = bar({ receiptCount: 3, inGroupCount: 2 });
    await user.click(screen.getByRole('button', { name: '2 Belege aus der Gruppe nehmen' }));
    expect(props.onTakeOut).toHaveBeenCalledTimes(1);
  });

  it('nothing can be started while an action runs', () => {
    bar({ receiptCount: 1, inGroupCount: 1, busy: true });
    for (const button of screen.getAllByRole('button')) expect((button as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('combobox') as HTMLSelectElement).disabled).toBe(true);
  });
});
