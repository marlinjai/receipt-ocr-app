// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReviewEntry } from '@/lib/review/service';
import ReviewPanel from '../ReviewPanel';

afterEach(cleanup);

const entry = (overrides: Partial<ReviewEntry> = {}): ReviewEntry => ({
  rowId: 'r1',
  name: 'Grillhaus Beispiel',
  vendor: 'Grillhaus Beispiel',
  date: '2025-10-09',
  gross: 48.4,
  currency: 'EUR',
  isMeal: true,
  reasons: ['total_unconfirmed'],
  canConfirm: true,
  duplicates: [],
  proposal: [],
  ...overrides,
});

function setup(entries: ReviewEntry[], extra: { busy?: boolean; error?: string | null } = {}) {
  const handlers = { onOpen: vi.fn(), onConfirm: vi.fn(), onKeepBoth: vi.fn(), onDelete: vi.fn(), onTakeReading: vi.fn() };
  render(<ReviewPanel entries={entries} busy={extra.busy ?? false} error={extra.error ?? null} {...handlers} />);
  return handlers;
}

describe('ReviewPanel', () => {
  it('shows nothing when no receipt needs a look', () => {
    setup([]);
    expect(screen.queryByText('Belege prüfen')).toBeNull();
  });

  it('says how many receipts need a look and opens the list on request', async () => {
    setup([entry(), entry({ rowId: 'r2', name: 'Nicht lesbar: scan-07.pdf', reasons: ['read_failed'], canConfirm: false, date: null, gross: null })]);
    const toggle = screen.getByRole('button', { name: /Belege prüfen/ });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(screen.getByText(/2 Belege brauchen einen Blick/)).toBeTruthy();
    expect(screen.queryByText('Grillhaus Beispiel')).toBeNull();

    await userEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText('Grillhaus Beispiel')).toBeTruthy();
    expect(screen.getByText(/09\.10\.2025 · 48,40/)).toBeTruthy();
    // The reason in plain words, and the unreadable page without a date or an amount.
    expect(screen.getByText(/ohne Gegenprobe über die Steuerzeilen/)).toBeTruthy();
    expect(screen.getByText(/Auf dem Bild wurde kein Text erkannt/)).toBeTruthy();
    expect(screen.getByText(/ohne Datum · ohne Betrag/)).toBeTruthy();
  });

  it('"Geprüft" is offered only where a recorded doubt can be settled by looking', async () => {
    const handlers = setup([entry(), entry({ rowId: 'r2', name: 'Ohne Betrag', reasons: ['amount_missing'], canConfirm: false })]);
    await userEvent.click(screen.getByRole('button', { name: /Belege prüfen/ }));
    const items = screen.getAllByRole('listitem').filter((li) => within(li).queryByRole('button', { name: 'Beleg öffnen' }));
    expect(within(items[0]).getByRole('button', { name: 'Geprüft, stimmt so' })).toBeTruthy();
    expect(within(items[1]).queryByRole('button', { name: 'Geprüft, stimmt so' })).toBeNull();

    await userEvent.click(within(items[0]).getByRole('button', { name: 'Geprüft, stimmt so' }));
    expect(handlers.onConfirm).toHaveBeenCalledWith('r1');
    await userEvent.click(within(items[1]).getByRole('button', { name: 'Beleg öffnen' }));
    expect(handlers.onOpen).toHaveBeenCalledWith('r2');
    await userEvent.click(within(items[1]).getByRole('button', { name: 'Löschen' }));
    expect(handlers.onDelete).toHaveBeenCalledWith('r2');
  });

  it('a look-alike names the other receipt and offers to keep both or look at it', async () => {
    const handlers = setup([
      entry({ reasons: ['possible_duplicate'], canConfirm: false, duplicates: [{ rowId: 'r9', name: 'Grillhaus Beispiel (zweiter Scan)', date: '2025-10-09', gross: 48.4 }] }),
    ]);
    await userEvent.click(screen.getByRole('button', { name: /Belege prüfen/ }));
    expect(screen.getByText(/Gleicht: Grillhaus Beispiel \(zweiter Scan\) \(09\.10\.2025\)/)).toBeTruthy();

    await userEvent.click(screen.getByRole('button', { name: 'Beide behalten' }));
    expect(handlers.onKeepBoth).toHaveBeenCalledWith('r1', 'r9');
    await userEvent.click(screen.getByRole('button', { name: 'Anderen ansehen' }));
    expect(handlers.onOpen).toHaveBeenCalledWith('r9');
  });

  it('a new reading is shown as stored against newly read, and is taken only on request', async () => {
    const handlers = setup([
      entry({
        name: 'Since 2016',
        reasons: ['reading_differs'],
        proposal: [
          { field: 'vendor', from: 'Since 2016', to: 'Fantastic Foodbar' },
          { field: 'gross', from: 50, to: 45.2 },
          { field: 'taxRate', from: 526.37, to: 19 },
          { field: 'tip', from: null, to: 4.8 },
        ],
      }),
    ]);
    await userEvent.click(screen.getByRole('button', { name: /Belege prüfen/ }));
    const table = screen.getByRole('table', { name: /Neue Lesart von Since 2016/ });
    const rows = within(table).getAllByRole('row').slice(1).map((r) => r.textContent);
    expect(rows).toEqual(['HändlerSince 2016Fantastic Foodbar', 'Gesamtbetrag50,00\u00a0€45,20\u00a0€', 'Steuersatz526,37 %19 %', 'Trinkgeldleer4,80\u00a0€']);
    expect(handlers.onTakeReading).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole('button', { name: 'Neue Lesart übernehmen' }));
    expect(handlers.onTakeReading).toHaveBeenCalledWith('r1', ['vendor', 'gross', 'taxRate', 'tip']);
    // Keeping what is stored is the other answer.
    await userEvent.click(screen.getByRole('button', { name: 'Geprüft, stimmt so' }));
    expect(handlers.onConfirm).toHaveBeenCalledWith('r1');
  });

  it('while an action runs every button of the list is disabled, so nothing is sent twice', async () => {
    const handlers = setup([entry()], { busy: true });
    await userEvent.click(screen.getByRole('button', { name: /Belege prüfen/ }));
    const confirm = screen.getByRole('button', { name: 'Geprüft, stimmt so' }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    await userEvent.click(confirm);
    expect(handlers.onConfirm).not.toHaveBeenCalled();
  });

  it('a currency name that is no currency code does not break the list', async () => {
    setup([entry({ currency: 'Euro' })]);
    await userEvent.click(screen.getByRole('button', { name: /Belege prüfen/ }));
    expect(screen.getByText(/09\.10\.2025 · 48,40 Euro/)).toBeTruthy();
  });

  it('a failure is said in the page, also when the list itself is empty', () => {
    setup([], { error: 'Die Prüfliste konnte nicht geladen werden.' });
    expect(screen.getByRole('alert').textContent).toContain('Die Prüfliste konnte nicht geladen werden.');
  });
});
