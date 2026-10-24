// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const setBudget = vi.fn();
vi.mock('./budget-actions', () => ({ setBudget: (...a: unknown[]) => setBudget(...a) }));
const refresh = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }));

import BudgetsPanel, { basisLabel, budgetActionMessage } from './BudgetsPanel';
import type { BudgetsView } from './budget-actions';
import { buildOverview, type OverviewPaymentInput } from '@/lib/spending/overview';

const spend = (id: string, bookingDay: string, amountCents: number, counterpartyKey: string): OverviewPaymentInput => ({ id, accountId: 'a1', bookingDay, amountCents, counterparty: counterpartyKey, counterpartyKey, reference: '', kind: 'spend', linkCount: 0 });
const PAYMENTS = [spend('p1', '2026-03-03', -25_000, 'rewe'), spend('p2', '2026-03-05', -4000, 'urban sports club'), spend('p3', '2026-02-10', -9000, 'rewe')];
/** The period shown: March 2026, the month of the budget lines, unless a test asks for another. */
const period = (month: number | null = 3) => ({
  overview: buildOverview(PAYMENTS, { treatments: new Map(), answers: new Map() }, 2026, month),
  today: '2026-03-15',
  period: month === null ? '2026' : month === 3 ? 'März 2026' : 'Februar 2026',
});

afterEach(cleanup);

const view = (canWrite = true): BudgetsView => ({
  month: '2026-03',
  counterparties: ['Kino Beispiel'],
  canWrite,
  lines: [
    { scope: 'category', key: 'groceries_drugstore', label: 'Lebensmittel und Drogerie', limitCents: 20_000, basis: 'average', averageCents: 20_000, averageMonths: 12, allBusiness: false, spentCents: 25_000, projectedCents: 77_500, level: 'passed' },
    { scope: 'category', key: 'leisure_sport', label: 'Freizeit und Sport', limitCents: 9000, basis: 'set', averageCents: 5000, averageMonths: 12, allBusiness: false, spentCents: 4000, projectedCents: 12_400, level: 'on_pace' },
  ],
});

beforeEach(() => {
  setBudget.mockReset().mockResolvedValue({ ok: true, value: view() });
});

