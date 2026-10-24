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
const saveOwnNames = vi.fn();
const refresh = vi.fn();
const push = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ push, refresh }) }));
vi.mock('./actions', () => ({
  answerCategory: (...a: unknown[]) => answerCategory(...a),
  markOwnAccount: (...a: unknown[]) => markOwnAccount(...a),
  withdrawCategory: (...a: unknown[]) => withdrawCategory(...a),
  unmarkOwnAccount: (...a: unknown[]) => unmarkOwnAccount(...a),
  unlinkRoutedReceipt: (...a: unknown[]) => unlinkRoutedReceipt(...a),
  saveOwnNames: (...a: unknown[]) => saveOwnNames(...a),
}));

vi.mock('./budget-actions', () => ({ setBudget: vi.fn() }));

import SpendingClient, { spendingActionMessage } from './SpendingClient';
import type { BudgetsView } from './budget-actions';
import { spendingHref, spendingTabOf } from '@/lib/spending/paths';
import type { BudgetLine } from '@/lib/spending/budgets';
import type { SpendingPageView } from './actions';

afterEach(cleanup);

const pay = { id: 'p1', accountId: 'a1', bookingDay: '2026-04-03', amountCents: -3000, counterparty: 'Zyx Handel', counterpartyKey: 'zyx handel', reference: '', kind: 'spend' as const, linkCount: 0 };
const view = (canWrite: boolean): SpendingPageView => ({
  overview: buildOverview([pay], { treatments: new Map(), answers: new Map() }, 2026, null),
  years: [2026],
  accounts: [],
  sharedOut: [],
  dormantLinks: [],
  companies: {},
  answers: [{ counterpartyKey: 'abc markt', label: 'ABC Markt', category: 'groceries_drugstore' }],
  ownAccounts: [{ counterpartyKey: 'tagesgeld beispiel', label: 'Tagesgeld Beispiel', byName: false }],
  ownNames: [],
  noPayments: false,
  canWrite,
});

beforeEach(() => {
  answerCategory.mockReset();
  markOwnAccount.mockReset();
  withdrawCategory.mockReset();
  saveOwnNames.mockReset();
  push.mockReset();
});

describe('SpendingClient', () => {
  it('saves a category only on the button, not on choosing it', async () => {
    answerCategory.mockResolvedValue({ ok: true, value: view(true) });
    render(<SpendingClient today="2026-04-15" initial={view(true)} />);
    const user = userEvent.setup();
    await user.selectOptions(screen.getByLabelText('Kategorie für Zyx Handel'), 'shopping_household');
    expect(answerCategory).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Kategorie für Zyx Handel zuordnen' }));
    expect(answerCategory).toHaveBeenCalledWith(2026, null, 'Zyx Handel', 'shopping_household');
  });

  it('marks a counterparty as an own account through the payments answer', async () => {
    markOwnAccount.mockResolvedValue({ ok: true, value: view(true) });
    render(<SpendingClient today="2026-04-15" initial={view(true)} />);
    const user = userEvent.setup();
    await user.selectOptions(screen.getByLabelText('Kategorie für Zyx Handel'), 'own_account');
    await user.click(screen.getByRole('button', { name: 'Kategorie für Zyx Handel zuordnen' }));
    expect(markOwnAccount).toHaveBeenCalledWith(2026, null, 'Zyx Handel');
  });

  it('shows a failure in the row it belongs to', async () => {
    answerCategory.mockResolvedValue({ ok: false, error: 'forbidden' });
    render(<SpendingClient today="2026-04-15" initial={view(true)} />);
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
    render(<SpendingClient today="2026-04-15" initial={view(true)} />);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Zuordnung für ABC Markt zurücknehmen' }));
    expect(withdrawCategory).toHaveBeenCalledWith(2026, null, 'abc markt');
  });

  it('takes an own-account answer back by its key', async () => {
    unmarkOwnAccount.mockResolvedValue({ ok: true, value: view(true) });
    render(<SpendingClient today="2026-04-15" initial={view(true)} />);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Tagesgeld Beispiel nicht mehr als eigenes Konto führen' }));
    expect(unmarkOwnAccount).toHaveBeenCalledWith(2026, null, 'tagesgeld beispiel');
  });

  it('offers no controls without the write permission', () => {
    render(<SpendingClient today="2026-04-15" initial={view(false)} />);
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
    render(<SpendingClient today="2026-04-15" initial={shared(true)} />);
    expect(screen.getByText(/Girokonto \(private Zahlungen, geführt von Beispiel Firma\)/)).toBeTruthy();
    // Only the routed payment with a receipt offers it; the own payment without one does not.
    const buttons = screen.getAllByRole('button', { name: /^Lösen: / });
    expect(buttons).toHaveLength(1);
    await userEvent.setup().click(buttons[0]);
    expect(confirm).toHaveBeenCalled();
    expect(unlinkRoutedReceipt).toHaveBeenCalledWith(2026, null, 'p2');
    // The open checks below read the same payments: the page reads them afresh.
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    confirm.mockRestore();
  });

  it('shows a refusal next to the payment, and offers nothing without the write permission', async () => {
    unlinkRoutedReceipt.mockResolvedValue({ ok: false, error: 'invalid_input', detail: 'link_not_found' });
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const { unmount } = render(<SpendingClient today="2026-04-15" initial={shared(true)} />);
    await userEvent.setup().click(screen.getByRole('button', { name: /^Lösen: / }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/kein Beleg mehr/);
    confirm.mockRestore();
    unmount();
    render(<SpendingClient today="2026-04-15" initial={shared(false)} />);
    expect(screen.queryByRole('button', { name: /^Lösen: / })).toBeNull();
  });

  it('lists a receipt left on a payment that moved away, and frees it after a confirmation', async () => {
    unlinkRoutedReceipt.mockResolvedValue({ ok: true, value: view(true) });
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<SpendingClient today="2026-04-15" initial={{ ...view(true), dormantLinks: [{ paymentId: 'p9', receipts: 1, cents: 2000, linkedOn: '2026-05-10' }] }} />);
    expect(screen.getByText(/Belege an Zahlungen, die nicht mehr hierher gehören \(1\)/)).toBeTruthy();
    await userEvent.setup().click(screen.getByRole('button', { name: /^Lösen: Beleg, verknüpft am / }));
    expect(unlinkRoutedReceipt).toHaveBeenCalledWith(2026, null, 'p9');
    confirm.mockRestore();
  });

  it('tells the holding company where the private payments of its account went', () => {
    render(<SpendingClient today="2026-04-15" initial={{ ...view(true), sharedOut: [{ accountLabel: 'Girokonto', receiverWorkspaceId: 'ws-privat' }], companies: { 'ws-privat': 'Privat' } }} />);
    expect(screen.getByText(/Girokonto \(an Privat\)/)).toBeTruthy();
  });
});

