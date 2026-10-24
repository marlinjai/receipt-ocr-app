// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import OverviewClient, { VENDOR_CHIPS_PHONE, VENDOR_CHIPS_WIDE, overviewDay } from './OverviewClient';
import type { LedgerInvoice } from '@/lib/overview/selection';

/**
 * The spend overview speaks German, shows German days, and folds its vendor chips (production at 390 on
 * 2026-10-24: English labels, raw timestamps, and dozens of chips before the first chart).
 */

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function width(phone: boolean) {
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({ matches: phone, media: query, addEventListener: () => {}, removeEventListener: () => {} })),
  );
}

/** Twenty invented vendors, one receipt each, "Händler 01" the largest; days stored as full timestamps. */
const VENDORS = Array.from({ length: 20 }, (_, i) => `Händler ${String(i + 1).padStart(2, '0')}`);
const invoices: LedgerInvoice[] = VENDORS.map((vendor, i) => ({
  id: `r${i}`,
  name: null,
  vendor,
  currency: 'EUR',
  amountNative: (20 - i) * 10,
  fxRate: 1,
  businessShare: 100,
  date: i === 0 ? '2021-01-14T00:00:00.000Z' : i === 19 ? '2026-10-11T00:00:00.000Z' : `2024-0${(i % 9) + 1}-10T00:00:00.000Z`,
}));

function overview(selections: Array<{ id: string; name: string; definition: Record<string, unknown> }> = []) {
  render(<OverviewClient invoices={invoices} selections={selections} attribution={{ rules: [], defaultShare: 100 }} notes="" />);
}

const vendorGroup = () => screen.getByRole('group', { name: 'Händler' });
const chip = (name: string) => within(vendorGroup()).getByRole('button', { name, pressed: undefined });
/** The vendor chips as drawn, in order (the chips are the buttons that say whether they are pressed). */
const shownChips = () => [...vendorGroup().querySelectorAll<HTMLElement>('button[aria-pressed]')];
const countLine = () => screen.getByRole('heading', { name: 'Ausgabenübersicht' }).nextElementSibling?.textContent ?? '';

