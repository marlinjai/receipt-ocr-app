// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { rulesForYear } from '@/lib/tax/rules';
import type { StatementItem, StatementView } from '@/lib/tax/service';

const actions = vi.hoisted(() => ({ decideItem: vi.fn(), resetItem: vi.fn(), removeVendorRule: vi.fn() }));
vi.mock('./actions', () => actions);
const push = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }));

import FinanceClient, { openQueue } from './FinanceClient';

afterEach(cleanup);
beforeEach(() => {
  for (const fn of Object.values(actions)) fn.mockReset();
  push.mockReset();
});

function item(overrides: Partial<StatementItem> & { rowId: string }): StatementItem {
  return {
    label: `Rechnung ${overrides.rowId}`,
    vendor: 'Netzwerk Nord GmbH',
    vendorKey: 'netzwerk nord',
    date: '2025-03-14',
    category: 'Telefon & Internet',
    gross: 39.99,
    currency: 'EUR',
    amountCents: 3999,
    amountBasis: 'document',
    allocations: null,
    allocationOrigin: null,
    formLineKey: 'euer.telecom',
    formLineOrigin: 'category_default',
    employmentLineKey: null,
    hasDecision: false,
    vendorRuleId: null,
    isMeal: false,
    counted: false,
    parts: [],
    privateCents: 0,
    checks: [{ itemId: overrides.rowId, kind: 'no_allocation', blocking: true }],
    ...overrides,
  };
}

function view(items: StatementItem[], overrides: Partial<StatementView> = {}): StatementView {
  const { rules } = rulesForYear(2025);
  const counted = items.filter((i) => i.counted);
  return {
    year: 2025,
    years: [2026, 2025],
    smallBusiness: true,
    rulesYear: 2025,
    rulesExact: true,
    rulesReviewedOn: rules.reviewedOn,
    formLinesVerified: true,
    formLinesSource: rules.formLinesSource,
    formLines: [...rules.formLines],
    lines: counted.length
      ? [
          {
            key: 'euer.telecom',
            form: 'euer',
            line: 43,
            label: 'Aufwendungen für Telekommunikation (z. B. Telefon, Internet)',
            kind: 'expense',
            cents: counted.reduce((s, i) => s + i.parts.reduce((p, x) => p + x.cents, 0), 0),
            nonDeductibleCents: 0,
            itemIds: counted.map((i) => i.rowId),
            assetIds: [],
          },
        ]
      : [],
    businessExpenseCents: counted.reduce((s, i) => s + i.parts.reduce((p, x) => p + x.cents, 0), 0),
    employmentCostCents: 0,
    privateCents: 0,
    countedItems: counted.length,
    blockedItems: items.length - counted.length,
    items,
    vendorRules: [],
    initialized: true,
    ...overrides,
  };
}

const decided = (rowId: string): StatementItem =>
  item({
    rowId,
    counted: true,
    checks: [],
    allocations: [{ purpose: 'business', shareBp: 5000 }],
    allocationOrigin: 'item',
    hasDecision: true,
    parts: [{ lineKey: 'euer.telecom', purpose: 'business', cents: 2000, nonDeductibleCents: 0 }],
  });

describe('openQueue', () => {
  it('lists what needs a person and leaves workspace-wide questions to the notice', () => {
    const v = view([
      item({ rowId: 'a' }),
      item({ rowId: 'b', checks: [{ itemId: 'b', kind: 'small_business_unanswered', blocking: true }] }),
      item({ rowId: 'c', counted: true, checks: [{ itemId: 'c', kind: 'amount_estimated', blocking: false }] }),
    ]);
    expect(openQueue(v).map((i) => i.rowId)).toEqual(['a']);
  });
});