describe('BudgetsPanel', () => {
  it('shows each category as budget against spent, with its count, where the limit comes from and how the month stands', () => {
    render(<BudgetsPanel {...period()} initial={view()} />);
    expect(screen.getByRole('heading', { name: /Budget und Ausgaben März 2026/ })).toBeTruthy();
    expect(screen.getByText('2 Warnungen')).toBeTruthy();
    expect(screen.getByText(/März 2026: Durchschnitt der letzten zwölf Monate 200,00 €, überschritten/)).toBeTruthy();
    expect(screen.getByText(/wird bei gleichem Tempo überschritten; etwa 124,00 € zum Monatsende/)).toBeTruthy();
    expect(screen.getByRole('img', { name: /Lebensmittel und Drogerie: 250,00 € ausgegeben, Budget 200,00 € \(Durchschnitt der letzten Monate\)/ })).toBeTruthy();
    const row = screen.getByRole('img', { name: /^Lebensmittel und Drogerie/ }).closest('li') as HTMLElement;
    expect(row.textContent).toContain('1 Zahlung');
    // There is one budget block: no second list of the same numbers.
    expect(screen.getAllByRole('heading', { level: 2 })).toHaveLength(1);
  });

  it('shows another period against the same monthly limits, and says which month the warnings are about', () => {
    render(<BudgetsPanel {...period(2)} initial={view()} />);
    expect(screen.getByRole('img', { name: /Lebensmittel und Drogerie: 90,00 € ausgegeben, Budget 200,00 €/ })).toBeTruthy();
    expect(screen.getByText('2 Warnungen im März')).toBeTruthy();
    // The limit is still changed here.
    expect(screen.getByRole('button', { name: 'Budget für Lebensmittel und Drogerie ändern' })).toBeTruthy();
  });

  it('takes over the budgets the page read afresh', () => {
    const { rerender } = render(<BudgetsPanel {...period()} initial={view()} />);
    expect(screen.getByText('2 Warnungen')).toBeTruthy();
    rerender(<BudgetsPanel {...period()} initial={{ ...view(), lines: view().lines.map((l) => ({ ...l, level: 'ok' as const })) }} />);
    expect(screen.queryByText('2 Warnungen')).toBeNull();
  });

  it('saves a limit typed in euros', async () => {
    render(<BudgetsPanel {...period()} initial={view()} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Budget für Lebensmittel und Drogerie ändern' }));
    const input = screen.getByLabelText('Monatliches Budget für Lebensmittel und Drogerie in Euro');
    await user.clear(input);
    await user.type(input, '300,50');
    await user.click(screen.getByRole('button', { name: 'Budget für Lebensmittel und Drogerie speichern' }));
    expect(setBudget).toHaveBeenCalledWith({ scope: 'category', key: 'groceries_drugstore', label: 'Lebensmittel und Drogerie', limitCents: 30_050 });
    // The charts above compare against the same limits: a saved limit makes the page read them afresh.
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  it('refuses an amount that is none, without calling the server', async () => {
    render(<BudgetsPanel {...period()} initial={view()} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Budget für Lebensmittel und Drogerie ändern' }));
    const input = screen.getByLabelText('Monatliches Budget für Lebensmittel und Drogerie in Euro');
    await user.clear(input);
    await user.type(input, 'viel');
    await user.click(screen.getByRole('button', { name: 'Budget für Lebensmittel und Drogerie speichern' }));
    expect(setBudget).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toMatch(/Betrag in Euro/);
  });

  it('switches a budget off and resets one the owner set', async () => {
    render(<BudgetsPanel {...period()} initial={view()} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Budget für Freizeit und Sport ändern' }));
    await user.click(screen.getByRole('button', { name: 'Zurück zum Durchschnitt' }));
    expect(setBudget).toHaveBeenCalledWith({ scope: 'category', key: 'leisure_sport', label: 'Freizeit und Sport', reset: true });
    await user.click(screen.getByRole('button', { name: 'Budget für Lebensmittel und Drogerie ändern' }));
    await user.click(screen.getByRole('button', { name: 'Ausschalten' }));
    expect(setBudget).toHaveBeenLastCalledWith({ scope: 'category', key: 'groceries_drugstore', label: 'Lebensmittel und Drogerie', limitCents: null });
  });

  it('adds a counterparty budget, and shows a server refusal where it happened', async () => {
    setBudget.mockResolvedValue({ ok: false, error: 'invalid_input', detail: 'invalid_key' });
    render(<BudgetsPanel {...period()} initial={view()} />);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Budget für eine Gegenseite'), 'Kino Beispiel');
    await user.type(screen.getByLabelText('Euro im Monat'), '30');
    await user.click(screen.getByRole('button', { name: 'Hinzufügen' }));
    expect(setBudget).toHaveBeenCalledWith({ scope: 'vendor', label: 'Kino Beispiel', limitCents: 3000 });
    expect((await screen.findByRole('alert')).textContent).toMatch(/Namen der Gegenseite/);
  });

  it('keeps the form and what was typed when the server refuses', async () => {
    setBudget.mockResolvedValue({ ok: false, error: 'failed' });
    render(<BudgetsPanel {...period()} initial={view()} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Budget für Lebensmittel und Drogerie ändern' }));
    const input = screen.getByLabelText('Monatliches Budget für Lebensmittel und Drogerie in Euro') as HTMLInputElement;
    await user.clear(input);
    await user.type(input, '310');
    await user.click(screen.getByRole('button', { name: 'Budget für Lebensmittel und Drogerie speichern' }));
    expect(await screen.findByText(/noch einmal versuchen/)).toBeTruthy();
    expect((screen.getByLabelText('Monatliches Budget für Lebensmittel und Drogerie in Euro') as HTMLInputElement).value).toBe('310');
  });

  it('keeps a new counterparty budget typed in when the server refuses, and offers known names', async () => {
    setBudget.mockResolvedValue({ ok: false, error: 'failed' });
    const { container } = render(<BudgetsPanel {...period()} initial={view()} />);
    expect(container.querySelector('datalist option')?.getAttribute('value')).toBe('Kino Beispiel');
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Budget für eine Gegenseite'), 'Kino Beispiel');
    await user.type(screen.getByLabelText('Euro im Monat'), '30');
    await user.click(screen.getByRole('button', { name: 'Hinzufügen' }));
    await screen.findByRole('alert');
    expect((screen.getByLabelText('Budget für eine Gegenseite') as HTMLInputElement).value).toBe('Kino Beispiel');
    expect(screen.getByLabelText('Budget für eine Gegenseite').getAttribute('aria-invalid')).toBe('true');
  });

  it('removes a counterparty budget and switches one off', async () => {
    const withVendor: BudgetsView = {
      ...view(),
      lines: [{ scope: 'vendor', key: 'kino beispiel', label: 'Kino Beispiel', limitCents: 3000, basis: 'set', averageCents: null, averageMonths: 2, allBusiness: false, spentCents: 4000, projectedCents: 4000, level: 'passed' }],
    };
    setBudget.mockResolvedValue({ ok: true, value: withVendor });
    render(<BudgetsPanel {...period()} initial={withVendor} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Budget für Kino Beispiel ändern' }));
    await user.click(screen.getByRole('button', { name: 'Budget entfernen' }));
    expect(setBudget).toHaveBeenCalledWith({ scope: 'vendor', key: 'kino beispiel', label: 'Kino Beispiel', reset: true });
    await user.click(screen.getByRole('button', { name: 'Budget für Kino Beispiel ändern' }));
    await user.click(screen.getByRole('button', { name: 'Ausschalten' }));
    expect(setBudget).toHaveBeenLastCalledWith({ scope: 'vendor', key: 'kino beispiel', label: 'Kino Beispiel', limitCents: null });
  });

  it('explains a counterparty budget whose payments count as business, and a month of refunds', () => {
    render(
      <BudgetsPanel
        {...period()}
        initial={{
          ...view(),
          lines: [
            { scope: 'vendor', key: 'zyx', label: 'Zyx', limitCents: 3000, basis: 'set', averageCents: null, averageMonths: 2, allBusiness: true, spentCents: 0, projectedCents: 0, level: 'ok' },
            { scope: 'category', key: 'cash', label: 'Bargeld', limitCents: 3000, basis: 'set', averageCents: null, averageMonths: 2, allBusiness: false, spentCents: -4000, projectedCents: -4000, level: 'ok' },
          ],
        }}
      />,
    );
    expect(screen.getByText(/zählen als geschäftlich/)).toBeTruthy();
    expect(screen.getByText(/Gutschriften überwiegen/)).toBeTruthy();
    expect(screen.queryByText(/-40,00/)).toBeNull();
  });

  it('names how many months an average is over when fewer than twelve', () => {
    expect(basisLabel('average', 12)).toBe('Durchschnitt der letzten zwölf Monate');
    expect(basisLabel('average', 3)).toBe('Durchschnitt aus 3 Monaten');
    expect(basisLabel('average', 1)).toBe('Durchschnitt aus einem Monat');
  });

  it('offers no controls without the write permission', () => {
    render(<BudgetsPanel {...period()} initial={view(false)} />);
    expect(screen.queryByRole('button', { name: /ändern/ })).toBeNull();
    expect(screen.queryByLabelText('Budget für eine Gegenseite')).toBeNull();
  });

  it('says what to do for each failure', () => {
    expect(budgetActionMessage({ ok: false, error: 'forbidden' })).toMatch(/Berechtigung/);
    expect(budgetActionMessage({ ok: false, error: 'invalid_input', detail: 'invalid_limit' })).toMatch(/Betrag/);
    expect(budgetActionMessage({ ok: false, error: 'failed' })).toMatch(/noch einmal/);
  });
});
