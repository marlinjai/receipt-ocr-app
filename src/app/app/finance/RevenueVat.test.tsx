// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Forecast } from '@/lib/tax/forecast';
import { rulesForYear } from '@/lib/tax/rules';
import type { InvoiceView, StatementView } from '@/lib/tax/service';
import RevenueTab from './RevenueTab';
import VatTab from './VatTab';

afterEach(cleanup);

const forecast = (overrides: Partial<Forecast> = {}): Forecast => ({
  year: 2026,
  monthsElapsed: 7,
  receivedCents: 640_000,
  outstandingCents: 50_000,
  lowCents: 690_000,
  highCents: 1_190_000,
  monthlyRateCents: 100_000,
  rateBasis: 'run_rate',
  basisMonths: 6,
  thinBasis: false,
  currentYear: { state: 'not_reached' },
  nextYear: { state: 'not_reached' },
  previousYearWithinLimit: true,
  ...overrides,
});

const invoiceView = (overrides: Partial<InvoiceView> = {}): InvoiceView => ({
  id: 'inv-1',
  number: 'R-2026-001',
  issueDate: '2026-03-01',
  grossCents: 100_000,
  vatCents: 0,
  treatment: 'small_business',
  taxGroups: null,
  declaredInYear: null,
  payments: [{ date: '2026-03-20', cents: 100_000 }],
  enteredPayments: [{ date: '2026-03-20', cents: 100_000 }],
  writtenOffCents: 0,
  writtenOffOn: null,
  receivedCents: 100_000,
  excludedCents: 0,
  declaredCents: 0,
  outstandingCents: 0,
  checks: [],
  ...overrides,
});

/** Only the fields the two tabs read; the rest of the view is not their business. */
function view(overrides: Partial<StatementView> = {}): StatementView {
  const { rules } = rulesForYear(2026);
  return {
    year: 2026,
    smallBusiness: true,
    smallBusinessAtYearEnd: true,
    revenue: { recorded: true, receivedCents: 640_000, turnoverCents: 640_000, outstandingCents: 50_000, invoices: [invoiceView()], overdue: [] },
    forecast: forecast(),
    limits: { ...rules.smallBusinessLimits.value, currentYearLimit: 'at_once', nextYearLimitCents: rules.smallBusinessLimits.value.previousYearLimitCents, source: rules.smallBusinessLimits.source },
    expectedMonthlyRevenueCents: null,
    statusChanges: [],
    vat: { frequency: null, method: null, applies: false, year: null, undeductedInputVatCents: 0, settlements: [] },
    ...overrides,
  } as StatementView;
}

const revenueProps = () => ({ busy: false, error: null, onSave: vi.fn(), onDelete: vi.fn(), onExpectation: vi.fn() });
const vatProps = () => ({
  busy: false,
  error: null,
  onStatusChange: vi.fn(),
  onRemoveStatusChange: vi.fn(),
  onSettings: vi.fn(),
  onSettlement: vi.fn(),
  onRemoveSettlement: vi.fn(),
});

