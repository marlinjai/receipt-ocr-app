// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { StatementItem } from '@/lib/tax/service';
import LinesForm from './LinesForm';

afterEach(cleanup);

const receipt = (overrides: Partial<StatementItem> = {}): StatementItem =>
  ({ itemId: 'r-1', rowId: 'r-1', lineId: null, lineDescription: null, lineGrossCents: null, lineNetCents: null, receiptGrossCents: 110_000, currency: 'EUR', label: 'Bestellung 4711', ...overrides }) as StatementItem;
const props = () => ({ busy: false, error: null, onCancel: vi.fn(), onSubmit: vi.fn(), onRemove: null });

describe('LinesForm', () => {
  it('forward: two lines that add up are sent; the rest is offered for the last line', async () => {
    const user = userEvent.setup();
    const p = props();
    render(<LinesForm item={receipt()} existing={[]} {...p} />);
    expect(screen.getByRole('status').textContent).toContain('noch zu verteilen: 1.100,00');
    await user.type(screen.getByLabelText('Position 1'), 'Stativ');
    await user.type(screen.getAllByLabelText('Betrag')[0], '900');
    await user.type(screen.getByLabelText('Position 2'), 'Speicherkarte');
    // Focusing the empty amount offers what is left.
    await user.click(screen.getAllByLabelText('Betrag')[1]);
    expect((screen.getAllByLabelText('Betrag')[1] as HTMLInputElement).value).toBe('200,00');
    expect(screen.getByRole('status').textContent).toContain('vollständig verteilt');
    await user.click(screen.getByRole('button', { name: 'Positionen speichern' }));
    expect(p.onSubmit).toHaveBeenCalledWith([
      { description: 'Stativ', grossCents: 90_000, netCents: null },
      { description: 'Speicherkarte', grossCents: 20_000, netCents: null },
    ]);
  });

  it('refuses lines that do not add up, a single line and a net amount above the line, before anything is sent', async () => {
    const user = userEvent.setup();
    const p = props();
    render(<LinesForm item={receipt()} existing={[]} {...p} />);
    await user.type(screen.getByLabelText('Position 1'), 'Stativ');
    await user.type(screen.getAllByLabelText('Betrag')[0], '1100');
    await user.click(screen.getByRole('button', { name: 'Positionen speichern' }));
    expect(screen.getByRole('alert').textContent).toContain('mindestens zwei Positionen');
    await user.clear(screen.getAllByLabelText('Betrag')[0]);
    await user.type(screen.getAllByLabelText('Betrag')[0], '900');
    await user.type(screen.getByLabelText('Position 2'), 'Karte');
    await user.type(screen.getAllByLabelText('Betrag')[1], '150');
    await user.click(screen.getByRole('button', { name: 'Positionen speichern' }));
    expect(screen.getByRole('alert').textContent).toContain('nicht den Belegbetrag');
    await user.clear(screen.getAllByLabelText('Betrag')[1]);
    await user.type(screen.getAllByLabelText('Betrag')[1], '200');
    await user.type(screen.getAllByLabelText('davon netto')[1], '250');
    await user.click(screen.getByRole('button', { name: 'Positionen speichern' }));
    expect(screen.getByRole('alert').textContent).toContain('Nettobetrag');
    expect(p.onSubmit).not.toHaveBeenCalled();
  });

  it('re-entry: an existing split is shown with its lines, keeps their ids, and can be undone', async () => {
    const user = userEvent.setup();
    const p = { ...props(), onRemove: vi.fn() };
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const existing = [
      receipt({ itemId: 'r-1#a', lineId: 'a', lineDescription: 'Stativ', lineGrossCents: 90_000, lineNetCents: 75_630 }),
      receipt({ itemId: 'r-1#b', lineId: 'b', lineDescription: 'Karte', lineGrossCents: 20_000 }),
    ];
    render(<LinesForm item={existing[0]} existing={existing} {...p} />);
    expect((screen.getByLabelText('Position 1') as HTMLInputElement).value).toBe('Stativ');
    expect((screen.getAllByLabelText('davon netto')[0] as HTMLInputElement).value).toBe('756,30');
    await user.click(screen.getByRole('button', { name: 'Positionen speichern' }));
    expect(p.onSubmit).toHaveBeenCalledWith([
      { id: 'a', description: 'Stativ', grossCents: 90_000, netCents: 75_630 },
      { id: 'b', description: 'Karte', grossCents: 20_000, netCents: null },
    ]);
    await user.click(screen.getByRole('button', { name: 'Aufteilung aufheben' }));
    expect(p.onRemove).toHaveBeenCalled();
  });

  it('a split that must be fixed cannot be left by cancelling', () => {
    render(<LinesForm item={receipt()} existing={[]} {...props()} onCancel={null} />);
    expect(screen.queryByRole('button', { name: 'Abbrechen' })).toBeNull();
  });
});
