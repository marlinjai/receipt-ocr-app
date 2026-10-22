// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { buildOverview } from '@/lib/spending/overview';

const answerCategory = vi.fn();
const markOwnAccount = vi.fn();
const withdrawCategory = vi.fn();
const unmarkOwnAccount = vi.fn();
const unlinkRoutedReceipt = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('./actions', () => ({
  answerCategory: (...a: unknown[]) => answerCategory(...a),
  markOwnAccount: (...a: unknown[]) => markOwnAccount(...a),
  withdrawCategory: (...a: unknown[]) => withdrawCategory(...a),
  unmarkOwnAccount: (...a: unknown[]) => unmarkOwnAccount(...a),
  unlinkRoutedReceipt: (...a: unknown[]) => unlinkRoutedReceipt(...a),
}));

import SpendingClient, { spendingActionMessage } from './SpendingClient';
import type { SpendingPageView } from './actions';

afterEach(cleanup);

const pay = { id: 'p1', accountId: 'a1', bookingDay: '2026-04-03', amountCents: -3000, counterparty: 'Zyx Handel', counterpartyKey: 'zyx handel', reference: '', kind: 'spend' as const, linkCount: 0 };
const view = (canWrite: boolean): SpendingPageView => ({
  overview: buildOverview([pay], { treatments: new Map(), answers: new Map() }, 2026, null),
  years: [2026],
  accounts: [],
  sharedOut: [],
  companies: {},
  answers: [{ counterpartyKey: 'abc markt', label: 'ABC Markt', category: 'groceries_drugstore' }],
  ownAccounts: [{ counterpartyKey: 'tagesgeld beispiel', label: 'Tagesgeld Beispiel' }],
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

  it('takes an own-account answer back by its key', async () => {
    unmarkOwnAccount.mockResolvedValue({ ok: true, value: view(true) });
    render(<SpendingClient initial={view(true)} />);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Tagesgeld Beispiel nicht mehr als eigenes Konto führen' }));
    expect(unmarkOwnAccount).toHaveBeenCalledWith(2026, null, 'tagesgeld beispiel');
  });

  it('offers no controls without the write permission', () => {
    render(<SpendingClient initial={view(false)} />);
    expect(screen.queryByLabelText('Kategorie für Zyx Handel')).toBeNull();
    expect(screen.queryByRole('button', { name: /zurücknehmen/ })).toBeNull();
  });
});

describe('SpendingClient with payments of another company', () => {
  const routed = { ...pay, id: 'p2', counterparty: 'Privat Laden', counterpartyKey: 'privat laden', linkCount: 1, routed: true };
  const shared = (canWrite: boolean): SpendingPageView => ({
    ...view(canWrite),
    overview: buildOverview([pay, routed], { treatments: new Map(), answers: new Map() }, 2026, null),
    accounts: [{ id: 'acc', label: 'Girokonto', completeThrough: '2026-04-30', sharedFrom: 'ws-firma' }],
    companies: { 'ws-firma': 'Beispiel Firma' },
  });

  it('names the account with the company that holds it, and takes a private receipt back after a confirmation', async () => {
    unlinkRoutedReceipt.mockResolvedValue({ ok: true, value: shared(true) });
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<SpendingClient initial={shared(true)} />);
    expect(screen.getByText(/Girokonto \(private Zahlungen, geführt von Beispiel Firma\)/)).toBeTruthy();
    // Only the routed payment with a receipt offers it; the own payment without one does not.
    const buttons = screen.getAllByRole('button', { name: /lösen$/ });
    expect(buttons).toHaveLength(1);
    await userEvent.setup().click(buttons[0]);
    expect(confirm).toHaveBeenCalled();
    expect(unlinkRoutedReceipt).toHaveBeenCalledWith(2026, null, 'p2');
    confirm.mockRestore();
  });

  it('shows a refusal next to the payment, and offers nothing without the write permission', async () => {
    unlinkRoutedReceipt.mockResolvedValue({ ok: false, error: 'invalid_input', detail: 'payment_not_found' });
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const { unmount } = render(<SpendingClient initial={shared(true)} />);
    await userEvent.setup().click(screen.getByRole('button', { name: /lösen$/ }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/gehört nicht mehr hierher/);
    confirm.mockRestore();
    unmount();
    render(<SpendingClient initial={shared(false)} />);
    expect(screen.queryByRole('button', { name: /lösen$/ })).toBeNull();
  });

  it('tells the holding company where the private payments of its account went', () => {
    render(<SpendingClient initial={{ ...view(true), sharedOut: [{ accountLabel: 'Girokonto', receiverWorkspaceId: 'ws-privat' }], companies: { 'ws-privat': 'Privat' } }} />);
    expect(screen.getByText(/Girokonto \(an Privat\)/)).toBeTruthy();
  });
});

describe('spendingActionMessage', () => {
  it('says what to do for each failure', () => {
    expect(spendingActionMessage({ ok: false, error: 'unauthorized' })).toMatch(/neu anmelden/);
    expect(spendingActionMessage({ ok: false, error: 'forbidden' })).toMatch(/Berechtigung/);
    expect(spendingActionMessage({ ok: false, error: 'invalid_input', detail: 'counterparty_required' })).toMatch(/keine Gegenseite/);
    expect(spendingActionMessage({ ok: false, error: 'invalid_input', detail: 'invalid_category' })).toMatch(/Kategorie/);
    expect(spendingActionMessage({ ok: false, error: 'failed' })).toMatch(/noch einmal/);
    expect(spendingActionMessage({ ok: false, error: 'invalid_input', detail: 'treatment_exists' })).toMatch(/schon als geschäftlich oder privat/);
    expect(spendingActionMessage({ ok: false, error: 'invalid_input', detail: 'invalid_treatment' })).toMatch(/keinen Namen/);
  });
});