const budgetsOf = (lines: BudgetLine[] = []): BudgetsView => ({ lines, month: '2026-04', counterparties: [], canWrite: true });

describe('SpendingClient tabs', () => {
  it('opens the overview by default and keeps the period when switching to the receipt checks, with the open count on the tab', async () => {
    render(<SpendingClient today="2026-04-15" initial={view(true)} openChecks={7} checks={<p>Belegliste</p>} budgets={budgetsOf()} />);
    expect(screen.getByRole('tab', { name: 'Überblick' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('heading', { name: /Budget und Ausgaben 2026/ })).toBeTruthy();
    expect(screen.queryByText('Belegliste')).toBeNull();
    const checks = screen.getByRole('tab', { name: /Belege/ });
    expect(checks.textContent).toMatch(/7/);
    await userEvent.setup().click(checks);
    expect(push).toHaveBeenCalledWith('/app/spending?jahr=2026&ansicht=belege', { scroll: false });
  });

  it('shows the receipt checks on their tab, and nothing of the overview', () => {
    render(<SpendingClient today="2026-04-15" tab="belege" initial={view(true)} openChecks={0} checks={<p>Belegliste</p>} budgets={budgetsOf()} />);
    expect(screen.getByRole('tab', { name: /Belege/ }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByText('Belegliste')).toBeTruthy();
    expect(screen.queryByText(/Budget und Ausgaben/)).toBeNull();
    expect(screen.queryByText(/Monate 2026 nach Kategorie/)).toBeNull();
  });

  it('a click on a month filters to it through the address, and a second click shows the whole year again', async () => {
    const user = userEvent.setup();
    const { unmount } = render(<SpendingClient today="2026-04-15" initial={view(true)} />);
    await user.click(screen.getByRole('button', { name: /^April: 30,00 €/ }));
    expect(push).toHaveBeenLastCalledWith('/app/spending?jahr=2026&monat=4', { scroll: false });
    unmount();
    const april: SpendingPageView = { ...view(true), overview: buildOverview([pay], { treatments: new Map(), answers: new Map() }, 2026, 4) };
    render(<SpendingClient today="2026-04-15" initial={april} />);
    const month = screen.getByRole('button', { name: /^April: 30,00 €, gewählt/ });
    expect(month.getAttribute('aria-pressed')).toBe('true');
    await user.click(month);
    expect(push).toHaveBeenLastCalledWith('/app/spending?jahr=2026', { scroll: false });
  });

  it('builds the address of a period and a tab, and reads the tab back from it after a reload', () => {
    expect(spendingHref(2026, null, 'ueberblick')).toBe('/app/spending?jahr=2026');
    expect(spendingHref(2025, 12, 'belege')).toBe('/app/spending?jahr=2025&monat=12&ansicht=belege');
    expect(spendingTabOf('belege', undefined)).toBe('belege');
    expect(spendingTabOf(undefined, undefined)).toBe('ueberblick');
    expect(spendingTabOf('irgendwas', undefined)).toBe('ueberblick');
    // A notification about a payment opens the receipt checks, whatever else the address says.
    expect(spendingTabOf(undefined, 'pay-1')).toBe('belege');
  });

  it('keeps the receipt checks open when the period changes there, and moves between tabs with the arrow keys', async () => {
    const user = userEvent.setup();
    render(<SpendingClient today="2026-04-15" tab="belege" initial={view(true)} openChecks={2} checks={<p>Belegliste</p>} />);
    await user.selectOptions(screen.getByLabelText('Monat'), '3');
    expect(push).toHaveBeenLastCalledWith('/app/spending?jahr=2026&monat=3&ansicht=belege', { scroll: false });
    const checks = screen.getByRole('tab', { name: /Belege/ });
    expect(checks.getAttribute('tabindex')).toBe('0');
    expect(screen.getByRole('tab', { name: 'Überblick' }).getAttribute('aria-controls')).toBeNull();
    checks.focus();
    await user.keyboard('{ArrowLeft}');
    expect(push).toHaveBeenLastCalledWith('/app/spending?jahr=2026', { scroll: false });
  });
});

describe('SpendingClient charts', () => {
  const line = (key: string, limitCents: number | null, extra: Partial<BudgetLine> = {}): BudgetLine => ({
    scope: 'category',
    key,
    label: key,
    limitCents,
    basis: 'set',
    averageCents: null,
    averageMonths: 0,
    allBusiness: false,
    spentCents: 0,
    projectedCents: 0,
    level: 'ok',
    ...extra,
  });

  it('draws the months with the budget line, budget against spent, and the biggest counterparties, each also in words', () => {
    const april: SpendingPageView = { ...view(true), overview: buildOverview([pay], { treatments: new Map(), answers: new Map() }, 2026, 4) };
    render(<SpendingClient today="2026-04-15" initial={april} budgets={budgetsOf([line('unclear', 2000, { projectedCents: 5000, level: 'passed' }), line('cash', 10_000)])} />);
    expect(screen.getByText(/Budgets 120 € im Monat/)).toBeTruthy();
    // Over budget is said in words, not by colour alone.
    const bar = screen.getByRole('img', { name: /Unklar: 30,00 € ausgegeben, Budget 20,00 €, bei gleichem Tempo etwa 50,00 €, überschritten/ });
    expect(bar).toBeTruthy();
    const top = screen.getByRole('heading', { name: 'Größte Gegenseiten April 2026' }).closest('section') as HTMLElement;
    expect(within(top).getByText('Zyx Handel')).toBeTruthy();
    expect(within(top).getByText('100 %')).toBeTruthy();
    // The months chart has its table.
    expect(screen.getByRole('table', { name: /Ausgaben 2026 nach Monat und Kategorie/ })).toBeTruthy();
  });

  it('says so when the budgets could not be read, and keeps the other charts', () => {
    render(<SpendingClient today="2026-04-15" initial={view(true)} budgets={null} />);
    expect(screen.queryByText(/Budget und Ausgaben/)).toBeNull();
    expect(screen.getByText(/Die Budgets konnten nicht geladen werden/)).toBeTruthy();
    expect(screen.getByText(/Monate 2026 nach Kategorie/)).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Größte Gegenseiten 2026' })).toBeTruthy();
  });
});

describe('SpendingClient waiting collections', () => {
  it('names a collective debit that waits for the next list under the totals', () => {
    const waiting = { ...pay, id: 'p-k', counterparty: 'Klarna Bank AB', counterpartyKey: 'klarna bank ab', amountCents: -126_169, kind: 'own_transfer' as const, awaitingList: 'klarna' };
    render(<SpendingClient today="2026-10-24" initial={{ ...view(true), overview: buildOverview([pay, waiting], { treatments: new Map(), answers: new Map() }, 2026, null) }} />);
    expect(screen.getByText(/Nicht mitgezählt: 1 Klarna-Sammelzahlung über 1\.261,69 € wartet auf die nächste Klarna-Liste\./)).toBeTruthy();
    // The payments table says it waits, not merely "Umbuchung".
    expect(screen.getByText('Sammelzahlung, wartet auf die nächste Klarna-Liste')).toBeTruthy();
  });
});

describe('SpendingClient own names', () => {
  it('asks for a name up front while there is none, adds it, and says which messages it settled', async () => {
    saveOwnNames.mockResolvedValue({ ok: true, value: { ...view(true), ownNames: ['Erika Beispiel'], settledOwnName: 2 } });
    render(<SpendingClient today="2026-04-15" initial={view(true)} />);
    expect(screen.getByText(/Noch kein eigener Name hinterlegt/)).toBeTruthy();
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Eigener Name, wie die Bank ihn schreibt'), 'Erika Beispiel');
    await user.click(screen.getByRole('button', { name: 'Eigenen Namen hinzufügen' }));
    expect(saveOwnNames).toHaveBeenCalledWith(2026, null, { add: 'Erika Beispiel' });
    await waitFor(() => expect(screen.getByText('Eigene Namen (1)')).toBeTruthy());
    expect(screen.getByText(/Erika Beispiel gespeichert\. 2 Benachrichtigungen erledigt: eigenes Konto\./)).toBeTruthy();
    expect(refresh).toHaveBeenCalled();
  });

  it('removes a name, keeps a refused name in the field with the reason, and shows name-made own accounts without a take-back', async () => {
    const named: SpendingPageView = {
      ...view(true),
      ownNames: ['Erika Beispiel', 'Beispiel, Erika M.'],
      ownAccounts: [{ counterpartyKey: 'erika beispiel', label: 'ERIKA BEISPIEL', byName: true }],
    };
    saveOwnNames.mockResolvedValueOnce({ ok: true, value: { ...named, ownNames: ['Erika Beispiel'], settledOwnName: 0 } });
    render(<SpendingClient today="2026-04-15" initial={named} />);
    const user = userEvent.setup();
    expect(screen.getByText('über Eigene Namen')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'ERIKA BEISPIEL nicht mehr als eigenes Konto führen' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Beispiel, Erika M. aus den eigenen Namen entfernen' }));
    expect(saveOwnNames).toHaveBeenCalledWith(2026, null, { remove: 'Beispiel, Erika M.' });
    expect(await screen.findByText(/Beispiel, Erika M\. entfernt\. Zahlungen an diesen Namen zählen wieder als Ausgabe\./)).toBeTruthy();
    saveOwnNames.mockResolvedValueOnce({ ok: false, error: 'invalid_input', detail: 'invalid_names' });
    const input = screen.getByLabelText('Eigener Name, wie die Bank ihn schreibt');
    await user.type(input, '-');
    await user.click(screen.getByRole('button', { name: 'Eigenen Namen hinzufügen' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/zwei Buchstaben/);
    expect((input as HTMLInputElement).value).toBe('-');
  });

  it('keeps a half-typed name when something else on the page changes', async () => {
    withdrawCategory.mockResolvedValue({ ok: true, value: { ...view(true), ownNames: ['Erika Beispiel'] } });
    render(<SpendingClient today="2026-04-15" initial={{ ...view(true), ownNames: ['Erika Beispiel'] }} />);
    const user = userEvent.setup();
    await user.click(screen.getByText('Eigene Namen (1)'));
    const input = screen.getByLabelText('Eigener Name, wie die Bank ihn schreibt') as HTMLInputElement;
    await user.type(input, 'Erika M');
    await user.click(screen.getByRole('button', { name: 'Zuordnung für ABC Markt zurücknehmen' }));
    await waitFor(() => expect(withdrawCategory).toHaveBeenCalled());
    expect(input.value).toBe('Erika M');
  });

  it('tells a person who may not change the names who can', () => {
    render(<SpendingClient today="2026-04-15" initial={view(false)} />);
    expect(screen.getByText(/Eintragen kann ihn, wer in diesem Arbeitsbereich ändern darf/)).toBeTruthy();
  });

  it('shows the names without controls to a person who may not change them', () => {
    render(<SpendingClient today="2026-04-15" initial={{ ...view(false), ownNames: ['Erika Beispiel'] }} />);
    expect(screen.queryByLabelText('Eigener Name, wie die Bank ihn schreibt')).toBeNull();
    expect(screen.getByText('Erika Beispiel')).toBeTruthy();
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
    expect(spendingActionMessage({ ok: false, error: 'invalid_input', detail: 'invalid_names' })).toMatch(/zwei Buchstaben/);
    expect(spendingActionMessage({ ok: false, error: 'invalid_input', detail: 'name_too_long' })).toMatch(/höchstens 120 Zeichen/);
    expect(spendingActionMessage({ ok: false, error: 'invalid_input', detail: 'too_many_names' })).toMatch(/höchstens 20/);
    expect(spendingActionMessage({ ok: false, error: 'invalid_input', detail: 'name_listed' })).toMatch(/schon in der Liste/);
    expect(spendingActionMessage({ ok: false, error: 'invalid_input', detail: 'name_not_listed' })).toMatch(/nicht mehr in der Liste/);
  });
});
