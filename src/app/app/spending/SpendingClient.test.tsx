// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { buildOverview } from '@/lib/spending/overview';

const answerCategory = vi.fn();
const markOwnAccount = vi.fn();
const withdrawCategory = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('./actions', () => ({
  answerCategory: (...a: unknown[]) => answerCategory(...a),
  markOwnAccount: (...a: unknown[]) => markOwnAccount(...a),
  withdrawCategory: (...a: unknown[]) => withdrawCategory(...a),
}));

import SpendingClient, { spendingActionMessage } from './SpendingClient';
import type { SpendingPageView } from './actions';

afterEach(cleanup);

const pay = { id: 'p1', accountId: 'a1', bookingDay: '2026-04-03', amountCents: -3000, counterparty: 'Zyx Handel', counterpartyKey: 'zyx handel', reference: '', kind: 'spend' as const, linkCount: 0 };
const view = (canWrite: boolean): SpendingPageView => ({
  overview: buildOverview([pay], { treatments: new Map(), answers: new Map() }, 2026, null),
  years: [2026],
  accounts: [],
  answers: [{ counterpartyKey: 'abc markt', label: 'ABC Markt', category: 'groceries_drugstore' }],
  noPayments: false,
  canWrite,
});

beforeEach(() => {
  answerCategory.mockReset();
  markOwnAccount.mockReset();
  withdrawCategory.mockReset();
});

describe('SpendingClient', () => {
  it('saves a category only on the button, not on choosing it', async () => {
    answerCategory.mockResolvedValue({ ok: true, value: view(true) });
    render(<SpendingClient initial={view(true)} />);
    const user = userEvent.setup();
    await user.selectOptions(screen.getByLabelText('Kategorie für Zyx Handel'), 'shopping_household');
    expect(answerCategory).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Kategorie für Zyx Handel zuordnen' }));
    expect(answerCategory).toHaveBeenCalledWith(2026, null, 'Zyx Handel', 'shopping_household');
  });

  it('marks a counterparty as an own account through the payments answer', async () => {
    markOwnAccount.mockResolvedValue({ ok: true, value: view(true) });
    render(<SpendingClient initial={view(true)} />);
    const user = userEvent.setup();
    await user.selectOptions(screen.getByLabelText('Kategorie für Zyx Handel'), 'own_account');
    await user.click(screen.getByRole('button', { name: 'Kategorie für Zyx Handel zuordnen' }));
    expect(markOwnAccount).toHaveBeenCalledWith(2026, null, 'Zyx Handel');
  });

  it('shows a failure in the row it belongs to', async () => {
    answerCategory.mockResolvedValue({ ok: false, error: 'forbidden' });
    render(<SpendingClient initial={view(true)} />);
    const user = userEvent.setup();
    await user.selectOptions(screen.getByLabelText('Kategorie für Zyx Handel'), 'cash');
    await user.click(screen.getByRole('button', { name: 'Kategorie für Zyx Handel zuordnen' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/Berechtigung/);
    const row = alert.closest('li') as HTMLElement;
    expect(within(row).getByLabelText('Kategorie für Zyx Handel')).toBeTruthy();
    await waitFor(() => expect(screen.getAllByRole('alert')).toHaveLength(1));
  });

  it('takes an answer back by its stored key', async () => {
    withdrawCategory.mockResolvedValue({ ok: true, value: view(true) });
    render(<SpendingClient initial={view(true)} />);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Zuordnung für ABC Markt zurücknehmen' }));
    expect(withdrawCategory).toHaveBeenCalledWith(2026, null, 'abc markt');
  });

  it('offers no controls without the write permission', () => {
    render(<SpendingClient initial={view(false)} />);
    expect(screen.queryByLabelText('Kategorie für Zyx Handel')).toBeNull();
    expect(screen.queryByRole('button', { name: /zurücknehmen/ })).toBeNull();
  });
});

describe('spendingActionMessage', () => {
  it('says what to do for each failure', () => {
    expect(spendingActionMessage({ ok: false, error: 'unauthorized' })).toMatch(/neu anmelden/);
    expect(spendingActionMessage({ ok: false, error: 'forbidden' })).toMatch(/Berechtigung/);
    expect(spendingActionMessage({ ok: false, error: 'invalid_input', detail: 'counterparty_required' })).toMatch(/keine Gegenseite/);
    expect(spendingActionMessage({ ok: false, error: 'invalid_input', detail: 'invalid_category' })).toMatch(/Kategorie/);
    expect(spendingActionMessage({ ok: false, error: 'failed' })).toMatch(/noch einmal/);
  });
});
