// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { Row, SelectOption } from '@marlinjai/data-table-core';
import { allRows, columnId, columns, group, hotel, licence, orphan, selectOptions } from '@/lib/groups/__tests__/fixture';
import ReceiptPhoneList from './ReceiptPhoneList';

afterEach(cleanup);

/** A receipt's card asks for the select options of what it has, so the questions count the cards drawn. */
function counting() {
  const options = new Map<string, SelectOption[]>(selectOptions);
  return { options, asked: vi.spyOn(options, 'get') };
}

function list(rows: Row[], options: Map<string, SelectOption[]>, onOpenReceipt = vi.fn(), onOpenGroup = vi.fn()) {
  return <ReceiptPhoneList rows={rows} loadedRows={rows} columns={columns} selectOptions={options} loading={false} failed={false} narrowed={false} onOpenReceipt={onOpenReceipt} onOpenGroup={onOpenGroup} />;
}

describe('a change to one receipt on the phone list', () => {
  /** The currency and the category; the fixture's receipts have no status. */
  const OPTIONS_PER_CARD = 2;
  const opened = vi.fn();
  const openedGroup = vi.fn();

  it('redraws its card and leaves the others alone', () => {
    const { options, asked } = counting();
    const { rerender } = render(list(allRows, options, opened, openedGroup));
    asked.mockClear();
    const changed = { ...licence, cells: { ...licence.cells, [columnId('Vendor')]: 'Softwarehaus Neu' } };
    rerender(list(allRows.map((r) => (r === licence ? changed : r)), options, opened, openedGroup));
    expect(asked).toHaveBeenCalledTimes(OPTIONS_PER_CARD);
    expect(screen.getByRole('button', { name: /Softwarehaus Neu/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Taxi Beispiel/ })).toBeTruthy();
  });

  it('draws nothing again for a new list of the same records', () => {
    const { options, asked } = counting();
    const { rerender } = render(list(allRows, options, opened, openedGroup));
    asked.mockClear();
    rerender(list([...allRows], options, opened, openedGroup));
    expect(asked).not.toHaveBeenCalled();
  });

  it('still changes a group whose receipt changed, because its sum did', () => {
    const { options } = counting();
    const { rerender } = render(list(allRows, options, opened, openedGroup));
    const before = screen.getByRole('button', { name: `Gruppe ${group.cells[columnId('Name')]} öffnen` }).textContent;
    const dearer = { ...hotel, cells: { ...hotel.cells, [columnId('EUR Equivalent')]: 5000 } };
    rerender(list(allRows.map((r) => (r === hotel ? dearer : r)), options, opened, openedGroup));
    expect(screen.getByRole('button', { name: `Gruppe ${group.cells[columnId('Name')]} öffnen` }).textContent).not.toBe(before);
  });

  it('opens a card that did not redraw with its own record', () => {
    const { options } = counting();
    const open = vi.fn();
    const { rerender } = render(list(allRows, options, open, openedGroup));
    rerender(list([...allRows], options, open, openedGroup));
    screen.getByRole('button', { name: /Taxi Beispiel/ }).click();
    expect(open).toHaveBeenCalledWith(orphan);
  });
});
