// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const save = vi.fn();
const list = vi.fn();
vi.mock('../rules-actions', () => ({
  saveClassificationRule: (...a: unknown[]) => save(...a),
  listClassificationRules: (...a: unknown[]) => list(...a),
  deleteClassificationRule: vi.fn(),
}));

import RulesClient from './RulesClient';

afterEach(() => {
  cleanup();
  save.mockReset();
  list.mockReset();
});

const loaded = { rules: [{ id: '1', label: '', type: 'freetext' as const, matchValue: 'Amazon ist gemischt.', zuordnung: null }], companyLabel: 'Whiz-Art Media' };

describe('RulesClient: statements about the person', () => {
  it('saves a statement that names no single assignment, and lists it without one', async () => {
    save.mockResolvedValue({ ok: true, value: {} });
    list.mockResolvedValue({ ok: true, value: loaded });
    render(<RulesClient initial={{ rules: [], companyLabel: null }} />);
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Art' }), 'Aussage über mich');
    await userEvent.type(screen.getByRole('textbox', { name: 'Hinweis' }), 'Amazon ist gemischt.');
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Zuordnung' }), 'keine bestimmte');
    await userEvent.click(screen.getByRole('button', { name: 'Regel speichern' }));
    expect(save).toHaveBeenCalledWith({ type: 'freetext', matchValue: 'Amazon ist gemischt.', zuordnung: null, categoryOverride: null });
    expect(await screen.findByText('Aussage über mich „Amazon ist gemischt.“')).toBeTruthy();
  });

  it('a vendor rule always names an assignment, also after a statement left it open', async () => {
    save.mockResolvedValue({ ok: true, value: {} });
    list.mockResolvedValue({ ok: true, value: { rules: [], companyLabel: null } });
    render(<RulesClient initial={{ rules: [], companyLabel: null }} />);
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Art' }), 'Aussage über mich');
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Zuordnung' }), 'keine bestimmte');
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Art' }), 'Anbieter enthält');
    expect(screen.queryByRole('option', { name: 'keine bestimmte' })).toBeNull();
    await userEvent.type(screen.getByRole('textbox', { name: 'Text' }), 'Hetzner');
    await userEvent.click(screen.getByRole('button', { name: 'Regel speichern' }));
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ type: 'vendor', zuordnung: 'Geschäftlich' }));
  });
});
