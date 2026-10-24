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
/** The vendor chips as drawn on a wide screen, in order (the chips are the buttons that say whether they are pressed). */
const shownChips = () => [...vendorGroup().querySelectorAll<HTMLElement>('button[aria-pressed]')];
/** The chips a phone shows: CSS hides the rest below the small breakpoint (jsdom applies no CSS, so it is read off the class). */
const phoneChips = () => shownChips().filter((b) => !b.className.includes('max-sm:hidden'));
const countLine = () => screen.getByRole('heading', { name: 'Ausgabenübersicht' }).nextElementSibling?.textContent ?? '';

describe('the overview in German', () => {
  it('names everything in German and leaves no English label behind', () => {
    overview();
    expect(screen.getByRole('heading', { name: 'Ausgabenübersicht' })).toBeTruthy();
    expect(screen.getByRole('link', { name: '← Belege' }).getAttribute('href')).toBe('/app/dashboard');
    expect(screen.getByRole('combobox', { name: 'Gespeicherte Auswahl' })).toBeTruthy();
    expect(screen.getByRole('option', { name: 'Alle Belege (Standard)' })).toBeTruthy();
    expect(screen.getByPlaceholderText('Name der Auswahl')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Auswahl speichern' }).textContent).toBe('Speichern');
    expect(screen.getByRole('button', { name: 'Eigener Zeitraum' })).toBeTruthy();
    for (const english of ['Spend overview', 'Ledger', 'invoices in view', 'All invoices', 'Selection name', 'Vendors:', 'Custom', 'Total by vendor', 'Notes']) {
      expect(document.body.textContent).not.toContain(english);
    }
  });

  it('shows the range as German days, never as a raw timestamp', () => {
    overview();
    expect(countLine()).toBe('20 von 20 Belegen in der Auswahl · 14.01.2021 bis 11.10.2026');
    expect(document.body.textContent).not.toContain('T00:00:00');
    expect(overviewDay('2026-10-11T00:00:00.000Z')).toBe('11.10.2026');
    expect(overviewDay('2026-10-11')).toBe('11.10.2026');
    expect(overviewDay(null)).toBe('ohne Datum');
  });
});

describe('the vendor chips', () => {
  it('fold to the largest vendors, fewer on a phone than on a wide screen, both in the first paint', () => {
    overview();
    expect(phoneChips().map((b) => b.textContent)).toEqual(VENDORS.slice(0, VENDOR_CHIPS_PHONE));
    expect(shownChips().map((b) => b.textContent)).toEqual(VENDORS.slice(0, VENDOR_CHIPS_WIDE));
    const more = screen.getByRole('button', { name: 'Alle Händler anzeigen (20)' });
    expect(more.getAttribute('aria-expanded')).toBe('false');
    expect(more.className).not.toContain('sm:hidden');
  });

  it('offer unfolding on a phone only, when a wide screen already shows every vendor', () => {
    render(<OverviewClient invoices={invoices.slice(0, 12)} selections={[]} attribution={{ rules: [], defaultShare: 100 }} notes="" />);
    expect(phoneChips()).toHaveLength(VENDOR_CHIPS_PHONE);
    expect(shownChips()).toHaveLength(12);
    expect(screen.getByRole('button', { name: 'Alle Händler anzeigen (12)' }).className).toContain('sm:hidden');
  });

  it('offer no unfolding at all when nothing is folded away', () => {
    render(<OverviewClient invoices={invoices.slice(0, 5)} selections={[]} attribution={{ rules: [], defaultShare: 100 }} notes="" />);
    expect(screen.queryByRole('button', { name: /Alle Händler anzeigen/ })).toBeNull();
  });

  it('select: switching a vendor off takes it out of the figures', async () => {
    const user = userEvent.setup();
    overview();
    await user.click(chip('Händler 01'));
    expect(chip('Händler 01').getAttribute('aria-pressed')).toBe('false');
    expect(countLine()).toMatch(/^19 von 20 Belegen/);
    expect(screen.getByRole('button', { name: '1 Händler ausgeblendet, alle einbeziehen' })).toBeTruthy();
  });

  it('change: a vendor found in the unfolded list and switched off stays visible once the list folds again', async () => {
    const user = userEvent.setup();
    overview();
    await user.click(chip('Händler 01'));
    await user.click(screen.getByRole('button', { name: 'Alle Händler anzeigen (20)' }));
    await user.type(screen.getByRole('searchbox', { name: 'Händler suchen' }), '17');
    expect(shownChips().map((b) => b.textContent)).toEqual(['Händler 01', 'Händler 17']);
    await user.click(chip('Händler 17'));
    await user.click(screen.getByRole('button', { name: 'Weniger anzeigen' }));
    expect(phoneChips().map((b) => b.textContent)).toContain('Händler 17');
    expect(chip('Händler 17').getAttribute('aria-pressed')).toBe('false');
    expect(countLine()).toMatch(/^18 von 20 Belegen/);
    // Switching it back on is the same tap.
    await user.click(chip('Händler 17'));
    expect(countLine()).toMatch(/^19 von 20 Belegen/);
  });

  it('resume: a selection saved and loaded again after a reload brings back the vendors left out', async () => {
    const user = userEvent.setup();
    // The server keeps the definition it is sent and returns it with the list of selections, as the route does.
    let stored: Record<string, unknown> = {};
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: { body: string }) => {
        const body = JSON.parse(init.body);
        stored = body.definition;
        return { ok: true, json: async () => ({ selections: [{ id: 's9', name: body.name, definition: stored }] }) };
      }),
    );
    overview();
    await user.click(chip('Händler 12'));
    await user.type(screen.getByRole('textbox', { name: 'Name der Auswahl' }), 'Ohne Händler 12');
    await user.click(screen.getByRole('button', { name: 'Auswahl speichern' }));
    expect(await screen.findByText('Gespeichert.')).toBeTruthy();
    expect(stored.excludeVendors).toEqual(['Händler 12']);
    cleanup();
    // A reload: a fresh page with the selection as the server hands it back.
    overview([{ id: 's9', name: 'Ohne Händler 12', definition: stored }]);
    expect(countLine()).toMatch(/^20 von 20 Belegen/);
    await user.selectOptions(screen.getByRole('combobox', { name: 'Gespeicherte Auswahl' }), 's9');
    expect(chip('Händler 12').getAttribute('aria-pressed')).toBe('false');
    expect(phoneChips().map((b) => b.textContent)).toContain('Händler 12');
    expect(countLine()).toMatch(/^19 von 20 Belegen/);
  });

  it('resume: a selection saved before (naming the vendors kept) still loads, and a left-out vendor from the folded part shows', async () => {
    const user = userEvent.setup();
    overview([{ id: 's1', name: 'Ohne Kleinkram', definition: { preset: 'all', vendors: VENDORS.filter((v) => v !== 'Händler 20' && v !== 'Händler 02') } }]);
    await user.selectOptions(screen.getByRole('combobox', { name: 'Gespeicherte Auswahl' }), 's1');
    expect(chip('Händler 20').getAttribute('aria-pressed')).toBe('false');
    expect(chip('Händler 02').getAttribute('aria-pressed')).toBe('false');
    expect(countLine()).toMatch(/^18 von 20 Belegen/);
    expect(screen.getByRole('button', { name: '2 Händler ausgeblendet, alle einbeziehen' })).toBeTruthy();
  });

  it('clear: "alle einbeziehen" and "Zurücksetzen" both bring every vendor back', async () => {
    const user = userEvent.setup();
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

  it('leaving out every vendor leaves out every receipt', async () => {
    const user = userEvent.setup();
    render(<OverviewClient invoices={invoices.slice(0, 3)} selections={[]} attribution={{ rules: [], defaultShare: 100 }} notes="" />);
    for (const v of VENDORS.slice(0, 3)) await user.click(chip(v));
    expect(countLine()).toMatch(/^0 von 3 Belegen/);
    expect(screen.getByText('Keine Belege in dieser Auswahl. Den Zeitraum erweitern oder die Filter zurücksetzen.')).toBeTruthy();
  });

  it('says when the search finds no vendor, also while a switched-off vendor stays in the list', async () => {
    const user = userEvent.setup();
    overview();
    await user.click(chip('Händler 05'));
    await user.click(screen.getByRole('button', { name: 'Alle Händler anzeigen (20)' }));
    await user.type(screen.getByRole('searchbox', { name: 'Händler suchen' }), 'gibt es nicht');
    expect(screen.getByText('Kein Händler passt zur Suche.')).toBeTruthy();
    expect(shownChips().map((b) => b.textContent)).toEqual(['Händler 05']);
  });
});

