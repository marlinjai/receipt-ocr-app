// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { rulesForYear } from '@/lib/tax/rules';
import type { StatementItem, StatementView } from '@/lib/tax/service';

const actions = vi.hoisted(() => ({
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
  saveAsset: vi.fn(),
  removeAsset: vi.fn(),
  disposeAsset: vi.fn(),
}));
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
    itemId: overrides.rowId,
    lineId: null,
    lineDescription: null,
    lineGrossCents: null,
    lineNetCents: null,
    receiptGrossCents: 3999,
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
    vendorRuleId: null,
    isMeal: false,
    assetId: null,
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
    revenue: { recorded: false, receivedCents: 0, turnoverCents: 0, outstandingCents: 0, invoices: [] },
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
    limits: { previousYearLimitCents: 2_500_000, currentYearLimitCents: 10_000_000, source: rules.smallBusinessLimits.source },
    expectedMonthlyRevenueCents: null,
    smallBusinessAtYearEnd: true,
    statusChanges: [],
    vat: { frequency: null, method: null, applies: false, year: null, undeductedInputVatCents: 0, settlements: [] },
    payments: { accounts: [], yearCount: 0, linkedCount: 0, unclassified: [], treatments: [], open: [], overridden: [], receiptTargets: [], invoiceTargets: [], links: [] },
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
      treatment: { allocations: [{ purpose: 'business', shareBp: 5000 }], formLineKey: 'euer.telecom', employmentLineKey: null, severalLowValueItems: false },
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
      severalLowValueItems: false,
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
      severalLowValueItems: false,
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
    expect(screen.getByText(/Es ist noch keine Rechnung erfasst/)).toBeTruthy();
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
    const user = userEvent.setup();
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
      reminderCents: 0,
      opening: null,
      itemIds: ['cam'],
    });
    expect(await screen.findByText('Kamera: Anlage gespeichert.')).toBeTruthy();
    expect(screen.getByText('1.250,00 €')).toBeTruthy();
  });

  it('refuses a new asset without a receipt or with a life of a year before anything is sent', async () => {
    const user = userEvent.setup();
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

  it('an asset from earlier years is entered with its book value and no receipts', async () => {
    const user = userEvent.setup();
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
    const user = userEvent.setup();
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
    const user = userEvent.setup();
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
});