describe('RevenueTab', () => {
  it('shows what was received, the range to year end and how the projection was made', () => {
    render(<RevenueTab view={view()} {...revenueProps()} />);
    expect(screen.getByText('6.400,00 €')).toBeTruthy();
    expect(screen.getByText('6.900,00 € bis 11.900,00 €')).toBeTruthy();
    expect(screen.getByText(/Durchschnitt der 6 abgeschlossenen Monate \(1.000,00 € im Monat\)/)).toBeTruthy();
    expect(screen.getByText(/Die Grenze von 25.000,00 € wird nach heutigem Stand nicht erreicht/)).toBeTruthy();
    expect(screen.queryByText('Vorbereitung auf die Regelbesteuerung')).toBeNull();
  });

  it('names the month a limit would be passed and shows the preparation list', () => {
    render(<RevenueTab view={view({ forecast: forecast({ nextYear: { state: 'possible', month: 10 } }) })} {...revenueProps()} />);
    expect(screen.getByText(/wird die Grenze von 25.000,00 € im Oktober überschritten.*endet die Kleinunternehmerregelung zum 1. Januar 2027/)).toBeTruthy();
    expect(screen.getByText('Vorbereitung auf die Regelbesteuerung')).toBeTruthy();
  });

  it('says so when the projection rests on too little, and when the previous year is unknown or was above the limit', () => {
    const { rerender } = render(<RevenueTab view={view({ forecast: forecast({ thinBasis: true, basisMonths: 2, previousYearWithinLimit: null }) })} {...revenueProps()} />);
    expect(screen.getByText(/weniger als drei Monate/)).toBeTruthy();
    expect(screen.getByText(/Der Umsatz 2025 ist hier nicht erfasst/)).toBeTruthy();
    rerender(<RevenueTab view={view({ forecast: forecast({ previousYearWithinLimit: false }) })} {...revenueProps()} />);
    expect(screen.getByRole('alert').textContent).toContain('Der Umsatz 2025 lag über 25.000,00 €');
  });

  it('before 2025 the running-year limit is described as the forecast it was, and next year is judged by the next year\'s limit', () => {
    const limits = { previousYearLimitCents: 2_200_000, currentYearLimitCents: 5_000_000, currentYearLimit: 'forecast_at_start' as const, nextYearLimitCents: 2_500_000, source: { citation: '§ 19', url: 'https://example.org', checkedOn: '2026-10-15' } };
    render(<RevenueTab view={view({ year: 2024, limits, forecast: forecast({ currentYear: { state: 'crossed', month: 11 } }) })} {...revenueProps()} />);
    expect(screen.getByText(/Prognose zu Jahresbeginn/)).toBeTruthy();
    expect(screen.queryByText(/endet die Kleinunternehmerregelung sofort/)).toBeNull();
    expect(screen.getByText(/Die Grenze von 25.000,00 € wird nach heutigem Stand nicht erreicht/)).toBeTruthy();
  });

  it('without any invoice it states that revenue is unknown instead of showing zero', () => {
    render(<RevenueTab view={view({ revenue: { recorded: false, receivedCents: 0, turnoverCents: 0, outstandingCents: 0, invoices: [], overdue: [] } })} {...revenueProps()} />);
    expect(screen.getByText(/Noch keine Rechnung erfasst/)).toBeTruthy();
    expect(screen.queryByText('0,00 €')).toBeNull();
  });

  it('forward: a new invoice with one payment of the whole amount', async () => {
    const user = userEvent.setup();
    const props = revenueProps();
    render(<RevenueTab view={view()} {...props} />);
    await user.click(screen.getByRole('button', { name: 'Neue Rechnung' }));
    await user.type(screen.getByLabelText('Rechnungsnummer'), 'R-2026-002');
    await user.type(screen.getByLabelText('Rechnungsdatum'), '2026-05-02');
    await user.type(screen.getByLabelText('Rechnungsbetrag in €'), '1.250,50');
    await user.click(screen.getByRole('button', { name: 'Zahlungseingang hinzufügen' }));
    // The open amount is offered for the payment.
    expect((screen.getByLabelText('Betrag in €') as HTMLInputElement).value).toBe('1.250,50');
    await user.type(screen.getByLabelText('Eingang am'), '2026-05-20');
    await user.click(screen.getByRole('button', { name: 'Rechnung speichern' }));
    expect(props.onSave.mock.calls[0].slice(0, 2)).toEqual([
      null,
      { number: 'R-2026-002', issueDate: '2026-05-02', grossCents: 125_050, vatCents: 0, treatment: 'small_business', taxGroups: null, declaredInYear: null, payments: [{ date: '2026-05-20', cents: 125_050 }], writtenOffCents: 0, writtenOffOn: null },
    ]);
  });

  it('an invoice with tax needs its tax amount before anything is sent', async () => {
    const user = userEvent.setup();
    const props = revenueProps();
    render(<RevenueTab view={view()} {...props} />);
    await user.click(screen.getByRole('button', { name: 'Neue Rechnung' }));
    await user.type(screen.getByLabelText('Rechnungsnummer'), 'R-2026-003');
    await user.type(screen.getByLabelText('Rechnungsbetrag in €'), '119');
    await user.selectOptions(screen.getByLabelText('Umsatzsteuer auf der Rechnung'), 'standard');
    await user.click(screen.getByRole('button', { name: 'Rechnung speichern' }));
    expect(screen.getByRole('alert').textContent).toContain('enthaltene Umsatzsteuer');
    expect(props.onSave).not.toHaveBeenCalled();
    await user.type(screen.getByLabelText('Enthaltene Umsatzsteuer in €'), '19');
    await user.click(screen.getByRole('button', { name: 'Rechnung speichern' }));
    expect(props.onSave.mock.calls[0][1]).toMatchObject({ grossCents: 11_900, vatCents: 1_900, treatment: 'standard', payments: [] });
  });

  it('shows open amounts, an already declared invoice and a mismatch, and edits an invoice in place', async () => {
    const user = userEvent.setup();
    const props = revenueProps();
    const invoices = [
      invoiceView({ id: 'a', number: 'A', payments: [], receivedCents: 0, outstandingCents: 100_000, checks: ['invoice_overdue'] }),
      invoiceView({ id: 'b', number: 'B', declaredInYear: 2025, excludedCents: 100_000, checks: ['invoice_treatment_mismatch'] }),
    ];
    render(<RevenueTab view={view({ revenue: { recorded: true, receivedCents: 100_000, turnoverCents: 100_000, outstandingCents: 100_000, invoices, overdue: [] } })} {...props} />);
    const open = screen.getByRole('heading', { name: 'Rechnung A' }).closest('li') as HTMLElement;
    expect(open.textContent).toContain('noch nicht bezahlt');
    expect(within(open).getByRole('status').textContent).toContain('Überfällig: 14 Tage oder länger nach Fälligkeit');
    const declared = screen.getByRole('heading', { name: 'Rechnung B' }).closest('li') as HTMLElement;
    expect(declared.textContent).toContain('in der Erklärung 2025 nach Rechnung erfasst');
    expect(declared.textContent).toContain('zählt nicht als Einnahme, weil die Rechnung in der Erklärung 2025');
    expect(within(declared).getByRole('status').textContent).toContain('passt nicht zum Status');
    await user.click(within(open).getByRole('button', { name: 'Ändern' }));
    expect((within(open).getByLabelText('Rechnungsnummer') as HTMLInputElement).value).toBe('A');
    await user.click(within(open).getByRole('button', { name: 'Rechnung speichern' }));
    expect(props.onSave.mock.calls[0][0]).toBe('a');
  });

  it('an invoice declared by invoice says it counts in that year at its amount', () => {
    const declared = invoiceView({ id: 'd', number: 'D', issueDate: '2024-12-15', declaredInYear: 2024, payments: [], enteredPayments: [], receivedCents: 0, declaredCents: 100_000, outstandingCents: 100_000 });
    render(<RevenueTab view={view({ year: 2024, revenue: { recorded: true, receivedCents: 0, turnoverCents: 0, outstandingCents: 100_000, invoices: [declared], overdue: [] } })} {...revenueProps()} />);
    const card = screen.getByRole('heading', { name: 'Rechnung D' }).closest('li') as HTMLElement;
    expect(card.textContent).toContain('Zählt 2024 mit dem Rechnungsbetrag von 1.000,00 € als Einnahme');
  });

  it('edits only the typed-in payments, names the linked ones, and books out the rest of a fee the client kept', async () => {
    const user = userEvent.setup();
    const props = revenueProps();
    // 2,840.00 invoiced; 2,830.00 arrived by a linked bank payment, none typed in; 10.00 kept as a fee.
    const fee = invoiceView({
      id: 'f',
      number: 'F',
      grossCents: 284_000,
      payments: [{ date: '2026-02-11', cents: 283_000 }],
      enteredPayments: [],
      receivedCents: 283_000,
      outstandingCents: 1_000,
    });
    render(<RevenueTab view={view({ revenue: { recorded: true, receivedCents: 283_000, turnoverCents: 283_000, outstandingCents: 1_000, invoices: [fee], overdue: [] } })} {...props} />);
    const card = screen.getByRole('heading', { name: 'Rechnung F' }).closest('li') as HTMLElement;
    await user.click(within(card).getByRole('button', { name: 'Ändern' }));
    expect(card.textContent).toContain('Dazu 2.830,00 € aus zugeordneten Bankzahlungen');
    expect(within(card).queryByLabelText('Eingang am')).toBeNull();

    // More than is open is refused before anything is sent.
    await user.type(within(card).getByLabelText('Ausgebuchter Betrag in €'), '20');
    await user.type(within(card).getByLabelText('Ausgebucht am'), '2026-10-15');
    await user.click(within(card).getByRole('button', { name: 'Rechnung speichern' }));
    expect(within(card).getByRole('alert').textContent).toContain('ausgebuchten Betrag');
    expect(props.onSave).not.toHaveBeenCalled();

    await user.click(within(card).getByRole('button', { name: 'Rest ausbuchen' }));
    expect((within(card).getByLabelText('Ausgebuchter Betrag in €') as HTMLInputElement).value).toBe('10,00');
    await user.click(within(card).getByRole('button', { name: 'Rechnung speichern' }));
    expect(props.onSave.mock.calls[0][1]).toMatchObject({ payments: [], writtenOffCents: 1_000, writtenOffOn: '2026-10-15' });
  });

  it('shows a booked-out part on the invoice', () => {
    const fee = invoiceView({ id: 'f', number: 'F', writtenOffCents: 1_000, writtenOffOn: '2026-10-15' });
    render(<RevenueTab view={view({ revenue: { recorded: true, receivedCents: 100_000, turnoverCents: 100_000, outstandingCents: 0, invoices: [fee], overdue: [] } })} {...revenueProps()} />);
    expect(screen.getByText(/ausgebucht 10,00 € am 15\.10\.2026/)).toBeTruthy();
  });

  it('takes the owner\'s own expectation, and clears it when left empty', async () => {
    const user = userEvent.setup();
    const props = revenueProps();
    render(<RevenueTab view={view()} {...props} />);
    const field = screen.getByLabelText(/Erwarteter Umsatz pro Monat/);
    await user.type(field, 'viel');
    await user.click(screen.getByRole('button', { name: 'Übernehmen' }));
    expect(props.onExpectation).not.toHaveBeenCalled();
    await user.clear(field);
    await user.type(field, '5.000');
    await user.click(screen.getByRole('button', { name: 'Übernehmen' }));
    expect(props.onExpectation).toHaveBeenLastCalledWith(500_000);
    await user.clear(field);
    await user.click(screen.getByRole('button', { name: 'Übernehmen' }));
    expect(props.onExpectation).toHaveBeenLastCalledWith(null);
  });

  it('an invoice with two rates is entered per rate, the tax offered from the net amount, and must add up to the total', async () => {
    const user = userEvent.setup();
    const props = revenueProps();
    render(<RevenueTab view={view({ smallBusinessAtYearEnd: false })} {...props} />);
    await user.click(screen.getByRole('button', { name: 'Neue Rechnung' }));
    await user.type(screen.getByLabelText('Rechnungsnummer'), 'R-2026-010');
    await user.type(screen.getByLabelText('Rechnungsbetrag in €'), '1.725,00');
    await user.selectOptions(screen.getByLabelText('Umsatzsteuer auf der Rechnung'), 'mixed');
    expect(screen.queryByLabelText('Enthaltene Umsatzsteuer in €')).toBeNull();
    await user.type(screen.getByLabelText('Netto 19 % in €'), '1.000,00');
    await user.tab();
    expect((screen.getByLabelText('Steuer 19 % in €') as HTMLInputElement).value).toBe('190,00');
    // A changed net amount computes the offered tax again, until a tax is typed.
    const net19 = screen.getByLabelText('Netto 19 % in €');
    await user.clear(net19);
    await user.type(net19, '2.000,00');
    await user.tab();
    expect((screen.getByLabelText('Steuer 19 % in €') as HTMLInputElement).value).toBe('380,00');
    await user.clear(net19);
    await user.type(net19, '1.000,00');
    await user.tab();
    expect((screen.getByLabelText('Steuer 19 % in €') as HTMLInputElement).value).toBe('190,00');
    await user.type(screen.getByLabelText('Netto 7 % in €'), '400,00');
    await user.tab();
    await user.click(screen.getByRole('button', { name: 'Rechnung speichern' }));
    // 1,000.00 + 190.00 + 400.00 + 28.00 is not the invoice's 1,725.00.
    expect(screen.getByRole('alert').textContent).toContain('ergeben 1.618,00 €');
    expect(props.onSave).not.toHaveBeenCalled();
    const net7 = screen.getByLabelText('Netto 7 % in €');
    await user.clear(net7);
    await user.type(net7, '500,00');
    const tax7 = screen.getByLabelText('Steuer 7 % in €');
    await user.clear(tax7);
    await user.type(tax7, '35,00');
    await user.click(screen.getByRole('button', { name: 'Rechnung speichern' }));
    expect(props.onSave.mock.calls[0][1]).toMatchObject({
      grossCents: 172_500,
      vatCents: 22_500,
      treatment: 'mixed',
      taxGroups: [
        { rateBp: 1900, netCents: 100_000, vatCents: 19_000 },
        { rateBp: 700, netCents: 50_000, vatCents: 3_500 },
      ],
    });
  });

  it('lists the rates of a mixed invoice', () => {
    const invoices = [
      invoiceView({ treatment: 'mixed', grossCents: 172_500, vatCents: 22_500, taxGroups: [{ rateBp: 1900, netCents: 100_000, vatCents: 19_000 }, { rateBp: 700, netCents: 50_000, vatCents: 3_500 }] }),
    ];
    render(<RevenueTab view={view({ revenue: { recorded: true, receivedCents: 0, turnoverCents: 0, outstandingCents: 0, invoices, overdue: [] } })} {...revenueProps()} />);
    const entry = screen.getByRole('heading', { name: 'Rechnung R-2026-001' }).closest('li') as HTMLElement;
    expect(entry.textContent).toContain('19 %: netto 1.000,00 €, Steuer 190,00 €');
    expect(entry.textContent).toContain('7 %: netto 500,00 €, Steuer 35,00 €');
  });
});

