// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Row, SelectOption } from '@marlinjai/data-table-core';
import ReceiptPhoneList, { phoneAmount, phoneDay } from './ReceiptPhoneList';
import { TABLE_ID, allRows, columnId, columns, dinner, emptyGroup, group, hotel, licence, orphan, selectOptions } from '@/lib/groups/__tests__/fixture';
import { filterByYears, formatYearParam, parseYearParam } from '@/lib/receipt-years';

afterEach(cleanup);

const status = (name: string) => ({ id: `opt_status_${name.toLowerCase()}`, columnId: columnId('Status'), name, position: 0 }) as unknown as SelectOption;
const options = new Map<string, SelectOption[]>([...selectOptions, [columnId('Status'), [status('Pending'), status('Processed')]]]);

/** A receipt of another year, in dollars, already processed. Invented, like the fixture. */
const conference: Row = {
  id: 'conference',
  tableId: TABLE_ID,
  archived: false,
  cells: {
    [columnId('Name')]: 'Konferenz',
    [columnId('Vendor')]: 'Conference Example Inc.',
    [columnId('Gross')]: 250,
    [columnId('Date')]: '2025-11-02T00:00:00.000Z',
    [columnId('Currency')]: 'opt_usd',
    [columnId('Status')]: 'opt_status_processed',
  },
} as unknown as Row;

function list(overrides: Partial<Parameters<typeof ReceiptPhoneList>[0]> = {}) {
  const props = {
    rows: allRows,
    columns,
    selectOptions: options,
    loading: false,
    narrowed: false,
    onOpenReceipt: vi.fn(),
    onOpenGroup: vi.fn(),
    ...overrides,
  };
  const view = render(<ReceiptPhoneList {...props} />);
  return { props, view };
}

const cards = () => within(screen.getByRole('list', { name: 'Belege' })).getAllByRole('button');

