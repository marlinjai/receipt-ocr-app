// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { setupUser, type TestUser } from '../../../../test/user';
import { rulesForYear } from '@/lib/tax/rules';
import type { StatementItem, StatementView } from '@/lib/tax/service';
import { incomeTaxView } from '@/lib/tax/income-tax/__tests__/fixtures';

const actions = vi.hoisted(() => ({
  classifyCounterpartiesNow: vi.fn(),
  treatCounterparty: vi.fn(),
  acceptPaymentProposals: vi.fn(),
  confirmPaymentLink: vi.fn(),
  markPaymentTransfer: vi.fn(),
  saveLines: vi.fn(),
  removeLines: vi.fn(),
  decideLine: vi.fn(),
  saveIssuedInvoice: vi.fn(),
  removeIssuedInvoice: vi.fn(),
  recordStatusChange: vi.fn(),
  removeStatusChange: vi.fn(),
  setVatSettings: vi.fn(),
  setRevenueExpectation: vi.fn(),
  recordVatSettlement: vi.fn(),
  removeVatSettlement: vi.fn(),
  decideItem: vi.fn(),
  resetItem: vi.fn(),
  removeVendorRule: vi.fn(),
  setReverseCharge: vi.fn(),
  resetReverseCharge: vi.fn(),
  removeReverseChargeVendor: vi.fn(),
  saveAsset: vi.fn(),
  removeAsset: vi.fn(),
  disposeAsset: vi.fn(),
  removeAccount: vi.fn(),
  getStatement: vi.fn(),
}));
vi.mock('./actions', () => actions);
// The income tax tab's server actions: never the real ones (they reach the database).
vi.mock('./income-tax-actions', () => ({
  saveWage: vi.fn(),
  removeWage: vi.fn(),
  saveTaxReturnItem: vi.fn(),
  removeTaxReturnItem: vi.fn(),
  setChurchMonths: vi.fn(),
  setFederalState: vi.fn(),
}));
// The own names under Einstellungen: never the real actions (they reach the database).
const ownNameActions = vi.hoisted(() => ({ changeOwnNames: vi.fn(), getOwnNamesView: vi.fn() }));
vi.mock('./own-names-actions', () => ownNameActions);
const push = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }));

import FinanceClient, { openQueue } from './FinanceClient';

afterEach(() => {
  cleanup();
  // A `window.confirm` stub of a failed test must not answer the questions of the next one.
  vi.restoreAllMocks();
});


/**
 * Clicks a button once it takes clicks again. An action's notice shows as soon as its answer arrives, a
 * moment before the transition ends and the buttons are enabled; a person never meets that moment, a test
 * that clicks right after the notice can. Waiting for the button (not for a fixed time) is what a person does.
 */
async function clickWhenEnabled(user: TestUser, find: () => HTMLElement) {
  // Looked up on every try: while busy a button may carry another label, or be drawn anew.
  const button = await vi.waitFor(() => {
    const found = find() as HTMLButtonElement;
    expect(found.disabled).toBe(false);
    return found;
  });
  await user.click(button);
}
beforeEach(() => {
  for (const fn of Object.values(actions)) fn.mockReset();
  for (const fn of Object.values(ownNameActions)) fn.mockReset();
  push.mockReset();
  // Each test starts on the bare address; the page writes the open tab into it.
  window.history.replaceState(null, '', '/app/finance');
});

/** Opens a tab the way a person does: the group first, then the tab inside it. */
async function openTab(user: TestUser, group: string, tab: string | RegExp) {
  await user.click(screen.getByRole('tab', { name: new RegExp(`^${group}`) }));
  await user.click(within(screen.getByRole('tablist', { name: `Reiter in ${group}` })).getByRole('tab', { name: tab }));
}

