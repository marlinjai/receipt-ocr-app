// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { incomeTaxView } from '@/lib/tax/income-tax/__tests__/fixtures';
import type { StatementView } from '@/lib/tax/service';
import { zeroFigures, type WageEntry } from '@/lib/tax/income-tax/wages';
import IncomeTaxTab, { balanceText } from './IncomeTaxTab';

afterEach(cleanup);

const slip = (month: number, overrides: Partial<WageEntry> = {}): WageEntry => ({
  id: `w-${month}`,
  employer: 'Arbeitgeber',
  month,
  healthWithSickPay: true,
  churchLiable: null,
  ...zeroFigures(),
  grossCents: 450_000,
  wageTaxCents: 70_000,
  ...overrides,
});

/** Only the fields the tab reads. */
const view = (incomeTax = incomeTaxView()): StatementView => ({ year: incomeTax.year, employmentCostCents: 136_982, incomeTax }) as StatementView;

const props = () => ({
  busy: false,
  error: null,
  onSaveWage: vi.fn(),
  onRemoveWage: vi.fn(),
  onSaveItem: vi.fn(),
  onRemoveItem: vi.fn(),
  onChurchMonths: vi.fn(),
  onFederalState: vi.fn(),
});

describe('balanceText', () => {
  it('names a refund and a payment instead of a sign', () => {
    expect(balanceText(-424_976)).toBe('Erstattung 4.249,76 €');
    expect(balanceText(12_000)).toBe('Nachzahlung 120,00 €');
    expect(balanceText(0)).toBe('ausgeglichen (0,00 €)');
  });
});