describe('VatTab', () => {
  it('shows the turnover and tax per rate under each period and for the year', () => {
    const rates = [
      { rateBp: 1900, netCents: 100_000, vatCents: 19_000 },
      { rateBp: 700, netCents: 50_000, vatCents: 3_500 },
    ];
    const period = (index: number, outputByRate: typeof rates) => ({
      index,
      from: '',
      to: '',
      outputVatCents: outputByRate.reduce((s, r) => s + r.vatCents, 0),
      inputVatCents: 0,
      dueCents: outputByRate.reduce((s, r) => s + r.vatCents, 0),
      outputByRate,
      output: [],
      input: [],
    });
    const year = { periods: [period(1, rates), period(2, []), period(3, []), period(4, [])], outputByRate: rates, outputVatCents: 22_500, inputVatCents: 0, dueCents: 22_500 };
    render(<VatTab view={view({ smallBusinessAtYearEnd: false, vat: { frequency: 'quarterly', method: 'issued', applies: true, year, undeductedInputVatCents: 0, settlements: [] } })} {...vatProps()} />);
    const lines = screen.getAllByText(/zu 19 %: Umsatz 1.000,00 €, Steuer 190,00 € · zu 7 %: Umsatz 500,00 €, Steuer 35,00 €/);
    // Once under the first quarter, once for the year.
    expect(lines).toHaveLength(2);
  });

  it('asks for the first answer before anything else', () => {
    render(<VatTab view={view({ smallBusiness: null })} {...vatProps()} />);
    expect(screen.getByText(/Zuerst muss die Frage zur Kleinunternehmerregelung beantwortet sein/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Wechsel eintragen' })).toBeNull();
  });

  it('under the small-business rule there are no periods, and the tax that could not be deducted is named', () => {
    render(<VatTab view={view({ vat: { frequency: null, method: null, applies: false, year: null, undeductedInputVatCents: 38_000, settlements: [] } })} {...vatProps()} />);
    expect(screen.getByText(/2026 liegt vollständig unter der Kleinunternehmerregelung/)).toBeTruthy();
    expect(screen.getByText(/nicht abziehbar: 380,00 € Umsatzsteuer/)).toBeTruthy();
  });

  it('records a change of status from a day on', async () => {
    const user = userEvent.setup();
    const props = vatProps();
    render(<VatTab view={view()} {...props} />);
    await user.click(screen.getByRole('button', { name: 'Wechsel eintragen' }));
    expect(screen.getByRole('alert').textContent).toContain('gültiges Datum');
    await user.type(screen.getByLabelText('Wechsel ab'), '2027-01-01');
    await user.click(screen.getByRole('button', { name: 'Wechsel eintragen' }));
    expect(props.onStatusChange.mock.calls[0][0]).toEqual({ effectiveFrom: '2027-01-01', smallBusiness: false });
  });

  it('under regular taxation it shows no figures until frequency and method are set, then the periods', async () => {
    const user = userEvent.setup();
    const props = vatProps();
    const applies = { frequency: null, method: null, applies: true, year: null, undeductedInputVatCents: 0, settlements: [] };
    const { rerender } = render(<VatTab view={view({ smallBusinessAtYearEnd: false, statusChanges: [{ id: 'c1', effectiveFrom: '2026-07-01', smallBusiness: false }], vat: applies })} {...props} />);
    expect(screen.getByText(/vorher gibt es hier keine Zahlen/)).toBeTruthy();
    expect(screen.getByText(/Ab 01.07.2026: Regelbesteuerung/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'mit dem Zahlungseingang' }));
    await user.click(screen.getByRole('button', { name: 'Festlegen' }));
    expect(props.onSettings).toHaveBeenCalledWith({ frequency: 'quarterly', method: 'received' });

    const period = (index: number, outputVatCents: number, inputVatCents: number) => ({
      index,
      from: '',
      to: '',
      outputVatCents,
      inputVatCents,
      dueCents: outputVatCents - inputVatCents,
      outputByRate: [],
      output: [],
      input: [],
    });
    const year = { periods: [period(1, 0, 0), period(2, 0, 0), period(3, 19_000, 1_900), period(4, 0, 28_500)], outputByRate: [], outputVatCents: 19_000, inputVatCents: 30_400, dueCents: -11_400 };
    rerender(<VatTab view={view({ smallBusinessAtYearEnd: false, vat: { ...applies, frequency: 'quarterly', method: 'received', year, settlements: [{ id: 's1', date: '2026-10-10', cents: 17_100, direction: 'paid' }] } })} {...props} />);
    const rows = screen.getAllByRole('row');
    expect(rows[3].textContent).toContain('3. Quartal');
    expect(rows[3].textContent).toContain('171,00 €');
    expect(rows[4].textContent).toContain('Erstattung 285,00 €');
    expect(rows[5].textContent).toContain('Erstattung 114,00 €');
    expect(screen.getByText(/10.10.2026: gezahlt 171,00 €/)).toBeTruthy();
  });

  it('records a payment to the tax office and refuses one without amount', async () => {
    const user = userEvent.setup();
    const props = vatProps();
    render(<VatTab view={view({ smallBusinessAtYearEnd: false, vat: { frequency: 'quarterly', method: 'issued', applies: true, year: null, undeductedInputVatCents: 0, settlements: [] } })} {...props} />);
    await user.type(screen.getByLabelText('Datum'), '2026-10-10');
    await user.click(screen.getByRole('button', { name: 'Eintragen' }));
    expect(screen.getByRole('alert').textContent).toContain('Datum und Betrag');
    await user.type(screen.getByLabelText('Betrag in €'), '171,00');
    await user.click(screen.getByRole('button', { name: 'Erstattet' }));
    await user.click(screen.getByRole('button', { name: 'Eintragen' }));
    expect(props.onSettlement.mock.calls[0][0]).toEqual({ date: '2026-10-10', cents: 17_100, direction: 'refunded' });
  });
});