function item(overrides: Partial<StatementItem> & { rowId: string }): StatementItem {
  return {
    itemId: overrides.rowId,
    lineId: null,
    lineDescription: null,
    lineGrossCents: null,
    lineNetCents: null,
    receiptGrossCents: 3999,
    receiptLines: [],
    paidOn: null,
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
    severalLowValueItems: false,
    hasDecision: false,
    decisionNote: null,
    vendorRuleId: null,
    isMeal: false,
    assetId: null,
    counted: false,
    parts: [],
    privateCents: 0,
    reverseCharge: null,
    reverseChargeOwn: null,
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
    rulesProvisional: rules.provisional ?? null,
    formSources: rules.formSources,
    formLines: [...rules.formLines],
    lines: counted.length
      ? [
          {
            key: 'euer.telecom',
            form: 'euer',
            line: 43,
            numbering: 'verified',
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
    assets: [],
    assetLimits: {
      lowValueNetLimitCents: 80000,
      poolMinExclusiveNetCents: 25000,
      poolMaxNetCents: 100000,
      poolYears: 5,
      decliningFrom: '2025-07-01',
      decliningTo: '2027-12-31',
      decliningMaxRateBp: 3000,
      decliningMaxMultiple: 3,
    },
    businessRevenueCents: 0,
    profitCents: null,
    revenue: { recorded: false, receivedCents: 0, turnoverCents: 0, outstandingCents: 0, invoices: [], overdue: [] },
    forecast: {
      year: 2025,
      monthsElapsed: 12,
      receivedCents: 0,
      outstandingCents: 0,
      lowCents: 0,
      highCents: 0,
      monthlyRateCents: 0,
      rateBasis: 'none',
      basisMonths: 0,
      thinBasis: false,
      currentYear: { state: 'not_reached' },
      nextYear: { state: 'not_reached' },
      previousYearWithinLimit: null,
    },
    limits: { previousYearLimitCents: 2_500_000, currentYearLimitCents: 10_000_000, currentYearLimit: 'at_once', nextYearLimitCents: 2_500_000, source: rules.smallBusinessLimits.source },
    expectedMonthlyRevenueCents: null,
    smallBusinessAtYearEnd: true,
    statusChanges: [],
    vat: { frequency: null, method: null, applies: false, year: null, undeductedInputVatCents: 0, reverseChargeYear: null, reverseChargePendingItems: 0, reverseChargeNonBusinessCents: 0, reverseChargeForeignCurrencyItems: 0, settlements: [] },
    payments: { accounts: [], yearCount: 0, linkedCount: 0, transferCount: 0, unclassified: [], treatments: [], appTreatments: [], classifierAvailable: true, open: [], estimateProposals: [], overridden: [], ruleTransfers: [], ruleTransferCents: 0, reconciliations: [], cancelled: [], receiptTargets: [], invoiceTargets: [], links: [] },
    vendorRules: [],
    reverseChargeVendors: [],
    initialized: true,
    incomeTax: incomeTaxView({ year: 2025 }),
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

describe('FinanceClient: rules of a year whose forms are not published', () => {
  const { rules: rules2027 } = rulesForYear(2027);
  const unnumbered = [
    {
      key: 'euer.telecom' as const,
      form: 'euer' as const,
      line: null,
      numbering: 'unverified' as const,
      label: 'Aufwendungen für Telekommunikation (z. B. Telefon, Internet)',
      kind: 'expense' as const,
      cents: 4_200,
      nonDeductibleCents: 0,
      itemIds: [],
      assetIds: [],
    },
  ];
  const view2027 = (rulesProvisional: StatementView['rulesProvisional']) =>
    view([], { year: 2027, rulesYear: 2027, rulesProvisional, formSources: rules2027.formSources, formLines: [...rules2027.formLines], lines: unnumbered });

  it('says the rules are provisional and from which year they are carried, and prints no line number', () => {
    render(<FinanceClient initial={view2027(rules2027.provisional ?? null)} />);
    expect(screen.getByText(/Die Regeln für 2027 sind vorläufig/).textContent).toMatch(/Gerechnet wird mit den Werten\s+von 2026/);
    expect(screen.queryByText(/Zeilennummern noch nicht mit dem amtlichen Vordruck/)).toBeNull();
    expect(screen.queryByText(/Zeile \d+/)).toBeNull();
  });

  it('control: the same unnumbered lines without the provisional mark show the note about line numbers', () => {
    render(<FinanceClient initial={view2027(null)} />);
    expect(screen.getByText(/Zeilennummern noch nicht mit dem amtlichen Vordruck/)).toBeTruthy();
    expect(screen.queryByText(/sind vorläufig/)).toBeNull();
  });

  it('says nothing of the kind for a year with its own published rules', () => {
    render(<FinanceClient initial={view([])} />);
    expect(screen.queryByText(/sind vorläufig/)).toBeNull();
  });
});

describe('FinanceClient: a credit note', () => {
  it('offers no split into positions for a credit note', () => {
    render(<FinanceClient initial={view([item({ rowId: 'cn', receiptGrossCents: -11_900 })])} />);
    expect(screen.queryByRole('button', { name: 'In Positionen aufteilen' })).toBeNull();
  });

  it('a credit note with an old split that no longer fits offers only to remove the split', () => {
    const stale = item({
      rowId: 'cn',
      receiptGrossCents: -11_900,
      counted: false,
      checks: [{ itemId: 'cn', kind: 'lines_do_not_sum', blocking: true }],
      receiptLines: [
        { id: 'l1', description: 'Teil A', grossCents: 9_000, netCents: null },
        { id: 'l2', description: 'Teil B', grossCents: 2_900, netCents: null },
      ],
    });
    render(<FinanceClient initial={view([stale])} />);
    expect(screen.getByRole('button', { name: 'Aufteilung aufheben' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Positionen speichern' })).toBeNull();
    expect(screen.getByText(/wird nicht in Positionen aufgeteilt/)).toBeTruthy();
  });

  it('control: an ordinary receipt offers it', () => {
    render(<FinanceClient initial={view([item({ rowId: 'r', receiptGrossCents: 11_900 })])} />);
    expect(screen.getByRole('button', { name: 'In Positionen aufteilen' })).toBeTruthy();
  });
});

describe('FinanceClient: the queue', () => {
  it('forward: decide a receipt, the figure comes from the server and the next receipt is selected', async () => {
    const user = setupUser();
    actions.decideItem.mockResolvedValue({ ok: true, value: view([decided('a'), item({ rowId: 'b' })]) });
    render(<FinanceClient initial={view([item({ rowId: 'a' }), item({ rowId: 'b' })])} />);

    expect(screen.getByText('Noch 2 Belege offen.')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: '50 % Betrieb' }));
    await user.click(screen.getByRole('button', { name: 'Speichern und weiter' }));

    expect(actions.decideItem).toHaveBeenCalledWith(2025, {
      rowId: 'a',
      treatment: { allocations: [{ purpose: 'business', shareBp: 5000 }], formLineKey: 'euer.telecom', employmentLineKey: null, severalLowValueItems: false },
      applyToVendor: undefined,
    });
    expect(await screen.findByText('Noch 1 Beleg offen.')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Rechnung b' })).toBeTruthy();
    expect(screen.getByText('20,00 €')).toBeTruthy();
  });

  it('refuses shares above the whole before anything is sent', async () => {
    const user = setupUser();
    render(<FinanceClient initial={view([item({ rowId: 'a' })])} />);
    await user.type(screen.getByLabelText('Betrieb in %'), '70');
    await user.type(screen.getByLabelText('Studium in %'), '40');
    await user.click(screen.getByRole('button', { name: 'Speichern und weiter' }));
    expect(screen.getByRole('alert').textContent).toContain('mehr als 100 %');
    expect(actions.decideItem).not.toHaveBeenCalled();
  });

  it('asks for the annex line when a study share is entered', async () => {
    const user = setupUser();
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
      severalLowValueItems: false,
    });
  });

  it('offers the further employment costs as an annex line of their own', async () => {
    const user = setupUser();
    render(<FinanceClient initial={view([item({ rowId: 'a' })])} />);
    await user.click(screen.getByRole('button', { name: '100 % Studium' }));
    const select = screen.getByLabelText('Zeile der Anlage N für Studium oder Anstellung') as HTMLSelectElement;
    const option = [...select.options].find((o) => o.value === 'employment.further_costs');
    expect(option).toBeDefined();
    expect(option?.textContent).toMatch(/Weitere Werbungskosten/);
  });

  it('"Privat" is a decision: sent as a fully private item without a line', async () => {
    const user = setupUser();
    actions.decideItem.mockResolvedValue({ ok: true, value: view([]) });
    render(<FinanceClient initial={view([item({ rowId: 'a' })])} />);
    await user.click(screen.getByRole('button', { name: 'Privat' }));
    await user.click(screen.getByRole('button', { name: 'Speichern und weiter' }));
    expect(actions.decideItem.mock.calls[0][1].treatment).toEqual({
      allocations: [{ purpose: 'private', shareBp: 10000 }],
      formLineKey: null,
      employmentLineKey: null,
      severalLowValueItems: false,
    });
    expect(await screen.findByText('Keine offenen Prüfungen für 2025.')).toBeTruthy();
  });

  it('applies a decision to the whole vendor with an optional start date', async () => {
    const user = setupUser();
    actions.decideItem.mockResolvedValue({ ok: true, value: view([decided('a')]) });
    render(<FinanceClient initial={view([item({ rowId: 'a' })])} />);
    await user.click(screen.getByRole('button', { name: '100 % Betrieb' }));
    await user.click(screen.getByRole('checkbox'));
    await user.type(screen.getByLabelText('Gilt ab (leer: von Anfang an)'), '2025-07-01');
    await user.click(screen.getByRole('button', { name: 'Speichern und weiter' }));
    expect(actions.decideItem.mock.calls[0][1].applyToVendor).toEqual({ vendor: 'Netzwerk Nord GmbH', effectiveFrom: '2025-07-01' });
  });

  it('a failed save says so and keeps the receipt and the entries', async () => {
    const user = setupUser();
    actions.decideItem.mockResolvedValue({ ok: false, error: 'forbidden' });
    render(<FinanceClient initial={view([item({ rowId: 'a' })])} />);
    await user.click(screen.getByRole('button', { name: '50 % Betrieb' }));
    await user.click(screen.getByRole('button', { name: 'Speichern und weiter' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Berechtigung');
    expect(screen.getByText('Noch 1 Beleg offen.')).toBeTruthy();
    expect((screen.getByLabelText('Betrieb in %') as HTMLInputElement).value).toBe('50');
  });

  it('a request that never reaches the server is reported, not swallowed', async () => {
    const user = setupUser();
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

describe('FinanceClient: overdue invoices in the open checks (decision D6)', () => {
  const overdueView = (items: StatementItem[]) =>
    view(items, {
      revenue: {
        recorded: true,
        receivedCents: 0,
        turnoverCents: 0,
        outstandingCents: 90_000,
        invoices: [],
        overdue: [{ invoiceId: 'inv-58', number: '58', issueDate: '2026-08-03', dueDate: '2026-08-17', openCents: 90_000, daysPastDue: 59 }],
      },
    });

  it('lists an overdue invoice with its due date and what is open, and counts it as an open check', () => {
    render(<FinanceClient initial={overdueView([item({ rowId: 'a' })])} />);
    const panel = screen.getByRole('region', { name: '1 Rechnung überfällig' });
    expect(within(panel).getByText('Rechnung 58 vom 03.08.2026')).toBeTruthy();
    expect(within(panel).getByText(/fällig 17\.08\.2026, 59 Tage überfällig, offen 900,00 €/)).toBeTruthy();
    expect(screen.getByRole('tab', { name: /Offen/ }).textContent).toBe('Offen, 2 offen');
    expect(screen.getByText(/1 Rechnung überfällig,|^1 Rechnung überfällig$/, { selector: 'dd' })).toBeTruthy();
    // The receipt queue is still there below it.
    expect(screen.getByText('Noch 1 Beleg offen.')).toBeTruthy();
  });

  it('counts several overdue invoices in the plural', () => {
    const base = overdueView([]);
    const second = { invoiceId: 'inv-59', number: '59', issueDate: '2026-08-10', dueDate: '2026-08-24', openCents: 10_000, daysPastDue: 52 };
    render(<FinanceClient initial={{ ...base, revenue: { ...base.revenue, overdue: [...base.revenue.overdue, second] } }} />);
    expect(screen.getByRole('region', { name: '2 Rechnungen überfällig' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: /Offen/ }).textContent).toBe('Offen, 2 offen');
    expect(screen.getByText('2 Rechnungen überfällig', { selector: 'dd' })).toBeTruthy();
  });

  it('shows the reminder instead of "nothing open" when no receipt waits, and leads to the invoices', async () => {
    const user = setupUser();
    render(<FinanceClient initial={overdueView([decided('a')])} />);
    expect(screen.queryByText(/Keine offenen Prüfungen/)).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Zu den Einnahmen' }));
    expect(screen.getByRole('tab', { name: /Einnahmen/ }).getAttribute('aria-selected')).toBe('true');
  });

  it('shows no reminder when nothing is overdue', async () => {
    const user = setupUser();
    render(<FinanceClient initial={view([decided('a')])} />);
    await openTab(user, 'Erledigen', /Offen/);
    expect(screen.queryByRole('region', { name: /überfällig/ })).toBeNull();
    expect(screen.getByText(/Keine offenen Prüfungen/)).toBeTruthy();
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
    expect(screen.getByText(/Es ist noch keine Rechnung erfasst/)).toBeTruthy();
  });

  it('shows the statement lines, opens the receipts behind one and lets a decision be removed', async () => {
    const user = setupUser();
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

  it('marks a receipt for section 13b, for itself or for its vendor from a day on, and takes its own statement back', async () => {
    const user = setupUser();
    const marked = { ...decided('a'), reverseCharge: { rateBp: 1900, origin: 'item' as const }, reverseChargeOwn: { rateBp: 1900 } };
    actions.setReverseCharge.mockResolvedValue({ ok: true, value: view([marked]) });
    actions.resetReverseCharge.mockResolvedValue({ ok: true, value: view([decided('a')]) });
    render(<FinanceClient initial={view([decided('a')])} />);
    await user.click(screen.getByRole('button', { name: /Zeile 43/ }));
    let row = screen.getByText('Netzwerk Nord GmbH').closest('li') as HTMLElement;
    await user.click(within(row).getByRole('button', { name: 'Ändern' }));
    expect(within(row).queryByRole('button', { name: 'Angabe am Beleg entfernen' })).toBeNull();
    await user.click(within(row).getByRole('button', { name: '19 %' }));
    await user.click(within(row).getByRole('button', { name: '§ 13b speichern' }));
    expect(actions.setReverseCharge).toHaveBeenCalledWith(2025, { rowId: 'a', rateBp: 1900 });
    expect(await screen.findByText('Netzwerk Nord GmbH: § 13b gespeichert.')).toBeTruthy();

    row = screen.getByRole('button', { name: '§ 13b speichern' }).closest('li') as HTMLElement;
    expect(within(row).getByText(/Derzeit: 19 % \(an diesem Beleg\)/)).toBeTruthy();
    await clickWhenEnabled(user, () => within(row).getByRole('button', { name: '7 %' }));
    await user.click(within(row).getByLabelText(/Angabe für alle Belege von Netzwerk Nord GmbH/));
    await user.type(within(row).getByLabelText(/gilt ab/), '2025-01-01');
    await user.click(within(row).getByRole('button', { name: '§ 13b speichern' }));
    expect(actions.setReverseCharge).toHaveBeenLastCalledWith(2025, { rowId: 'a', rateBp: 700, applyToVendor: { vendor: 'Netzwerk Nord GmbH', effectiveFrom: '2025-01-01' } });

    await clickWhenEnabled(user, () => within(row).getByRole('button', { name: 'Angabe am Beleg entfernen' }));
    expect(actions.resetReverseCharge).toHaveBeenCalledWith(2025, 'a');
    expect(await screen.findByText('Netzwerk Nord GmbH: § 13b-Angabe entfernt.')).toBeTruthy();
  });

  it('the section 13b form says which services it is for, and warns about another currency', async () => {
    const user = setupUser();
    render(<FinanceClient initial={view([{ ...decided('a'), currency: 'USD', gross: 42 }])} />);
    await user.click(screen.getByRole('button', { name: /Zeile 43/ }));
    const row = screen.getByText('Netzwerk Nord GmbH').closest('li') as HTMLElement;
    await user.click(within(row).getByRole('button', { name: 'Ändern' }));
    expect(within(row).getByText(/Nicht für Hotel, Bewirtung oder Fahrten/)).toBeTruthy();
    expect(within(row).getByText(/Dieser Beleg lautet auf USD/)).toBeTruthy();
  });

  it('a failed section 13b save says why and keeps the view', async () => {
    const user = setupUser();
    actions.setReverseCharge.mockResolvedValue({ ok: false, error: 'invalid_input', detail: 'invalid_reverse_charge_date' });
    render(<FinanceClient initial={view([decided('a')])} />);
    await user.click(screen.getByRole('button', { name: /Zeile 43/ }));
    const row = screen.getByText('Netzwerk Nord GmbH').closest('li') as HTMLElement;
    await user.click(within(row).getByRole('button', { name: 'Ändern' }));
    // Nothing chosen yet: saving the receipt's current state would change nothing.
    expect((within(row).getByRole('button', { name: '§ 13b speichern' }) as HTMLButtonElement).disabled).toBe(true);
    await user.click(within(row).getByRole('button', { name: '19 %' }));
    await user.click(within(row).getByLabelText(/Angabe für alle Belege von Netzwerk Nord GmbH/));
    await user.type(within(row).getByLabelText(/gilt ab/), '2025-04-01');
    await user.click(within(row).getByRole('button', { name: '§ 13b speichern' }));
    expect(actions.setReverseCharge).toHaveBeenCalledWith(2025, { rowId: 'a', rateBp: 1900, applyToVendor: { vendor: 'Netzwerk Nord GmbH', effectiveFrom: '2025-04-01' } });
    expect((await screen.findAllByText(/Das Datum „gilt ab“ ist ungültig/)).length).toBeGreaterThan(0);
    expect(screen.queryByText(/§ 13b gespeichert/)).toBeNull();
  });

  it('a decided receipt can be split from the statement, and a split can be changed or undone there', async () => {
    const user = setupUser();
    actions.saveLines.mockResolvedValue({ ok: true, value: view([decided('a')]) });
    render(<FinanceClient initial={view([{ ...decided('a'), receiptGrossCents: 3999 }])} />);
    await user.click(screen.getByRole('button', { name: /Zeile 43/ }));
    const row = screen.getByText('Netzwerk Nord GmbH').closest('li') as HTMLElement;
    await user.click(within(row).getByRole('button', { name: 'Ändern' }));
    await user.click(within(row).getByRole('button', { name: 'In Positionen aufteilen' }));
    await user.type(within(row).getByLabelText('Position 1'), 'Anschluss');
    await user.type(within(row).getAllByLabelText('Betrag')[0], '30');
    await user.type(within(row).getByLabelText('Position 2'), 'Gerät');
    await user.type(within(row).getAllByLabelText('Betrag')[1], '9,99');
    await user.click(within(row).getByRole('button', { name: 'Positionen speichern' }));
    expect(actions.saveLines).toHaveBeenCalledWith(2025, 'a', [
      { description: 'Anschluss', grossCents: 3000, netCents: null },
      { description: 'Gerät', grossCents: 999, netCents: null },
    ]);
  });

  it('re-entry: a split that no longer adds up opens with its stored lines and their ids, and cannot be skipped', async () => {
    const user = setupUser();
    actions.saveLines.mockResolvedValue({ ok: true, value: view([decided('a')]) });
    const broken = item({
      rowId: 'a',
      receiptGrossCents: 4999,
      receiptLines: [
        { id: 'l-1', description: 'Anschluss', grossCents: 3000, netCents: null },
        { id: 'l-2', description: 'Gerät', grossCents: 999, netCents: null },
      ],
      checks: [{ itemId: 'a', kind: 'lines_do_not_sum', blocking: true }],
    });
    render(<FinanceClient initial={view([broken])} />);
    expect(screen.getByText(/nicht mehr seinen Betrag ergeben/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Abbrechen' })).toBeNull();
    expect((screen.getByLabelText('Position 2') as HTMLInputElement).value).toBe('Gerät');
    await user.clear(screen.getAllByLabelText('Betrag')[1]);
    await user.type(screen.getAllByLabelText('Betrag')[1], '19,99');
    await user.click(screen.getByRole('button', { name: 'Positionen speichern' }));
    expect(actions.saveLines).toHaveBeenCalledWith(2025, 'a', [
      { id: 'l-1', description: 'Anschluss', grossCents: 3000, netCents: null },
      { id: 'l-2', description: 'Gerät', grossCents: 1999, netCents: null },
    ]);
  });

  it('an item the ten-day rule moved shows the day it was really paid and the year it counts in', async () => {
    const user = setupUser();
    render(<FinanceClient initial={view([{ ...decided('a'), date: '2025-01-01', paidOn: '2024-12-29' }])} />);
    await user.click(screen.getByRole('button', { name: /Zeile 43/ }));
    const row = screen.getByText('Netzwerk Nord GmbH').closest('li') as HTMLElement;
    expect(row.textContent).toContain('gezahlt 29.12.2024, zählt für 2025 (Jahreswechsel)');
  });

  it('"Jetzt einordnen" says what the app did, and a run that decided nothing because the model failed is shown as an error', async () => {
    const user = setupUser();
    const payments = { ...view([]).payments, yearCount: 4 };
    const initial = view([], { payments });
    actions.classifyCounterpartiesNow
      .mockResolvedValueOnce({ ok: true, value: { view: initial, summary: 'Die App hat 3 Gegenseiten eingeordnet, alle sicher.', failed: false } })
      .mockResolvedValueOnce({ ok: true, value: { view: initial, summary: 'Die Gegenseiten konnten gerade nicht eingeordnet werden; beim nächsten Prüfen wird es wieder versucht.', failed: true } });
    render(<FinanceClient initial={initial} />);
    await openTab(user, 'Erledigen', /Zahlungen klären/);
    await user.click(screen.getByRole('button', { name: 'Jetzt einordnen' }));
    expect(await screen.findByText('Die App hat 3 Gegenseiten eingeordnet, alle sicher.')).toBeTruthy();
    expect(actions.classifyCounterpartiesNow).toHaveBeenCalledWith(2025);
    await clickWhenEnabled(user, () => screen.getByRole('button', { name: 'Jetzt einordnen' }));
    expect((await screen.findByRole('alert')).textContent).toContain('konnten gerade nicht eingeordnet werden');
  });

  it('shows no turn-of-the-year tab: the ten-day rule decides by itself', () => {
    render(<FinanceClient initial={view([])} />);
    expect(screen.queryByRole('tab', { name: /Jahreswechsel/ })).toBeNull();
  });

  it('changing the year navigates, so the server computes the other year', async () => {
    const user = setupUser();
    render(<FinanceClient initial={view([])} />);
    await user.selectOptions(screen.getByLabelText('Jahr'), '2026');
    // The tab on screen stays: the address of the other year names it.
    expect(push).toHaveBeenCalledWith('/app/finance?jahr=2026&reiter=euer');
  });
});

describe('FinanceClient: assets', () => {
  const overLimit = () =>
    item({
      rowId: 'cam',
      label: 'Rechnung Kamera',
      vendor: 'Fotohaus Beispiel',
      category: 'Hardware & IT',
      amountCents: 150000,
      gross: 1500,
      formLineKey: 'euer.low_value_assets',
      allocations: [{ purpose: 'business', shareBp: 10000 }],
      allocationOrigin: 'legacy_columns',
      checks: [{ itemId: 'cam', kind: 'needs_asset', blocking: true }],
    });

  const cameraAsset = {
    id: 'asset-1',
    label: 'Kamera',
    kind: 'movable' as const,
    acquisitionDate: '2025-03-14',
    method: 'linear' as const,
    usefulLifeMonths: 60,
    decliningRateBp: null,
    businessShareBp: 10000,
    annexShareBp: 0,
    annexLineKey: null,
    reminderCents: 0,
    opening: null,
    disposal: null,
    costCents: 150000,
    netCostCents: 126050,
    itemIds: ['cam'],
    counted: true,
    checks: [],
    row: { year: 2025, bookValueStartCents: 0, additionCents: 150000, depreciationCents: 25000, disposalBookValueCents: 0, bookValueEndCents: 125000 },
    parts: [{ lineKey: 'euer.depreciation_movable' as const, cents: 25000 }],
    schedule: [{ year: 2025, bookValueStartCents: 0, additionCents: 150000, depreciationCents: 25000, disposalBookValueCents: 0, bookValueEndCents: 125000 }],
  };

  it('forward: a receipt above the limit leads into a new asset with the receipt already chosen', async () => {
    const user = setupUser();
    actions.saveAsset = vi.fn().mockResolvedValue({
      ok: true,
      value: view([item({ ...overLimit(), counted: true, checks: [], assetId: 'asset-1' })], { assets: [cameraAsset] }),
    });
    render(<FinanceClient initial={view([overLimit()])} />);
    expect(screen.getByText(/kostet aber mehr als 800,00 € netto/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Als Anlage führen' }));

    expect((screen.getByLabelText('Bezeichnung') as HTMLInputElement).value).toBe('Rechnung Kamera');
    expect((screen.getByLabelText('Anschaffungsdatum (Lieferung)') as HTMLInputElement).value).toBe('2025-03-14');
    expect(screen.getByText(/Anschaffungskosten aus 1 Beleg: 1.500,00 €/)).toBeTruthy();
    await user.clear(screen.getByLabelText('Bezeichnung'));
    await user.type(screen.getByLabelText('Bezeichnung'), 'Kamera');
    await user.type(screen.getByLabelText('Nutzungsdauer in Jahren'), '5');
    await user.click(screen.getByRole('button', { name: 'Anlage anlegen' }));

    expect(actions.saveAsset).toHaveBeenCalledWith(2025, null, {
      label: 'Kamera',
      kind: 'movable',
      acquisitionDate: '2025-03-14',
      method: 'linear',
      usefulLifeMonths: 60,
      decliningRateBp: null,
      businessShareBp: 10000,
      annexShareBp: 0,
      annexLineKey: null,
      reminderCents: 0,
      opening: null,
      itemIds: ['cam'],
    });
    expect(await screen.findByText('Kamera: Anlage gespeichert.')).toBeTruthy();
    expect(screen.getByText('1.250,00 €')).toBeTruthy();
  });

  it('refuses a new asset without a receipt or with a life of a year before anything is sent', async () => {
    const user = setupUser();
    actions.saveAsset = vi.fn();
    render(<FinanceClient initial={view([decided('a')])} />);
    await user.click(screen.getByRole('tab', { name: /Anlagen/ }));
    await user.click(screen.getByRole('button', { name: 'Neue Anlage' }));
    await user.type(screen.getByLabelText('Bezeichnung'), 'Kamera');
    await user.type(screen.getByLabelText('Anschaffungsdatum (Lieferung)'), '2025-03-14');
    await user.click(screen.getByRole('button', { name: 'Anlage anlegen' }));
    expect(screen.getByRole('alert').textContent).toContain('mindestens einen Beleg');
    await user.click(screen.getByRole('checkbox', { name: /Netzwerk Nord GmbH/ }));
    await user.type(screen.getByLabelText('Nutzungsdauer in Jahren'), '1');
    await user.click(screen.getByRole('button', { name: 'Anlage anlegen' }));
    expect(screen.getByRole('alert').textContent).toContain('mehr als einem Jahr');
    expect(actions.saveAsset).not.toHaveBeenCalled();
  });

  it('an asset with a study share asks for its employment annex line and sends both shares', async () => {
    const user = setupUser();
    actions.saveAsset = vi.fn().mockResolvedValue({ ok: true, value: view([]) });
    render(<FinanceClient initial={view([decided('a')])} />);
    await user.click(screen.getByRole('tab', { name: /Anlagen/ }));
    await user.click(screen.getByRole('button', { name: 'Neue Anlage' }));
    await user.type(screen.getByLabelText('Bezeichnung'), 'Laptop');
    await user.type(screen.getByLabelText('Anschaffungsdatum (Lieferung)'), '2025-03-14');
    await user.click(screen.getByRole('checkbox', { name: /Netzwerk Nord GmbH/ }));
    await user.type(screen.getByLabelText('Nutzungsdauer in Jahren'), '3');
    const business = screen.getByLabelText('Betrieblicher Anteil in %');
    await user.clear(business);
    await user.type(business, '70');
    expect(screen.queryByLabelText('Zeile der Anlage N für diesen Anteil')).toBeNull();
    await user.type(screen.getByLabelText('Anteil Studium oder Anstellung in % (Anlage N)'), '40');
    await user.click(screen.getByRole('button', { name: 'Anlage anlegen' }));
    expect(screen.getByRole('alert').textContent).toContain('mehr als 100 %');
    await user.clear(business);
    await user.type(business, '60');
    expect((screen.getByLabelText('Zeile der Anlage N für diesen Anteil') as HTMLSelectElement).value).toBe('employment.study_costs');
    // Declining depreciation is refused with an annex share: work equipment is written off in equal amounts.
    await user.selectOptions(screen.getByLabelText('Abschreibung'), 'declining');
    await user.click(screen.getByRole('button', { name: 'Anlage anlegen' }));
    expect(screen.getByRole('alert').textContent).toContain('linear abgeschrieben');
    expect(actions.saveAsset).not.toHaveBeenCalled();
    await user.selectOptions(screen.getByLabelText('Abschreibung'), 'linear');
    await user.click(screen.getByRole('button', { name: 'Anlage anlegen' }));
    expect(actions.saveAsset.mock.calls[0][2]).toMatchObject({ businessShareBp: 6000, annexShareBp: 4000, annexLineKey: 'employment.study_costs' });

  });

  it('an asset kept only for its study share has a business share of 0', async () => {
    const user = setupUser();
    actions.saveAsset = vi.fn().mockResolvedValue({ ok: true, value: view([]) });
    render(<FinanceClient initial={view([decided('a')])} />);
    await user.click(screen.getByRole('tab', { name: /Anlagen/ }));
    await user.click(screen.getByRole('button', { name: 'Neue Anlage' }));
    await user.type(screen.getByLabelText('Bezeichnung'), 'Laptop');
    await user.type(screen.getByLabelText('Anschaffungsdatum (Lieferung)'), '2025-03-14');
    await user.click(screen.getByRole('checkbox', { name: /Netzwerk Nord GmbH/ }));
    await user.type(screen.getByLabelText('Nutzungsdauer in Jahren'), '3');
    const business = screen.getByLabelText('Betrieblicher Anteil in %');
    await user.clear(business);
    await user.type(business, '0');
    await user.click(screen.getByRole('button', { name: 'Anlage anlegen' }));
    expect(screen.getByRole('alert').textContent).toContain('zwischen 1 und 100 %');
    await user.type(screen.getByLabelText('Anteil Studium oder Anstellung in % (Anlage N)'), '100');
    await user.click(screen.getByRole('button', { name: 'Anlage anlegen' }));
    expect(actions.saveAsset.mock.calls[0][2]).toMatchObject({ businessShareBp: 0, annexShareBp: 10000, annexLineKey: 'employment.study_costs' });
  });

  it('an asset from earlier years is entered with its book value and no receipts', async () => {
    const user = setupUser();
    actions.saveAsset = vi.fn().mockResolvedValue({ ok: true, value: view([]) });
    render(<FinanceClient initial={view([])} />);
    await user.click(screen.getByRole('tab', { name: /Anlagen/ }));
    await user.click(screen.getByRole('button', { name: 'Neue Anlage' }));
    await user.type(screen.getByLabelText('Bezeichnung'), 'Schreibtisch');
    await user.click(screen.getByRole('button', { name: 'Aus früheren Jahren übernommen' }));
    await user.type(screen.getByLabelText('Buchwert in €'), '1,00');
    await user.click(screen.getByRole('checkbox', { name: 'Erinnerungswert von 1 € stehen lassen' }));
    await user.click(screen.getByRole('button', { name: 'Anlage anlegen' }));
    expect(actions.saveAsset.mock.calls[0][2]).toMatchObject({
      label: 'Schreibtisch',
      acquisitionDate: null,
      method: 'linear',
      reminderCents: 100,
      opening: { year: 2025, bookValueCents: 100, remainingMonths: 0 },
      itemIds: [],
    });
  });

  it('shows the register row, the reason an asset is not computed, and records a sale', async () => {
    const user = setupUser();
    actions.disposeAsset = vi.fn().mockResolvedValue({ ok: true, value: view([], { assets: [cameraAsset] }) });
    const blocked = { ...cameraAsset, id: 'asset-2', label: 'Objektiv', counted: false, row: null, parts: [], schedule: [], checks: [{ assetId: 'asset-2', kind: 'asset_low_value_over_limit' as const, blocking: true as const }] };
    render(<FinanceClient initial={view([], { assets: [cameraAsset, blocked] })} />);
    await user.click(screen.getByRole('tab', { name: /Anlagen/ }));
    const row = screen.getByRole('heading', { name: 'Kamera' }).closest('li') as HTMLElement;
    expect(row.textContent).toContain('Abschreibung 2025');
    expect(row.textContent).toContain('250,00 €');
    expect(screen.getByText(/Diese Anlage wird noch nicht gerechnet: Über der Grenze/)).toBeTruthy();

    await user.click(within(row).getByRole('button', { name: 'Abgang erfassen' }));
    await user.type(within(row).getByLabelText('Datum des Abgangs'), '2026-07-01');
    await user.type(within(row).getByLabelText('Verkaufserlös in €'), '900,00');
    await user.click(within(row).getByRole('button', { name: 'Abgang speichern' }));
    expect(actions.disposeAsset).toHaveBeenCalledWith(2025, 'asset-1', { date: '2026-07-01', kind: 'sold', proceedsCents: 90000 });
  });

  it('several small items on one receipt can stay on the low-value line by an explicit statement', async () => {
    const user = setupUser();
    actions.decideItem.mockResolvedValue({ ok: true, value: view([]) });
    render(<FinanceClient initial={view([overLimit()])} />);
    await user.click(screen.getByRole('checkbox', { name: /mehrere Wirtschaftsgüter, jedes für sich unter der Grenze/ }));
    await user.click(screen.getByRole('button', { name: 'Speichern und weiter' }));
    expect(actions.decideItem.mock.calls[0][1].treatment).toEqual({
      allocations: [{ purpose: 'business', shareBp: 10000 }],
      formLineKey: 'euer.low_value_assets',
      employmentLineKey: null,
      severalLowValueItems: true,
    });
  });
  it('accepting the proposals sends the pairs the dialog counted, says exactly what was linked and what was left out, and shows a failure', async () => {
    const user = setupUser();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const proposal = { paymentId: 'p-1', rowId: 'r-1', receiptLabel: 'Editor Beispiel', receiptDay: '2025-03-02', estimateCents: 2_000, bookingDay: '2025-03-03', paidCents: 2_075, counterparty: 'Editor Beispiel', accountLabel: 'Später zahlen', unambiguous: true, severalReceipts: false };
    const second = { ...proposal, paymentId: 'p-2', rowId: 'r-2', receiptLabel: 'Hosting Beispiel' };
    const payments = view([]).payments;
    const withProposals = view([], { payments: { ...payments, estimateProposals: [proposal, second] } });
    actions.acceptPaymentProposals
      .mockResolvedValueOnce({ ok: false, error: 'failed' })
      .mockResolvedValueOnce({ ok: true, value: { view: view([]), linked: 1, skipped: 1 } });
    render(<FinanceClient initial={withProposals} />);
    await openTab(user, 'Erledigen', /Zahlungen klären/);

    await user.click(screen.getByRole('button', { name: 'Alle 2 eindeutigen Vorschläge übernehmen' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Das hat nicht geklappt');
    // The proposals are still there to try again.
    await clickWhenEnabled(user, () => screen.getByRole('button', { name: 'Alle 2 eindeutigen Vorschläge übernehmen' }));
    expect(await screen.findByText('1 Zahlung dem Beleg zugeordnet; 1 Vorschlag galt nicht mehr und blieb unberührt. Die Liste zeigt den aktuellen Stand.')).toBeTruthy();
    expect(actions.acceptPaymentProposals).toHaveBeenLastCalledWith(2025, [{ paymentId: 'p-1', rowId: 'r-1' }, { paymentId: 'p-2', rowId: 'r-2' }], true);
    expect(screen.queryByRole('region', { name: 'Vorschläge für geschätzte Belege' })).toBeNull();
  });

  it('"Konto entfernen" refused because the account is no longer empty shows why and what the account holds now', async () => {
    const user = setupUser();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const payments = view([]).payments;
    const empty = { id: 'acc-empty', label: 'Altes Konto', kind: 'bank' as const, isPrivate: false, paymentCount: 0, completeThrough: null, batches: [] };
    const filled = { ...empty, paymentCount: 1, completeThrough: '2025-03-02', batches: [{ id: 'b-1', format: 'n26_csv' as const, service: null, newCount: 1, paymentCount: 1, firstDay: '2025-03-02', lastDay: '2025-03-02', importedAt: '2025-03-03T08:00:00.000Z' }] };
    actions.removeAccount.mockResolvedValue({ ok: false, error: 'invalid_input', detail: 'account_not_empty' });
    actions.getStatement.mockResolvedValue({ ok: true, value: view([], { payments: { ...payments, accounts: [filled] } }) });
    render(<FinanceClient initial={view([], { payments: { ...payments, accounts: [empty] } })} />);
    await openTab(user, 'Einstellungen', 'Konten');
    await user.click(screen.getByRole('button', { name: 'Konto entfernen' }));
    expect((await screen.findByRole('alert')).textContent).toContain('lässt sich nicht entfernen');
    expect(actions.getStatement).toHaveBeenCalledWith(2025);
    // The account now holds an import: the button is gone.
    await vi.waitFor(() => expect(screen.queryByRole('button', { name: 'Konto entfernen' })).toBeNull());
  });

  it('a receipt that already carries a payment is not linked a second time without a question; a no links nothing, a yes sends it confirmed', async () => {
    const user = setupUser();
    const payments = view([]).payments;
    const openPayment = { id: 'p-1', bookingDay: '2025-03-15', amountCents: -4_000, freeCents: 4_000, counterparty: 'Werkzeug Beispiel GmbH', reference: '', kind: 'spend' as const, accountLabel: 'Geschäftskonto', check: 'payment_without_document' as const, proposals: [], namesService: false };
    const receiptTargets = [{ id: 'r-1', label: 'Einkauf Laden', day: '2025-03-11', amountCents: 1_999, linkedCents: 1_999 }];
    const initial = view([], { payments: { ...payments, open: [openPayment], receiptTargets } });
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true);
    actions.confirmPaymentLink.mockImplementation(async (_year: number, input: { confirmed?: boolean }) =>
      input.confirmed ? { ok: true, value: { view: view([]), moved: false } } : { ok: false, error: 'invalid_input', detail: 'receipt_already_paid:1999:1999' },
    );
    render(<FinanceClient initial={initial} />);
    await openTab(user, 'Erledigen', /Zahlungen klären/);
    await user.click(screen.getByRole('button', { name: 'Von Hand zuordnen' }));
    await user.selectOptions(screen.getByLabelText('Beleg von Hand wählen'), 'r:r-1');

    await user.click(screen.getByRole('button', { name: 'Zuordnen' }));
    await vi.waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
    expect(confirm.mock.calls[0][0]).toContain('Dieser Beleg hat schon eine Zahlung über 19,99 € (Belegbetrag 19,99 €)');
    // No: one request went out, unconfirmed, and the payment is still open.
    expect(actions.confirmPaymentLink).toHaveBeenCalledTimes(1);
    expect(await screen.findByText('Nichts zugeordnet: der Beleg hat schon eine Zahlung.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Zuordnen' })).toBeTruthy();

    await clickWhenEnabled(user, () => screen.getByRole('button', { name: 'Zuordnen' }));
    await vi.waitFor(() => expect(actions.confirmPaymentLink).toHaveBeenCalledTimes(3));
    expect(actions.confirmPaymentLink.mock.calls[2][1]).toEqual({ paymentId: 'p-1', rowId: 'r-1', confirmed: true });
    expect(await screen.findByText('Zahlung zugeordnet.')).toBeTruthy();
  });

  it('money back a little above what the receipt still costs is asked about once and sent confirmed on a yes', async () => {
    const user = setupUser();
    const payments = view([]).payments;
    const refund = { id: 'p-2', bookingDay: '2025-03-20', amountCents: 2_050, freeCents: 2_050, counterparty: 'Laden Beispiel', reference: '', kind: 'refund' as const, accountLabel: 'Geschäftskonto', check: 'refund_without_receipt' as const, proposals: [], namesService: false };
    const receiptTargets = [{ id: 'r-1', label: 'Einkauf Laden', day: '2025-03-11', amountCents: 1_999, linkedCents: 1_999 }];
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(true);
    actions.confirmPaymentLink.mockImplementation(async (_year: number, input: { confirmed?: boolean }) =>
      input.confirmed ? { ok: true, value: { view: view([]), moved: false } } : { ok: false, error: 'invalid_input', detail: 'refund_exceeds_receipt:1999' },
    );
    render(<FinanceClient initial={view([], { payments: { ...payments, open: [refund], receiptTargets } })} />);
    await openTab(user, 'Erledigen', /Zahlungen klären/);
    await user.click(screen.getByRole('button', { name: 'Von Hand zuordnen' }));
    await user.selectOptions(screen.getByLabelText('Beleg von Hand wählen'), 'r:r-1');
    await user.click(screen.getByRole('button', { name: 'Zuordnen' }));
    await vi.waitFor(() => expect(actions.confirmPaymentLink).toHaveBeenCalledTimes(2));
    expect(confirm.mock.calls[0][0]).toContain('Diese Erstattung ist größer als das, was der Beleg noch kostet (19,99 €)');
    expect(actions.confirmPaymentLink.mock.calls[1][1]).toEqual({ paymentId: 'p-2', rowId: 'r-1', confirmed: true });
  });

  it('says so when a link was taken over from the bank-side debit of the same money, and re-labels a transfer through its action', async () => {
    const user = setupUser();
    const payments = view([]).payments;
    const openPayment = { id: 'p-1', bookingDay: '2025-03-11', amountCents: -1_999, freeCents: 1_999, counterparty: 'Laden Beispiel', reference: '', kind: 'spend' as const, accountLabel: 'Geldbörse', check: 'payment_without_document' as const, proposals: [{ target: 'receipt' as const, targetId: 'r-1', label: 'Einkauf Laden', strength: 'amount_and_date' as const }], namesService: false };
    const ruleTransfers = [{ id: 't-1', bookingDay: '2025-03-12', amountCents: -1_999, counterparty: 'Geldbörse Beispiel', reference: '', accountLabel: 'Geschäftskonto', hasTwin: true, awaitingList: false, linkedTo: [] }];
    const initial = view([], { payments: { ...payments, open: [openPayment], ruleTransfers, ruleTransferCents: 1_999 } });
    actions.confirmPaymentLink.mockResolvedValue({ ok: true, value: { view: initial, moved: true } });
    actions.markPaymentTransfer.mockResolvedValue({ ok: true, value: view([]) });
    render(<FinanceClient initial={initial} />);
    await openTab(user, 'Erledigen', /Zahlungen klären/);
    await user.click(screen.getByRole('button', { name: /Zuordnen: Einkauf Laden/ }));
    expect(await screen.findByText(/wurde hierher verschoben: es ist dasselbe Geld/)).toBeTruthy();

    // What the funding rule treats as a transfer is in the list under Auswerten.
    await openTab(user, 'Auswerten', 'Zahlungen');

    await clickWhenEnabled(user, () => screen.getByRole('button', { name: 'Kein Übertrag, eine eigene Zahlung' }));
    await vi.waitFor(() => expect(actions.markPaymentTransfer).toHaveBeenCalledWith(2025, 't-1', false));
    expect(await screen.findByText(/Als eigene Zahlung vermerkt/)).toBeTruthy();
  });
});

describe('FinanceClient: the income tax estimate', () => {
  it('shows the estimate as a headline tile and opens its tab', async () => {
    render(<FinanceClient initial={view([], { incomeTax: incomeTaxView({ year: 2025, profitCents: 300_000 }) })} />);
    const tile = screen.getByText('Einkommensteuer 2025 (Schätzung)').parentElement!;
    expect(within(tile).getByText(/nur Gewerbe, ohne Lohn/)).toBeTruthy();
    await openTab(setupUser(), 'Steuer', 'Einkommensteuer');
    expect(screen.getByRole('heading', { name: /Einkommensteuer 2025: Schätzung \(nur Gewerbe\)/ })).toBeTruthy();
  });

  it('says "offen" when there is nothing to estimate', () => {
    render(<FinanceClient initial={view([])} />);
    const tile = screen.getByText('Einkommensteuer 2025 (Schätzung)').parentElement!;
    expect(within(tile).getByText('offen')).toBeTruthy();
  });
});

describe('FinanceClient: sharing private payments with another company', () => {
  it('says so when the sharing section could not be read, instead of leaving it out', () => {
    render(<FinanceClient initial={view([])} initialTab="accounts" sharingFailed />);
    expect(screen.getByRole('alert').textContent).toContain('Die Weitergabe privater Zahlungen konnte nicht geladen werden');
  });

  it('shows nothing of it when the person has no other company and nothing is shared', () => {
    render(<FinanceClient initial={view([])} initialTab="accounts" sharing={{ outgoing: [], incoming: [], targets: [], canWrite: true }} />);
    expect(screen.queryByText('Private Zahlungen in einer anderen Firma')).toBeNull();
  });
});

describe('FinanceClient: four groups (plan 2026-10-25-finance-groups)', () => {
  const selected = (list: string) =>
    within(screen.getByRole('tablist', { name: list }))
      .getAllByRole('tab')
      .filter((t) => t.getAttribute('aria-selected') === 'true')
      .map((t) => t.textContent);
  const groups = () => within(screen.getByRole('tablist', { name: 'Bereiche der Finanzübersicht' })).getAllByRole('tab');
  const unanswered = { key: 'vermieter beispiel', label: 'Vermieter Beispiel', count: 2, outCents: 130_000, inCents: 0, proposal: null };
  const openPayment = { id: 'p-1', bookingDay: '2025-03-15', amountCents: -4_000, freeCents: 4_000, counterparty: 'Werkzeug Beispiel GmbH', reference: '', kind: 'spend' as const, accountLabel: 'Geschäftskonto', check: 'payment_without_document' as const, proposals: [], namesService: false };
  const busy = () => {
    const base = view([item({ rowId: 'a' }), item({ rowId: 'b' })]);
    return { ...base, payments: { ...base.payments, yearCount: 3, unclassified: [unanswered], open: [openPayment, { ...openPayment, id: 'p-2' }] } };
  };

  it('forward: four groups, each with its own tabs, and the count of Erledigen is all that waits', async () => {
    const user = setupUser();
    render(<FinanceClient initial={busy()} />);
    expect(groups().map((g) => g.textContent)).toEqual(['Erledigen, 5 offen', 'Auswerten', 'Steuer', 'Einstellungen']);
    // The tabs inside Erledigen carry their parts, which add up to the group: 2 receipts, 3 payment questions.
    expect(within(screen.getByRole('tablist', { name: 'Reiter in Erledigen' })).getAllByRole('tab').map((t) => t.textContent)).toEqual(['Offen, 2 offen', 'Zahlungen klären, 3 offen']);
    const tabsOf = async (group: string) => {
      await user.click(screen.getByRole('tab', { name: new RegExp(`^${group}`) }));
      return within(screen.getByRole('tablist', { name: `Reiter in ${group}` })).getAllByRole('tab').map((t) => t.textContent);
    };
    expect(await tabsOf('Auswerten')).toEqual(['EÜR', 'Einnahmen', 'Zahlungen', 'Anlagen']);
    expect(await tabsOf('Steuer')).toEqual(['Umsatzsteuer', 'Einkommensteuer']);
    expect(await tabsOf('Einstellungen')).toEqual(['Konten', 'Lieferanten', 'Eigene Namen']);
    // The questions, the list and the accounts of the payments are three different places.
    await openTab(user, 'Erledigen', /Zahlungen klären/);
    expect(screen.getByRole('region', { name: 'Gegenseiten' })).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Konten' })).toBeNull();
    await openTab(user, 'Einstellungen', 'Konten');
    expect(screen.getByRole('region', { name: 'Konten' })).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Gegenseiten' })).toBeNull();
  });

  it('opens on the payment questions when only they wait, and "Offen" leads there when it has nothing', async () => {
    const user = setupUser();
    const base = view([]);
    render(<FinanceClient initial={{ ...base, payments: { ...base.payments, yearCount: 2, unclassified: [unanswered] } }} />);
    expect(selected('Bereiche der Finanzübersicht')).toEqual(['Erledigen, 1 offen']);
    expect(selected('Reiter in Erledigen')).toEqual(['Zahlungen klären, 1 offen']);
    await openTab(user, 'Erledigen', /Offen/);
    await user.click(screen.getByRole('button', { name: 'Zahlungen klären' }));
    expect(selected('Reiter in Erledigen')).toEqual(['Zahlungen klären, 1 offen']);
  });

  it('with nothing waiting it opens on the statement, and Erledigen counts 0', () => {
    render(<FinanceClient initial={view([])} />);
    expect(selected('Bereiche der Finanzübersicht')).toEqual(['Auswerten']);
    expect(selected('Reiter in Auswerten')).toEqual(['EÜR']);
    expect(groups()[0].textContent).toBe('Erledigen, 0 offen');
  });

  it('backtrack: switching groups and back keeps the tab chosen inside each group', async () => {
    const user = setupUser();
    render(<FinanceClient initial={busy()} />);
    await openTab(user, 'Auswerten', 'Anlagen');
    await openTab(user, 'Steuer', 'Einkommensteuer');
    await user.click(screen.getByRole('tab', { name: /^Erledigen/ }));
    expect(selected('Reiter in Erledigen')).toEqual(['Offen, 2 offen']);
    await user.click(screen.getByRole('tab', { name: /^Auswerten/ }));
    expect(selected('Reiter in Auswerten')).toEqual(['Anlagen']);
    await user.click(screen.getByRole('tab', { name: /^Steuer/ }));
    expect(selected('Reiter in Steuer')).toEqual(['Einkommensteuer']);
    // A new choice inside a group replaces the remembered one, and leaves the other groups' alone.
    await openTab(user, 'Auswerten', 'EÜR');
    await user.click(screen.getByRole('tab', { name: /^Steuer/ }));
    expect(selected('Reiter in Steuer')).toEqual(['Einkommensteuer']);
    await user.click(screen.getByRole('tab', { name: /^Auswerten/ }));
    expect(selected('Reiter in Auswerten')).toEqual(['EÜR']);
  });

  it('resume: the address names the tab on screen, and a reload with it opens the same group and tab', async () => {
    const user = setupUser();
    render(<FinanceClient initial={busy()} />);
    // Opened without an address, none is written: a reload chooses again by what waits.
    expect(new URL(window.location.href).searchParams.get('reiter')).toBeNull();
    await openTab(user, 'Auswerten', 'Zahlungen');
    expect(new URL(window.location.href).searchParams.get('reiter')).toBe('zahlungsliste');
    await user.click(screen.getByRole('tab', { name: /^Einstellungen/ }));
    expect(new URL(window.location.href).searchParams.get('reiter')).toBe('konten');
    cleanup();
    // The reload: the server page turns the address into the tab (see tabs.test.ts for every value).
    const { tabFromAddress } = await import('./tabs');
    render(<FinanceClient initial={busy()} initialTab={tabFromAddress('zahlungsliste')} />);
    expect(selected('Bereiche der Finanzübersicht')).toEqual(['Auswerten']);
    expect(selected('Reiter in Auswerten')).toEqual(['Zahlungen']);
    expect(screen.getByText(/Noch nichts entschieden/)).toBeTruthy();
  });

  it('resume: the old address "zahlungen" opens the payment questions under Erledigen', async () => {
    const { tabFromAddress } = await import('./tabs');
    window.history.replaceState(null, '', '/app/finance?reiter=zahlungen');
    render(<FinanceClient initial={busy()} initialTab={tabFromAddress('zahlungen')} />);
    expect(selected('Bereiche der Finanzübersicht')).toEqual(['Erledigen, 5 offen']);
    expect(selected('Reiter in Erledigen')).toEqual(['Zahlungen klären, 3 offen']);
    // The address now says where the person is, in the new words.
    expect(new URL(window.location.href).searchParams.get('reiter')).toBe('zahlungen-klaeren');
  });

  it('re-entry: the return from the bank lands on the accounts under Einstellungen, its message shown once, the year kept', async () => {
    const { tabFromAddress } = await import('./tabs');
    window.history.replaceState(null, '', '/app/finance?jahr=2025&reiter=zahlungen&bank=verbunden');
    const bankActions = {
      listBankInstitutions: vi.fn(),
      startBankConsent: vi.fn(),
      chooseBankConnectionAccount: vi.fn(),
      syncBankNow: vi.fn(),
      disconnectBank: vi.fn(),
      clearBankConnectionNotice: vi.fn(),
    };
    render(<FinanceClient initial={busy()} initialTab={tabFromAddress('zahlungen', true)} bank={{ enabled: true, connections: [] }} bankReturn="verbunden" bankActions={bankActions} />);
    expect(selected('Bereiche der Finanzübersicht')).toEqual(['Einstellungen']);
    expect(selected('Reiter in Einstellungen')).toEqual(['Konten']);
    expect(screen.getByText(/Die Bank ist verbunden/)).toBeTruthy();
    const address = new URL(window.location.href).searchParams;
    expect(address.get('bank')).toBeNull();
    expect(address.get('reiter')).toBe('konten');
    expect(address.get('jahr')).toBe('2025');
    // Away and back within the page: the message was shown once and stays gone.
    const user = setupUser();
    await user.click(screen.getByRole('tab', { name: /^Auswerten/ }));
    await user.click(screen.getByRole('tab', { name: /^Einstellungen/ }));
    expect(selected('Reiter in Einstellungen')).toEqual(['Konten']);
    expect(screen.queryByText(/Die Bank ist verbunden/)).toBeNull();
    // A reload of that address opens the accounts again, without the message.
    cleanup();
    render(<FinanceClient initial={busy()} initialTab={tabFromAddress(address.get('reiter'), address.has('bank'))} bank={{ enabled: true, connections: [] }} bankReturn={null} bankActions={bankActions} />);
    expect(selected('Reiter in Einstellungen')).toEqual(['Konten']);
    expect(screen.queryByText(/Die Bank ist verbunden/)).toBeNull();
  });

  it('with no payment read in, the questions and the list lead to the accounts', async () => {
    const user = setupUser();
    const base = view([]);
    render(<FinanceClient initial={{ ...base, payments: { ...base.payments, yearCount: 0 } }} initialTab="questions" />);
    // Said once, by the part itself; the note above adds only the way to the accounts.
    expect(screen.getAllByText(/keine Zahlungen eingelesen/)).toHaveLength(1);
    await openTab(user, 'Auswerten', 'Zahlungen');
    expect(screen.getAllByText(/keine Zahlungen eingelesen/)).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: 'Zu den Konten' }));
    expect(selected('Reiter in Einstellungen')).toEqual(['Konten']);
  });

  it('a failure on the list of payments is shown once, inside the list', async () => {
    const user = setupUser();
    const base = view([]);
    const treatments = [{ key: 'netz beispiel', label: 'Netz Beispiel', treatment: 'business' as const }];
    render(<FinanceClient initial={{ ...base, payments: { ...base.payments, yearCount: 2, treatments } }} initialTab="payments" />);
    actions.treatCounterparty.mockResolvedValue({ ok: false, error: 'failed' });
    await user.click(screen.getByRole('button', { name: 'Antwort zurücknehmen' }));
    await vi.waitFor(() => expect(screen.getAllByRole('alert')).toHaveLength(1));
    expect(screen.getByRole('alert').textContent).toContain('Das hat nicht geklappt');
    // Another place starts without it.
    await openTab(user, 'Auswerten', 'EÜR');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('changing the year keeps the tab chosen in each group and clears what the last action said', async () => {
    const user = setupUser();
    ownNameActions.changeOwnNames.mockResolvedValue({ ok: true, value: { names: ['Erika Beispiel'], settledOwnName: 0, view: view([]) } });
    const { rerender } = render(<FinanceClient initial={busy()} ownNames={{ names: [], canWrite: true }} />);
    await openTab(user, 'Auswerten', 'Anlagen');
    await openTab(user, 'Einstellungen', 'Eigene Namen');
    await user.type(screen.getByLabelText('Eigener Name, wie die Bank ihn schreibt'), 'Erika Beispiel');
    await user.click(screen.getByRole('button', { name: 'Eigenen Namen hinzufügen' }));
    expect(await screen.findByText('Erika Beispiel gespeichert.')).toBeTruthy();
    // The other year arrives as new props, with the names as the server reads them now.
    rerender(<FinanceClient initial={{ ...busy(), year: 2024 }} ownNames={{ names: ['Erika Beispiel', 'Max Beispiel'], canWrite: true }} />);
    expect(selected('Reiter in Einstellungen')).toEqual(['Eigene Namen']);
    expect(screen.queryByText('Erika Beispiel gespeichert.')).toBeNull();
    expect(screen.getByText('Eigene Namen (2)')).toBeTruthy();
    await user.click(screen.getByRole('tab', { name: /^Auswerten/ }));
    expect(selected('Reiter in Auswerten')).toEqual(['Anlagen']);
  });

  it('the arrow keys move between groups and between tabs; only the chosen one is in the Tab order', async () => {
    const user = setupUser();
    render(<FinanceClient initial={busy()} />);
    const erledigen = screen.getByRole('tab', { name: /^Erledigen/ });
    expect(erledigen.tabIndex).toBe(0);
    expect(screen.getByRole('tab', { name: /^Auswerten/ }).tabIndex).toBe(-1);
    erledigen.focus();
    await user.keyboard('{ArrowRight}');
    expect(selected('Bereiche der Finanzübersicht')).toEqual(['Auswerten']);
    expect(document.activeElement).toBe(screen.getByRole('tab', { name: /^Auswerten/ }));
    await user.keyboard('{End}');
    expect(selected('Bereiche der Finanzübersicht')).toEqual(['Einstellungen']);
    await user.keyboard('{ArrowRight}');
    expect(selected('Bereiche der Finanzübersicht')).toEqual(['Erledigen, 5 offen']);
    // Into the tab row: Tab reaches its chosen tab, and the arrows move there.
    await user.tab();
    expect(document.activeElement?.textContent).toBe('Offen, 2 offen');
    await user.keyboard('{ArrowLeft}');
    expect(selected('Reiter in Erledigen')).toEqual(['Zahlungen klären, 3 offen']);
    await user.keyboard('{Home}');
    expect(selected('Reiter in Erledigen')).toEqual(['Offen, 2 offen']);
  });

  it('the own names\' message stays with the own names: another tab and back starts without it', async () => {
    const user = setupUser();
    ownNameActions.changeOwnNames.mockResolvedValue({ ok: false, error: 'invalid_input', detail: 'name_listed' });
    render(<FinanceClient initial={view([])} initialTab="names" ownNames={{ names: ['Erika Beispiel'], canWrite: true }} />);
    await user.type(screen.getByLabelText('Eigener Name, wie die Bank ihn schreibt'), 'Beispiel Erika');
    await user.click(screen.getByRole('button', { name: 'Eigenen Namen hinzufügen' }));
    expect((await screen.findByRole('alert')).textContent).toContain('steht schon in der Liste');
    await openTab(user, 'Einstellungen', 'Konten');
    await openTab(user, 'Einstellungen', 'Eigene Namen');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('a link to Ausgaben stands next to the tiles', () => {
    render(<FinanceClient initial={view([])} />);
    expect(screen.getByRole('link', { name: 'Ausgaben' }).getAttribute('href')).toBe('/app/spending');
  });
});

describe('FinanceClient: the own names under Einstellungen', () => {
  it('adds a name, says what it settled and shows the statement the server computed afresh', async () => {
    const user = setupUser();
    const after = view([], { businessExpenseCents: 12_345 });
    ownNameActions.changeOwnNames.mockResolvedValue({ ok: true, value: { names: ['Erika Beispiel'], settledOwnName: 2, view: after } });
    render(<FinanceClient initial={view([])} initialTab="names" ownNames={{ names: [], canWrite: true }} />);
    expect(screen.getByText(/Noch kein eigener Name hinterlegt/)).toBeTruthy();
    await user.type(screen.getByLabelText('Eigener Name, wie die Bank ihn schreibt'), 'Erika Beispiel');
    await user.click(screen.getByRole('button', { name: 'Eigenen Namen hinzufügen' }));
    expect(await screen.findByText('Erika Beispiel gespeichert. 2 Benachrichtigungen erledigt: eigenes Konto.')).toBeTruthy();
    expect(ownNameActions.changeOwnNames).toHaveBeenCalledWith(2025, { add: 'Erika Beispiel' });
    expect(screen.getByText('Eigene Namen (1)')).toBeTruthy();
    expect(screen.getByText('123,45 €')).toBeTruthy();
    expect((screen.getByLabelText('Eigener Name, wie die Bank ihn schreibt') as HTMLInputElement).value).toBe('');
  });

  it('a refused name says why and stays in the field; a request that never arrives says so too', async () => {
    const user = setupUser();
    ownNameActions.changeOwnNames.mockResolvedValueOnce({ ok: false, error: 'invalid_input', detail: 'name_listed' }).mockRejectedValueOnce(new Error('offline'));
    render(<FinanceClient initial={view([])} initialTab="names" ownNames={{ names: ['Erika Beispiel'], canWrite: true }} />);
    await user.type(screen.getByLabelText('Eigener Name, wie die Bank ihn schreibt'), 'Beispiel Erika');
    await user.click(screen.getByRole('button', { name: 'Eigenen Namen hinzufügen' }));
    expect((await screen.findByRole('alert')).textContent).toContain('steht schon in der Liste');
    expect((screen.getByLabelText('Eigener Name, wie die Bank ihn schreibt') as HTMLInputElement).value).toBe('Beispiel Erika');
    await clickWhenEnabled(user, () => screen.getByRole('button', { name: 'Eigenen Namen hinzufügen' }));
    await vi.waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Das hat nicht geklappt'));
  });

  it('a change whose statement could not be read afterwards keeps the change and asks for a reload', async () => {
    const user = setupUser();
    ownNameActions.changeOwnNames.mockResolvedValue({ ok: true, value: { names: [], settledOwnName: 0, view: null } });
    render(<FinanceClient initial={view([])} initialTab="names" ownNames={{ names: ['Erika Beispiel'], canWrite: true }} />);
    await user.click(screen.getByRole('button', { name: 'Erika Beispiel aus den eigenen Namen entfernen' }));
    expect(await screen.findByText(/Erika Beispiel entfernt. Die Übersicht konnte danach nicht neu gerechnet werden/)).toBeTruthy();
  });

  it('says so when the names could not be read, and read-only shows them without controls', () => {
    render(<FinanceClient initial={view([])} initialTab="names" ownNames={null} />);
    expect(screen.getByRole('alert').textContent).toContain('Die eigenen Namen konnten nicht geladen werden');
    cleanup();
    render(<FinanceClient initial={view([])} initialTab="names" ownNames={{ names: ['Erika Beispiel'], canWrite: false }} />);
    expect(screen.queryByRole('button', { name: 'Eigenen Namen hinzufügen' })).toBeNull();
    expect(screen.getByText('Erika Beispiel')).toBeTruthy();
  });
});