describe('FinanceClient: the queue', () => {
  it('forward: decide a receipt, the figure comes from the server and the next receipt is selected', async () => {
    const user = userEvent.setup();
    actions.decideItem.mockResolvedValue({ ok: true, value: view([decided('a'), item({ rowId: 'b' })]) });
    render(<FinanceClient initial={view([item({ rowId: 'a' }), item({ rowId: 'b' })])} />);

    expect(screen.getByText('Noch 2 Belege offen.')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: '50 % Betrieb' }));
    await user.click(screen.getByRole('button', { name: 'Speichern und weiter' }));

    expect(actions.decideItem).toHaveBeenCalledWith(2025, {
      rowId: 'a',
      treatment: { allocations: [{ purpose: 'business', shareBp: 5000 }], formLineKey: 'euer.telecom', employmentLineKey: null },
      applyToVendor: undefined,
    });
    expect(await screen.findByText('Noch 1 Beleg offen.')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Rechnung b' })).toBeTruthy();
    expect(screen.getByText('20,00 €')).toBeTruthy();
  });

  it('refuses shares above the whole before anything is sent', async () => {
    const user = userEvent.setup();
    render(<FinanceClient initial={view([item({ rowId: 'a' })])} />);
    await user.type(screen.getByLabelText('Betrieb in %'), '70');
    await user.type(screen.getByLabelText('Studium in %'), '40');
    await user.click(screen.getByRole('button', { name: 'Speichern und weiter' }));
    expect(screen.getByRole('alert').textContent).toContain('mehr als 100 %');
    expect(actions.decideItem).not.toHaveBeenCalled();
  });

  it('asks for the annex line when a study share is entered', async () => {
    const user = userEvent.setup();
    render(<FinanceClient initial={view([item({ rowId: 'a' })])} />);
    await user.click(screen.getByRole('button', { name: '50 % Betrieb, 30 % Studium' }));
    await user.click(screen.getByRole('button', { name: 'Speichern und weiter' }));
    expect(screen.getByRole('alert').textContent).toContain('Anlage N');
    await user.selectOptions(screen.getByLabelText('Zeile der Anlage N für Studium oder Anstellung'), 'employment.study_costs');
    actions.decideItem.mockResolvedValue({ ok: true, value: view([decided('a')]) });
    await user.click(screen.getByRole('button', { name: 'Speichern und weiter' }));
    expect(actions.decideItem.mock.calls[0][1].treatment).toEqual({
      allocations: [{ purpose: 'business', shareBp: 5000 }, { purpose: 'study', shareBp: 3000 }],
      formLineKey: 'euer.telecom',
      employmentLineKey: 'employment.study_costs',
    });
  });

  it('"Privat" is a decision: sent as a fully private item without a line', async () => {
    const user = userEvent.setup();
    actions.decideItem.mockResolvedValue({ ok: true, value: view([]) });
    render(<FinanceClient initial={view([item({ rowId: 'a' })])} />);
    await user.click(screen.getByRole('button', { name: 'Privat' }));
    await user.click(screen.getByRole('button', { name: 'Speichern und weiter' }));
    expect(actions.decideItem.mock.calls[0][1].treatment).toEqual({
      allocations: [{ purpose: 'private', shareBp: 10000 }],
      formLineKey: null,
      employmentLineKey: null,
    });
    expect(await screen.findByText('Keine offenen Prüfungen für 2025.')).toBeTruthy();
  });

  it('applies a decision to the whole vendor with an optional start date', async () => {
    const user = userEvent.setup();
    actions.decideItem.mockResolvedValue({ ok: true, value: view([decided('a')]) });
    render(<FinanceClient initial={view([item({ rowId: 'a' })])} />);
    await user.click(screen.getByRole('button', { name: '100 % Betrieb' }));
    await user.click(screen.getByRole('checkbox'));
    await user.type(screen.getByLabelText('Gilt ab (leer: von Anfang an)'), '2025-07-01');
    await user.click(screen.getByRole('button', { name: 'Speichern und weiter' }));
    expect(actions.decideItem.mock.calls[0][1].applyToVendor).toEqual({ vendor: 'Netzwerk Nord GmbH', effectiveFrom: '2025-07-01' });
  });

  it('a failed save says so and keeps the receipt and the entries', async () => {
    const user = userEvent.setup();
    actions.decideItem.mockResolvedValue({ ok: false, error: 'forbidden' });
    render(<FinanceClient initial={view([item({ rowId: 'a' })])} />);
    await user.click(screen.getByRole('button', { name: '50 % Betrieb' }));
    await user.click(screen.getByRole('button', { name: 'Speichern und weiter' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Berechtigung');
    expect(screen.getByText('Noch 1 Beleg offen.')).toBeTruthy();
    expect((screen.getByLabelText('Betrieb in %') as HTMLInputElement).value).toBe('50');
  });

  it('a request that never reaches the server is reported, not swallowed', async () => {
    const user = userEvent.setup();
    actions.decideItem.mockRejectedValue(new Error('network'));
    render(<FinanceClient initial={view([item({ rowId: 'a' })])} />);
    await user.click(screen.getByRole('button', { name: '100 % Betrieb' }));
    await user.click(screen.getByRole('button', { name: 'Speichern und weiter' }));
    expect((await screen.findByRole('alert')).textContent).toContain('nicht geklappt');
  });

  it('an incomplete meal is sent to the register instead of being decided here', () => {
    render(
      <FinanceClient
        initial={view([
          item({ rowId: 'm', isMeal: true, formLineKey: 'euer.meals', checks: [{ itemId: 'm', kind: 'meal_incomplete', blocking: true }] }),
        ])}
      />,
    );
    expect(screen.getByRole('link', { name: 'Im Bewirtungsverzeichnis ergänzen' }).getAttribute('href')).toBe('/app/meals');
    expect(screen.queryByRole('button', { name: 'Speichern und weiter' })).toBeNull();
  });
});

describe('FinanceClient: notices and statement', () => {
  it('says plainly when the section 19 question is open and when revenue is not recorded', () => {
    render(
      <FinanceClient
        initial={view([item({ rowId: 'a', checks: [{ itemId: 'a', kind: 'small_business_unanswered', blocking: true }] })], { smallBusiness: null })}
      />,
    );
    expect(screen.getByText(/Kleinunternehmerregelung \(§ 19 Umsatzsteuergesetz\) ist noch nicht beantwortet/)).toBeTruthy();
    expect(screen.getByText(/Einnahmen werden noch nicht erfasst/)).toBeTruthy();
  });

  it('shows the statement lines, opens the receipts behind one and lets a decision be removed', async () => {
    const user = userEvent.setup();
    actions.resetItem.mockResolvedValue({ ok: true, value: view([item({ rowId: 'a' })]) });
    render(<FinanceClient initial={view([decided('a')])} />);
    const lineButton = screen.getByRole('button', { name: /Zeile 43/ });
    expect(lineButton.textContent).toContain('20,00 €');
    await user.click(lineButton);
    const row = screen.getByText('Netzwerk Nord GmbH').closest('li') as HTMLElement;
    expect(row.textContent).toContain('50 % Betrieb');
    expect(row.textContent).toContain('von 39,99 €');
    await user.click(within(row).getByRole('button', { name: 'Ändern' }));
    await user.click(within(row).getByRole('button', { name: /Einzelentscheidung entfernen/ }));
    expect(actions.resetItem).toHaveBeenCalledWith(2025, 'a');
    expect(await screen.findByText('Netzwerk Nord GmbH: Einzelentscheidung entfernt.')).toBeTruthy();
  });

  it('changing the year navigates, so the server computes the other year', async () => {
    const user = userEvent.setup();
    render(<FinanceClient initial={view([])} />);
    await user.selectOptions(screen.getByLabelText('Jahr'), '2026');
    expect(push).toHaveBeenCalledWith('/app/finance?jahr=2026');
  });
});