describe('the receipts list on a phone', () => {
  it('shows one card per receipt and per group, newest first, the receipts of a group inside its card', () => {
    list();
    const labels = cards().map((c) => c.getAttribute('aria-label'));
    // hotel and dinner lie in the group "Messe": not repeated at the top level. The empty group has no date: last.
    expect(labels).toEqual([
      'Beleg Taxi Beispiel vom 13.03.2026 öffnen',
      'Beleg Softwarehaus Beispiel vom 12.03.2026 öffnen',
      'Gruppe Messe öffnen',
      'Gruppe Leere Gruppe öffnen',
    ]);
    expect(screen.queryByText('Hotel Nordlicht')).toBeNull();
    expect(screen.queryByText('Gasthaus Linde')).toBeNull();
  });

  it('shows vendor, date, amount and category of a receipt, and a group with the sum of its receipts, never its own amount', () => {
    list();
    const receipt = cards()[1];
    expect(receipt.textContent).toContain('Softwarehaus Beispiel');
    expect(receipt.textContent).toContain('12.03.2026');
    expect(receipt.textContent).toContain('Software');
    expect(receipt.textContent).toMatch(/10,00\s€/);
    const messe = cards()[2];
    expect(messe.textContent).toMatch(/140,00\s€/);
    expect(messe.textContent).toContain('2 Belege');
    expect(messe.textContent).not.toContain('999');
  });

  it('opens a receipt in the detail panel and a group in the group panel', async () => {
    const user = userEvent.setup();
    const { props } = list();
    await user.click(screen.getByRole('button', { name: 'Beleg Softwarehaus Beispiel vom 12.03.2026 öffnen' }));
    expect(props.onOpenReceipt).toHaveBeenCalledWith(licence);
    await user.click(screen.getByRole('button', { name: 'Gruppe Messe öffnen' }));
    expect(props.onOpenGroup).toHaveBeenCalledWith(group);
    expect(props.onOpenReceipt).toHaveBeenCalledTimes(1);
  });

  it('shows the status, an amount in its own currency, and says when a receipt has no amount', () => {
    const noAmount = { ...orphan, id: 'noAmount', cells: { ...orphan.cells, [columnId('Gross')]: '' } } as Row;
    list({ rows: [conference, noAmount] });
    const [taxi, usd] = cards();
    expect(usd.textContent).toContain('Processed');
    expect(usd.textContent).toMatch(/250,00\s\$/);
    expect(taxi.textContent).toContain('kein Betrag');
  });

  it('follows a change of the filter: fewer rows given, fewer cards, and back', () => {
    const { props, view } = list({ rows: [...allRows, conference] });
    expect(cards()).toHaveLength(5);
    const only2025 = filterByYears(props.rows, columns, { years: new Set([2025]), undated: false });
    view.rerender(<ReceiptPhoneList {...props} rows={only2025} narrowed />);
    expect(cards().map((c) => c.getAttribute('aria-label'))).toEqual(['Beleg Conference Example Inc. vom 02.11.2025 öffnen']);
    view.rerender(<ReceiptPhoneList {...props} />);
    expect(cards()).toHaveLength(5);
  });

  it('resumes from the address: the years named in the link give the same cards after a reload', () => {
    const rows = [...allRows, conference];
    const chosen = { years: new Set([2026]), undated: true };
    const param = formatYearParam(chosen);
    // What the page reads back from `?jahre=` after a reload.
    const restored = parseYearParam(param);
    list({ rows: filterByYears(rows, columns, restored), narrowed: true });
    expect(param).toBe('2026,ohne');
    // The 2025 receipt stays out; a group shows when one of its receipts is shown, so the empty group does not.
    expect(cards().map((c) => c.getAttribute('aria-label'))).toEqual([
      'Beleg Taxi Beispiel vom 13.03.2026 öffnen',
      'Beleg Softwarehaus Beispiel vom 12.03.2026 öffnen',
      'Gruppe Messe öffnen',
    ]);
  });

  it('says there are no receipts yet and offers the upload, with nothing chosen', () => {
    list({ rows: [] });
    expect(screen.getByText('Noch keine Belege.')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Beleg hochladen' }).getAttribute('href')).toBe('/app');
  });

  it('says why the list is empty when a search, filter or year choice narrows it, without offering an upload', () => {
    list({ rows: [], narrowed: true });
    expect(screen.getByText('Keine Belege für diese Auswahl.')).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Beleg hochladen' })).toBeNull();
  });

  it('says the receipts are loading instead of calling the list empty while the first rows are on their way', () => {
    list({ rows: [], loading: true });
    expect(screen.getByRole('status').textContent).toContain('Belege werden geladen');
    expect(screen.queryByText('Noch keine Belege.')).toBeNull();
  });

  it('keeps the receipts that are already there while more load', () => {
    list({ rows: [licence], loading: true });
    expect(cards()).toHaveLength(1);
    expect(screen.queryByRole('status')).toBeNull();
  });
});

describe('the phone list formats', () => {
  it('reads a date as the person writes it, in UTC, and nothing for no date', () => {
    expect(phoneDay('2026-03-12T00:00:00.000Z')).toBe('12.03.2026');
    expect(phoneDay('2026-01-01')).toBe('01.01.2026');
    expect(phoneDay('')).toBe('');
    expect(phoneDay('kein Datum')).toBe('');
  });

  it('shows an amount in its currency, the bare number without a known code, and nothing for no amount', () => {
    expect(phoneAmount(10, 'EUR')).toMatch(/10,00\s€/);
    expect(phoneAmount('1234.5', 'USD')).toMatch(/1\.234,50\s\$/);
    expect(phoneAmount(7, '')).toBe('7,00');
    expect(phoneAmount(null, 'EUR')).toBe('');
    expect(phoneAmount('abc', 'EUR')).toBe('');
  });

  it('keeps the group fixture honest: hotel and dinner are the receipts of the group, the empty group has none', () => {
    expect([hotel.parentRowId, dinner.parentRowId]).toEqual(['group', 'group']);
    expect(emptyGroup.parentRowId).toBeUndefined();
  });
});