describe('IncomeTaxTab', () => {
  it('without any data says what to enter instead of showing a zero', () => {
    render(<IncomeTaxTab view={view()} {...props()} />);
    expect(screen.getByText(/weder Lohndaten noch ein Ergebnis des Gewerbes/)).toBeTruthy();
    expect(screen.queryByText(/Erstattung/)).toBeNull();
  });

  it('with a business result and no wages is labelled business only and asks for one pay slip', () => {
    render(<IncomeTaxTab view={view(incomeTaxView({ profitCents: 500_000 }))} {...props()} />);
    expect(screen.getByRole('heading', { name: /Schätzung \(nur Gewerbe\)/ })).toBeTruthy();
    expect(screen.getByText(/eine Lohnabrechnung reicht für den Anfang/)).toBeTruthy();
  });

  it('shows the refund, the three taxes and the calculation with sources', async () => {
    const tax = incomeTaxView({
      year: 2025,
      profitCents: -959_483,
      wageEntries: [slip(0, { grossCents: 5_296_950, wageTaxCents: 807_176, churchTaxCents: 66_207 })],
      churchMonths: Array.from({ length: 12 }, (_, i) => i < 11),
      federalState: 'BE',
    });
    render(<IncomeTaxTab view={view(tax)} {...props()} />);
    expect(screen.getByRole('heading', { name: /Schätzung \(Lohn und Gewerbe\)/ })).toBeTruthy();
    expect(tax.estimate.totalBalanceCents as number).toBeLessThan(0);
    expect(screen.getAllByText(balanceText(tax.estimate.totalBalanceCents as number)).length).toBeGreaterThan(0);
    const table = screen.getByRole('table', { name: /Steuern 2025/ });
    expect(within(table).getByRole('row', { name: /Kirchensteuer/ })).toBeTruthy();
    expect(screen.getByText(/Was das Gewerbe an deiner Steuer ändert/)).toBeTruthy();
    await userEvent.click(screen.getByText('Rechenweg mit Quellen'));
    expect(screen.getAllByText(/§ 32a Abs. 1 Einkommensteuergesetz/).length).toBeGreaterThan(0);
  });

  it('switches between the projected year and the months entered', async () => {
    const tax = incomeTaxView({ running: true, project: true, profitCents: 0, wageEntries: [slip(1), slip(2)] });
    render(<IncomeTaxTab view={view(tax)} {...props()} />);
    const projected = screen.getByRole('button', { name: 'Lohn bis Dezember hochgerechnet' });
    expect(projected.getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByText(/mit den Zahlen der letzten Lohnabrechnung hochgerechnet/)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Nur erfasste Monate' }));
    expect(screen.queryByText(/mit den Zahlen der letzten Lohnabrechnung hochgerechnet/)).toBeNull();
  });

  it('enters a pay slip with German amounts, prefilled with the last employer and the next month', async () => {
    const p = props();
    render(<IncomeTaxTab view={view(incomeTaxView({ wageEntries: [slip(8)] }))} {...p} />);
    await userEvent.click(screen.getByRole('button', { name: 'Lohnabrechnung oder Bescheinigung eintragen' }));
    const form = screen.getByRole('form', { name: 'Lohnangabe' });
    expect((within(form).getByLabelText('Arbeitgeber') as HTMLInputElement).value).toBe('Arbeitgeber');
    expect((within(form).getByLabelText('Zeitraum') as HTMLSelectElement).value).toBe('9');
    await userEvent.type(within(form).getByLabelText('Bruttoarbeitslohn in €'), '4.512,30');
    await userEvent.type(within(form).getByLabelText('Lohnsteuer in €'), '702,16');
    await userEvent.selectOptions(within(form).getByLabelText(/Kirchensteuerpflichtig/), 'no');
    await userEvent.click(within(form).getByRole('button', { name: 'Speichern' }));
    expect(p.onSaveWage).toHaveBeenCalledWith(
      null,
      expect.objectContaining({ year: 2026, employer: 'Arbeitgeber', month: 9, grossCents: 451_230, wageTaxCents: 70_216, solidarityCents: 0, churchLiable: false, healthWithSickPay: true }),
      expect.any(Function),
    );
  });

  it('refuses an amount it cannot read, before sending anything', async () => {
    const p = props();
    render(<IncomeTaxTab view={view()} {...p} />);
    await userEvent.click(screen.getByRole('button', { name: 'Lohnabrechnung oder Bescheinigung eintragen' }));
    const form = screen.getByRole('form', { name: 'Lohnangabe' });
    await userEvent.type(within(form).getByLabelText('Arbeitgeber'), 'Arbeitgeber');
    await userEvent.type(within(form).getByLabelText('Bruttoarbeitslohn in €'), 'viel');
    await userEvent.click(within(form).getByRole('button', { name: 'Speichern' }));
    expect(p.onSaveWage).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toMatch(/Bruttoarbeitslohn/);
  });

  it('opens an existing entry for a change with its figures', async () => {
    const p = props();
    render(<IncomeTaxTab view={view(incomeTaxView({ wageEntries: [slip(3)] }))} {...p} />);
    await userEvent.click(screen.getByRole('button', { name: 'Ändern' }));
    const form = screen.getByRole('form', { name: 'Lohnangabe' });
    expect((within(form).getByLabelText('Bruttoarbeitslohn in €') as HTMLInputElement).value).toBe('4.500,00');
    await userEvent.click(within(form).getByRole('button', { name: 'Speichern' }));
    expect(p.onSaveWage).toHaveBeenCalledWith('w-3', expect.objectContaining({ month: 3, grossCents: 450_000 }), expect.any(Function));
  });

  it('needs days and a distance for a commute', async () => {
    const p = props();
    render(<IncomeTaxTab view={view()} {...p} />);
    await userEvent.click(screen.getByRole('button', { name: 'Angabe hinzufügen' }));
    const form = screen.getByRole('form', { name: 'Weitere Angabe' });
    await userEvent.selectOptions(within(form).getByLabelText('Art'), 'employment.commute');
    await userEvent.type(within(form).getByLabelText('Tage'), '4');
    await userEvent.click(within(form).getByRole('button', { name: 'Speichern' }));
    expect(p.onSaveItem).not.toHaveBeenCalled();
    await userEvent.type(within(form).getByLabelText('Entfernung in km'), '20');
    await userEvent.click(within(form).getByRole('button', { name: 'Speichern' }));
    expect(p.onSaveItem).toHaveBeenCalledWith(null, { year: 2026, key: 'employment.commute', amountCents: null, days: 4, distanceKm: 20, note: null }, expect.any(Function));
  });

  it('saves the church tax months as twelve flags', async () => {
    const p = props();
    render(<IncomeTaxTab view={view()} {...p} />);
    await userEvent.click(screen.getByLabelText('Januar'));
    await userEvent.click(screen.getByRole('button', { name: 'Monate speichern' }));
    expect(p.onChurchMonths).toHaveBeenCalledWith([true, false, false, false, false, false, false, false, false, false, false, false]);
  });

  it('shows a failure from the server', () => {
    render(<IncomeTaxTab view={view()} {...props()} error="Für diesen Arbeitgeber und Monat ist schon eine Angabe gespeichert." />);
    expect(screen.getByRole('alert').textContent).toMatch(/schon eine Angabe/);
  });
});