describe('the overview in German', () => {
  it('names everything in German and leaves no English label behind', () => {
    width(true);
    overview();
    expect(screen.getByRole('heading', { name: 'Ausgabenübersicht' })).toBeTruthy();
    expect(screen.getByRole('link', { name: '← Belege' }).getAttribute('href')).toBe('/app/dashboard');
    expect(screen.getByRole('combobox', { name: 'Gespeicherte Auswahl' })).toBeTruthy();
    expect(screen.getByRole('option', { name: 'Alle Belege (Standard)' })).toBeTruthy();
    expect(screen.getByPlaceholderText('Name der Auswahl')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Auswahl speichern' }).textContent).toBe('Speichern');
    expect(screen.getByRole('button', { name: 'Zeitraum' })).toBeTruthy();
    for (const english of ['Spend overview', 'Ledger', 'invoices in view', 'All invoices', 'Selection name', 'Vendors:', 'Custom', 'Total by vendor', 'Notes']) {
      expect(document.body.textContent).not.toContain(english);
    }
  });

  it('shows the range as German days, never as a raw timestamp', () => {
    width(true);
    overview();
    expect(countLine()).toBe('20 von 20 Belegen in der Auswahl · 14.01.2021 bis 11.10.2026');
    expect(document.body.textContent).not.toContain('T00:00:00');
    expect(overviewDay('2026-10-11T00:00:00.000Z')).toBe('11.10.2026');
    expect(overviewDay('2026-10-11')).toBe('11.10.2026');
    expect(overviewDay(null)).toBe('ohne Datum');
  });
});

describe('the vendor chips', () => {
  it('fold to the largest vendors on a phone, with a way to all of them', () => {
    width(true);
    overview();
    expect(shownChips().map((b) => b.textContent)).toEqual(VENDORS.slice(0, VENDOR_CHIPS_PHONE));
    expect(screen.getByRole('button', { name: 'Alle Händler anzeigen (20)' }).getAttribute('aria-expanded')).toBe('false');
  });

  it('show more on a wide screen, folded all the same when the list is long', () => {
    width(false);
    overview();
    expect(shownChips()).toHaveLength(VENDOR_CHIPS_WIDE);
    expect(screen.getByRole('button', { name: 'Alle Händler anzeigen (20)' })).toBeTruthy();
  });

  it('select: switching a vendor off takes it out of the figures', async () => {
    const user = userEvent.setup();
    width(true);
    overview();
    await user.click(chip('Händler 01'));
    expect(chip('Händler 01').getAttribute('aria-pressed')).toBe('false');
    expect(countLine()).toMatch(/^19 von 20 Belegen/);
    expect(screen.getByRole('button', { name: '1 Händler ausgeblendet, alle einbeziehen' })).toBeTruthy();
  });

  it('change: a vendor found in the unfolded list and switched off stays visible once the list folds again', async () => {
    const user = userEvent.setup();
    width(true);
    overview();
    await user.click(chip('Händler 01'));
    await user.click(screen.getByRole('button', { name: 'Alle Händler anzeigen (20)' }));
    await user.type(screen.getByRole('searchbox', { name: 'Händler suchen' }), '17');
    expect(shownChips().map((b) => b.textContent)).toEqual(['Händler 01', 'Händler 17']);
    await user.click(chip('Händler 17'));
    await user.click(screen.getByRole('button', { name: 'Weniger anzeigen' }));
    const folded = shownChips().map((b) => b.textContent);
    expect(folded).toContain('Händler 17');
    expect(chip('Händler 17').getAttribute('aria-pressed')).toBe('false');
    expect(countLine()).toMatch(/^18 von 20 Belegen/);
    // Switching it back on is the same tap.
    await user.click(chip('Händler 17'));
    expect(countLine()).toMatch(/^19 von 20 Belegen/);
  });

  it('resume: a saved selection restores its vendors, and a left-out vendor from the folded part shows', async () => {
    const user = userEvent.setup();
    width(true);
    overview([{ id: 's1', name: 'Ohne Kleinkram', definition: { preset: 'all', vendors: VENDORS.filter((v) => v !== 'Händler 20' && v !== 'Händler 02') } }]);
    await user.selectOptions(screen.getByRole('combobox', { name: 'Gespeicherte Auswahl' }), 's1');
    expect(chip('Händler 20').getAttribute('aria-pressed')).toBe('false');
    expect(chip('Händler 02').getAttribute('aria-pressed')).toBe('false');
    expect(countLine()).toMatch(/^18 von 20 Belegen/);
    expect(screen.getByRole('button', { name: '2 Händler ausgeblendet, alle einbeziehen' })).toBeTruthy();
  });

  it('clear: "alle einbeziehen" and "Zurücksetzen" both bring every vendor back', async () => {
    const user = userEvent.setup();
    width(true);
    overview();
    await user.click(chip('Händler 01'));
    await user.click(chip('Händler 02'));
    await user.click(screen.getByRole('button', { name: '2 Händler ausgeblendet, alle einbeziehen' }));
    expect(countLine()).toMatch(/^20 von 20 Belegen/);
    expect(screen.queryByRole('button', { name: /ausgeblendet/ })).toBeNull();
    await user.click(chip('Händler 03'));
    await user.click(screen.getByRole('button', { name: 'Zurücksetzen' }));
    expect(countLine()).toMatch(/^20 von 20 Belegen/);
    expect(chip('Händler 03').getAttribute('aria-pressed')).toBe('true');
  });

  it('says when the search finds no vendor', async () => {
    const user = userEvent.setup();
    width(true);
    overview();
    await user.click(screen.getByRole('button', { name: 'Alle Händler anzeigen (20)' }));
    await user.type(screen.getByRole('searchbox', { name: 'Händler suchen' }), 'gibt es nicht');
    expect(screen.getByText('Kein Händler passt zur Suche.')).toBeTruthy();
  });
});