describe('no English anywhere a person reads or hears', () => {
  const ENGLISH = /\b(Save|Saved|Delete|Cancel|Edit|Notes|Reset|Pick|Hide|Apply|Applying|Default|Remove|Vendor|vendors?|invoices?|Selection|Custom|Ledger|Total|Monthly|native|billed|before|attribution|Unknown|failed)\b/;
  /** Every text, label, placeholder and tooltip on the page, as one string. */
  const everything = () =>
    [document.body.textContent ?? '', ...[...document.querySelectorAll('[aria-label],[placeholder],[title]')].flatMap((el) => ['aria-label', 'placeholder', 'title'].map((a) => el.getAttribute(a) ?? ''))].join(' | ');

  it('holds in the first view, with the vendors unfolded and searched, the receipt picker open, the custom range and the notes editor', async () => {
    const user = userEvent.setup();
    overview();
    expect(everything()).not.toMatch(ENGLISH);
    await user.click(screen.getByRole('button', { name: 'Alle Händler anzeigen (20)' }));
    await user.type(screen.getByRole('searchbox', { name: 'Händler suchen' }), 'zz');
    expect(everything()).not.toMatch(ENGLISH);
    await user.click(screen.getByRole('button', { name: /Belege auswählen/ }));
    await user.click(screen.getByRole('button', { name: 'Eigener Zeitraum' }));
    await user.click(screen.getByRole('button', { name: 'Notizen bearbeiten' }));
    expect(everything()).not.toMatch(ENGLISH);
    expect(screen.getByRole('button', { name: 'Notizen speichern' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Anteile speichern' })).toBeTruthy();
    expect(screen.getByRole('textbox', { name: 'Händler 1' })).toBeTruthy();
  });

  it('formats a share and a count the German way', () => {
    const shares = invoices.slice(0, 2).map((inv, i) => ({ ...inv, businessShare: i === 0 ? 50 : 25 }));
    render(<OverviewClient invoices={shares} selections={[]} attribution={{ rules: [], defaultShare: 100 }} notes="" />);
    expect(document.body.textContent).toMatch(/\d+,\d+ % von/);
  });
});
