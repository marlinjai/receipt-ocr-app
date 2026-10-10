// @vitest-environment jsdom
import { useMemo, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SMALL_BUSINESS, meal } from '@/lib/meals/__tests__/fixtures';
import type { MealBatchResult } from '@/lib/meals/batch';
import { incompleteQueue } from '@/lib/meals/register';
import type { MealRecord } from '@/lib/meals/types';

/**
 * The queue's check marks, batch bar and per-entry actions. The server
 * actions are replaced; the list state lives in a small harness that does
 * what the page does with the results, so "the entry leaves the list" and
 * "the last entry gives the empty state" are observed, not assumed.
 */

const markMealsNotMeal = vi.fn();
const deleteMealReceipts = vi.fn();
const restoreMeals = vi.fn();
vi.mock('./actions', () => ({
  saveMeal: vi.fn(),
  createContact: vi.fn(),
  saveReceiptRotation: vi.fn(),
  markMealsNotMeal: (...a: unknown[]) => markMealsNotMeal(...a),
  deleteMealReceipts: (...a: unknown[]) => deleteMealReceipts(...a),
  restoreMeals: (...a: unknown[]) => restoreMeals(...a),
}));
vi.mock('@/components/meals/MealDetailsForm', () => ({
  // Stands in for the form: shows which entry is open and can report unsaved changes, as the form does.
  default: ({ record, onDirtyChange }: { record: MealRecord; onDirtyChange?: (dirty: boolean) => void }) => (
    <div data-testid="form">
      {record.rowId}
      <button type="button" onClick={() => onDirtyChange?.(true)}>Etwas eintippen</button>
    </div>
  ),
}));
vi.mock('@/components/meals/ReceiptViewer', () => ({ default: () => null }));

import QueueTab from './QueueTab';

function open(rowId: string, vendor: string, date: string): MealRecord {
  return meal({ rowId, vendor, name: vendor, date, guests: [], occasion: '' });
}

const THREE = [open('a', 'Lokal A', '2025-01-10'), open('b', 'Lokal B', '2025-02-10'), open('c', 'Lokal C', '2025-03-10')];

function Harness({ initial }: { initial: MealRecord[] }) {
  const [records, setRecords] = useState(initial);
  const queue = useMemo(() => incompleteQueue(records), [records]);
  return (
    <QueueTab
      queue={queue}
      contacts={[]}
      settings={SMALL_BUSINESS}
      defaultHost=""
      onRecordSaved={vi.fn()}
      onRecordsSaved={(saved) => setRecords((list) => list.map((r) => saved.find((s) => s.rowId === r.rowId) ?? r))}
      onRecordsRemoved={(ids) => setRecords((list) => list.filter((r) => !ids.includes(r.rowId)))}
      onContactCreated={vi.fn()}
      onOpenRegister={vi.fn()}
    />
  );
}

function ok(value: Partial<MealBatchResult>) {
  return { ok: true, value: { done: [], records: [], skipped: [], ...value } };
}

/** The row id of the entry whose form is open. */
function openForm() {
  return screen.getByTestId('form').firstChild?.textContent;
}

function box(name: RegExp | string) {
  return screen.getByRole('checkbox', { name }) as HTMLInputElement;
}

beforeEach(() => {
  markMealsNotMeal.mockReset();
  deleteMealReceipts.mockReset();
  restoreMeals.mockReset();
});
afterEach(cleanup);

describe('QueueTab: selection', () => {
  it('each entry has a labelled checkbox; the batch bar appears with the count and goes when nothing is selected', async () => {
    const user = userEvent.setup();
    render(<Harness initial={THREE} />);
    expect(screen.queryByRole('group', { name: 'Aktionen für die Auswahl' })).toBeNull();

    await user.click(box('Lokal A, 10.01.2025 auswählen'));
    const bar = screen.getByRole('group', { name: 'Aktionen für die Auswahl' });
    expect(bar.textContent).toContain('1von 3ausgewählt');
    expect(screen.getByText('1 von 3 ausgewählt')).toBeTruthy();
    expect(within(bar).getByRole('button', { name: 'Keine Bewirtung' })).toBeTruthy();
    expect(within(bar).getByRole('button', { name: 'Löschen' })).toBeTruthy();
    // Announced through a live region that is in the page before the change.
    expect(screen.getByText(/1 Beleg ausgewählt\. Sammelaktionen/).getAttribute('role')).toBe('status');

    await user.click(box('Lokal C, 10.03.2025 auswählen'));
    expect(screen.getByText('2 von 3 ausgewählt')).toBeTruthy();

    await user.click(within(bar).getByRole('button', { name: 'Auswahl aufheben' }));
    expect(screen.queryByRole('group', { name: 'Aktionen für die Auswahl' })).toBeNull();
    expect(box('Lokal A, 10.01.2025 auswählen').checked).toBe(false);
  });

  it('select all checks every entry, is indeterminate when only some are checked, and clears on a second click', async () => {
    const user = userEvent.setup();
    render(<Harness initial={THREE} />);
    const all = box('Alle auswählen');

    await user.click(box('Lokal B, 10.02.2025 auswählen'));
    expect(all.indeterminate).toBe(true);
    expect(all.checked).toBe(false);

    await user.click(all);
    expect(all.checked).toBe(true);
    expect(all.indeterminate).toBe(false);
    expect(screen.getByText('3 von 3 ausgewählt')).toBeTruthy();

    await user.click(all);
    expect(screen.queryByText(/von 3 ausgewählt/)).toBeNull();
  });

  it('checking an entry does not open it, and the checkbox works from the keyboard', async () => {
    const user = userEvent.setup();
    render(<Harness initial={THREE} />);
    expect(openForm()).toBe('a');
    const second = box('Lokal B, 10.02.2025 auswählen');
    second.focus();
    await user.keyboard(' ');
    expect(second.checked).toBe(true);
    expect(openForm()).toBe('a');
  });
});

describe('QueueTab: nothing moves when an entry is checked', () => {
  it('the batch bar appears in a slot that is reserved before anything is checked; the outcome notice floats in the dock', async () => {
    const user = userEvent.setup();
    markMealsNotMeal.mockResolvedValue(ok({ done: ['b'], records: [{ ...THREE[1], mealType: 'not_a_meal' }] }));
    const { container } = render(<Harness initial={THREE} />);
    // The slot is there, empty, under the list and outside the form.
    const slot = container.querySelector('[data-batch-slot]')!;
    expect(slot).toBeTruthy();
    expect(slot.children.length).toBe(0);
    expect(container.querySelector('nav')!.parentElement!.contains(slot)).toBe(true);
    expect(container.querySelector('section[aria-label="Angaben zur Bewirtung"]')!.contains(slot)).toBe(false);

    await user.click(box('Lokal A, 10.01.2025 auswählen'));
    const bar = screen.getByRole('group', { name: 'Aktionen für die Auswahl' });
    expect(slot.contains(bar)).toBe(true);
    expect(container.querySelector('[data-batch-slot]')).toBe(slot);

    await user.click(screen.getByRole('button', { name: 'Keine Bewirtung: Lokal B, 10.02.2025' }));
    const notice = await screen.findByText(/„Lokal B“ wird nicht mehr/);
    expect(document.getElementById('ui-dock')!.contains(notice)).toBe(true);
    expect(container.contains(notice)).toBe(false);
  });

  it('checking an entry changes nothing in the list but the state of that row', async () => {
    const user = userEvent.setup();
    const { container } = render(<Harness initial={THREE} />);
    const snapshot = () =>
      [...container.querySelectorAll('nav li')].map((li) => ({
        children: li.children.length,
        classes: li.className,
        text: li.textContent,
        buttons: li.querySelectorAll('button').length,
      }));
    const toolbarChildren = () => container.querySelector('nav')!.parentElement!.children.length;
    const before = snapshot();
    const columnBefore = toolbarChildren();

    await user.click(box('Lokal A, 10.01.2025 auswählen'));
    expect(snapshot()).toEqual(before);
    expect(toolbarChildren()).toBe(columnBefore);
    expect(container.querySelector('nav li')!.getAttribute('data-checked')).toBe('true');

    await user.click(box('Alle auswählen'));
    expect(snapshot()).toEqual(before);
    expect(toolbarChildren()).toBe(columnBefore);
  });

  it('a row says how much is missing in a few words and keeps the full list for screen readers and the tooltip', () => {
    render(<Harness initial={[open('a', 'Lokal A', '2025-01-10'), { ...open('b', 'Lokal B', '2025-02-10'), occasion: 'Abstimmung Relaunch' }]} />);
    const rows = screen.getAllByRole('listitem');
    expect(rows[0].textContent).toContain('fehlt: Anlass, Teilnehmer');
    expect(rows[1].textContent).toContain('fehlt: Teilnehmer');
  });
});

describe('QueueTab: batch "Keine Bewirtung"', () => {
  it('asks in the page, names the count, says how to undo it, then takes the receipts out of the queue', async () => {
    const user = userEvent.setup();
    markMealsNotMeal.mockResolvedValue(
      ok({ done: ['a', 'b'], records: [{ ...THREE[0], mealType: 'not_a_meal' }, { ...THREE[1], mealType: 'not_a_meal' }] }),
    );
    render(<Harness initial={THREE} />);
    await user.click(box('Lokal A, 10.01.2025 auswählen'));
    await user.click(box('Lokal B, 10.02.2025 auswählen'));
    await user.click(within(screen.getByRole('group', { name: 'Aktionen für die Auswahl' })).getByRole('button', { name: 'Keine Bewirtung' }));

    const dialog = screen.getByRole('dialog', { name: '2 Belege als „Keine Bewirtung“ führen?' });
    expect(within(dialog).getByText(/bleiben aber als normale Belege im Dashboard/)).toBeTruthy();
    expect(within(dialog).getByText(/Das lässt sich rückgängig machen: .*unter „Keine Bewirtung“.*wieder aufnehmen/)).toBeTruthy();
    expect(markMealsNotMeal).not.toHaveBeenCalled();

    await user.click(within(dialog).getByRole('button', { name: 'Keine Bewirtung' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(markMealsNotMeal).toHaveBeenCalledTimes(1);
    expect(markMealsNotMeal).toHaveBeenCalledWith(['a', 'b']);

    expect(screen.queryByRole('checkbox', { name: /Lokal A/ })).toBeNull();
    expect(screen.queryByRole('checkbox', { name: /Lokal B/ })).toBeNull();
    expect(box('Lokal C, 10.03.2025 auswählen').checked).toBe(false);
    expect(screen.queryByRole('group', { name: 'Aktionen für die Auswahl' })).toBeNull();
    const notice = await screen.findByText(/2 Belege werden nicht mehr als Bewirtung geführt/);
    // The bar that held the button is gone: the focus lands on the outcome, not on the page top.
    await waitFor(() => expect(document.activeElement).toBe(notice));
  });

  it('cancelling the dialog changes nothing and keeps the selection', async () => {
    const user = userEvent.setup();
    render(<Harness initial={THREE} />);
    await user.click(box('Lokal A, 10.01.2025 auswählen'));
    await user.click(within(screen.getByRole('group', { name: 'Aktionen für die Auswahl' })).getByRole('button', { name: 'Keine Bewirtung' }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Abbrechen' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(markMealsNotMeal).not.toHaveBeenCalled();
    expect(box('Lokal A, 10.01.2025 auswählen').checked).toBe(true);
  });
});

describe('QueueTab: batch delete', () => {
  it('the dialog names the count and says it cannot be undone; nothing is deleted before the confirmation', async () => {
    const user = userEvent.setup();
    deleteMealReceipts.mockResolvedValue(ok({ done: ['a', 'b', 'c'] }));
    render(<Harness initial={THREE} />);
    await user.click(box('Alle auswählen'));
    await user.click(within(screen.getByRole('group', { name: 'Aktionen für die Auswahl' })).getByRole('button', { name: 'Löschen' }));

    const dialog = screen.getByRole('dialog', { name: '3 Belege endgültig löschen?' });
    expect(within(dialog).getByText('Das kann nicht rückgängig gemacht werden.')).toBeTruthy();
    expect(deleteMealReceipts).not.toHaveBeenCalled();
    // The safe choice has the focus, so Enter does not delete by accident.
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Abbrechen' }));
    // The destructive button looks destructive at rest, not only under the pointer.
    expect(within(dialog).getByRole('button', { name: '3 Belege löschen' }).className).toContain('ui-btn-danger');

    await user.click(within(dialog).getByRole('button', { name: '3 Belege löschen' }));
    await waitFor(() => expect(screen.getByText('Keine offenen Bewirtungen.')).toBeTruthy());
    expect(deleteMealReceipts).toHaveBeenCalledWith(['a', 'b', 'c']);
    // Deleting the last entries: the empty state, with the outcome still on screen and focused.
    const notice = await screen.findByText('3 Belege gelöscht.');
    await waitFor(() => expect(document.activeElement).toBe(notice));
    expect(screen.queryByRole('checkbox')).toBeNull();
  });

  it('one receipt was already deleted in another tab: the rest is deleted, the skipped one is named and leaves the list', async () => {
    const user = userEvent.setup();
    deleteMealReceipts.mockResolvedValue(ok({ done: ['a', 'c'], skipped: [{ rowId: 'b', reason: 'not_found' }] }));
    render(<Harness initial={[...THREE, open('d', 'Lokal D', '2025-04-10')]} />);
    await user.click(box('Lokal A, 10.01.2025 auswählen'));
    await user.click(box('Lokal B, 10.02.2025 auswählen'));
    await user.click(box('Lokal C, 10.03.2025 auswählen'));
    await user.click(within(screen.getByRole('group', { name: 'Aktionen für die Auswahl' })).getByRole('button', { name: 'Löschen' }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: '3 Belege löschen' }));

    const notice = await screen.findByText(/2 Belege gelöscht\. 1 Beleg übersprungen: nicht mehr vorhanden/);
    expect(notice.getAttribute('role')).toBe('status');
    expect(screen.getAllByRole('checkbox', { name: /auswählen$/ }).map((c) => c.getAttribute('aria-label') ?? c.parentElement?.textContent)).toEqual([
      'Alle auswählen',
      'Lokal D, 10.04.2025 auswählen',
    ]);
  });

  it('the stored file could not be deleted: the receipt stays in the list and selected, and the error is an alert', async () => {
    const user = userEvent.setup();
    deleteMealReceipts.mockResolvedValue(ok({ done: ['a'], skipped: [{ rowId: 'b', reason: 'file_delete_failed' }] }));
    render(<Harness initial={THREE} />);
    await user.click(box('Lokal A, 10.01.2025 auswählen'));
    await user.click(box('Lokal B, 10.02.2025 auswählen'));
    await user.click(within(screen.getByRole('group', { name: 'Aktionen für die Auswahl' })).getByRole('button', { name: 'Löschen' }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: '2 Belege löschen' }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('1 Beleg gelöscht.');
    expect(alert.textContent).toContain('ließ sich die gespeicherte Datei nicht löschen');
    expect(screen.queryByRole('checkbox', { name: /Lokal A/ })).toBeNull();
    expect(box('Lokal B, 10.02.2025 auswählen').checked).toBe(true);
    expect(screen.getByText('1 von 2 ausgewählt')).toBeTruthy();
  });

  it('a refused or failed request surfaces as an alert and removes nothing', async () => {
    const user = userEvent.setup();
    deleteMealReceipts.mockResolvedValueOnce({ ok: false, error: 'forbidden' }).mockRejectedValueOnce(new Error('offline'));
    render(<Harness initial={THREE} />);
    await user.click(box('Lokal A, 10.01.2025 auswählen'));
    const bar = () => screen.getByRole('group', { name: 'Aktionen für die Auswahl' });

    await user.click(within(bar()).getByRole('button', { name: 'Löschen' }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Beleg löschen' }));
    expect((await screen.findByRole('alert')).textContent).toContain('fehlt die Berechtigung');
    expect(box('Lokal A, 10.01.2025 auswählen').checked).toBe(true);

    await user.click(within(bar()).getByRole('button', { name: 'Löschen' }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Beleg löschen' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Das hat nicht geklappt'));
    expect(screen.getAllByRole('checkbox')).toHaveLength(4);
  });

  it('a double click on the confirm button sends one request', async () => {
    const user = userEvent.setup();
    let release: (v: unknown) => void = () => {};
    deleteMealReceipts.mockImplementation(() => new Promise((resolve) => (release = resolve)));
    render(<Harness initial={THREE} />);
    await user.click(box('Lokal A, 10.01.2025 auswählen'));
    await user.click(within(screen.getByRole('group', { name: 'Aktionen für die Auswahl' })).getByRole('button', { name: 'Löschen' }));
    const confirm = within(screen.getByRole('dialog')).getByRole('button', { name: 'Beleg löschen' });
    await user.dblClick(confirm);
    expect(deleteMealReceipts).toHaveBeenCalledTimes(1);

    // While it runs: the dialog shows it, and every other action is locked.
    expect(within(screen.getByRole('dialog')).getByRole('button', { name: 'Bitte warten…' })).toHaveProperty('disabled', true);
    expect(screen.getByRole('button', { name: 'Keine Bewirtung: Lokal B, 10.02.2025' })).toHaveProperty('disabled', true);
    expect(box('Lokal B, 10.02.2025 auswählen').disabled).toBe(true);

    release(ok({ done: ['a'] }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(deleteMealReceipts).toHaveBeenCalledTimes(1);
  });
});

describe('QueueTab: actions on a single entry, without opening the form', () => {
  it('"Keine Bewirtung" on an entry acts at once and says where the receipt is found again', async () => {
    const user = userEvent.setup();
    markMealsNotMeal.mockResolvedValue(ok({ done: ['b'], records: [{ ...THREE[1], mealType: 'not_a_meal' }] }));
    render(<Harness initial={THREE} />);
    await user.click(screen.getByRole('button', { name: 'Keine Bewirtung: Lokal B, 10.02.2025' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    const notice = await screen.findByText(/„Lokal B“ wird nicht mehr als Bewirtung geführt\..*unter „Keine Bewirtung“/);
    expect(markMealsNotMeal).toHaveBeenCalledWith(['b']);
    expect(screen.queryByRole('checkbox', { name: /Lokal B/ })).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(notice));
  });

  it('a double click on an entry action sends one request', async () => {
    const user = userEvent.setup();
    let release: (v: unknown) => void = () => {};
    markMealsNotMeal.mockImplementation(() => new Promise((resolve) => (release = resolve)));
    render(<Harness initial={THREE} />);
    await user.dblClick(screen.getByRole('button', { name: 'Keine Bewirtung: Lokal B, 10.02.2025' }));
    expect(markMealsNotMeal).toHaveBeenCalledTimes(1);
    release(ok({ done: ['b'], records: [{ ...THREE[1], mealType: 'not_a_meal' }] }));
    await waitFor(() => expect(screen.queryByRole('checkbox', { name: /Lokal B/ })).toBeNull());
  });

  it('"Löschen" on an entry asks first and names the receipt; deleting the opened entry opens the next one', async () => {
    const user = userEvent.setup();
    deleteMealReceipts.mockResolvedValue(ok({ done: ['a'] }));
    render(<Harness initial={THREE} />);
    expect(openForm()).toBe('a');
    await user.click(screen.getByRole('button', { name: 'Löschen: Lokal A, 10.01.2025' }));
    const dialog = screen.getByRole('dialog', { name: 'Beleg endgültig löschen?' });
    expect(within(dialog).getByText(/„Lokal A“ wird mit der gespeicherten Belegdatei/)).toBeTruthy();
    await user.click(within(dialog).getByRole('button', { name: 'Beleg löschen' }));
    await screen.findByText('„Lokal A“ gelöscht.');
    expect(deleteMealReceipts).toHaveBeenCalledWith(['a']);
    expect(openForm()).toBe('b');
  });

  it('deleting the only entry leads to the empty state', async () => {
    const user = userEvent.setup();
    deleteMealReceipts.mockResolvedValue(ok({ done: ['a'] }));
    render(<Harness initial={[THREE[0]]} />);
    await user.click(screen.getByRole('button', { name: 'Löschen: Lokal A, 10.01.2025' }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Beleg löschen' }));
    expect(await screen.findByText('Keine offenen Bewirtungen.')).toBeTruthy();
    expect(await screen.findByText('„Lokal A“ gelöscht.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Zum Verzeichnis' })).toBeTruthy();
  });

  it('an entry that left the list while it was checked is not part of the next batch', async () => {
    const user = userEvent.setup();
    markMealsNotMeal.mockResolvedValue(ok({ done: ['a'], records: [{ ...THREE[0], mealType: 'not_a_meal' }] }));
    deleteMealReceipts.mockResolvedValue(ok({ done: ['b'] }));
    render(<Harness initial={THREE} />);
    await user.click(box('Lokal A, 10.01.2025 auswählen'));
    await user.click(box('Lokal B, 10.02.2025 auswählen'));
    await user.click(screen.getByRole('button', { name: 'Keine Bewirtung: Lokal A, 10.01.2025' }));
    await screen.findByText(/„Lokal A“ wird nicht mehr/);
    expect(screen.getByText('1 von 2 ausgewählt')).toBeTruthy();
    await user.click(within(screen.getByRole('group', { name: 'Aktionen für die Auswahl' })).getByRole('button', { name: 'Löschen' }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Beleg löschen' }));
    await waitFor(() => expect(deleteMealReceipts).toHaveBeenCalledWith(['b']));
  });
});

describe('QueueTab: unsaved changes in the open form', () => {
  const entry = (name: string) => screen.getByRole('button', { name: new RegExp(`^${name}`) });

  it('opening another entry asks first: staying keeps the form, discarding opens the other entry', async () => {
    const user = userEvent.setup();
    render(<Harness initial={THREE} />);
    await user.click(screen.getByRole('button', { name: 'Etwas eintippen' }));

    await user.click(entry('Lokal B'));
    let dialog = screen.getByRole('dialog', { name: 'Ungespeicherte Änderungen verwerfen?' });
    expect(dialog.textContent).toContain('„Lokal A“');
    await user.click(within(dialog).getByRole('button', { name: 'Weiter bearbeiten' }));
    expect(openForm()).toBe('a');

    await user.click(entry('Lokal B'));
    dialog = screen.getByRole('dialog', { name: 'Ungespeicherte Änderungen verwerfen?' });
    await user.click(within(dialog).getByRole('button', { name: 'Änderungen verwerfen' }));
    expect(openForm()).toBe('b');
  });

  it('without unsaved changes another entry opens at once, and the open entry itself never asks', async () => {
    const user = userEvent.setup();
    render(<Harness initial={THREE} />);
    await user.click(entry('Lokal B'));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(openForm()).toBe('b');
    await user.click(screen.getByRole('button', { name: 'Etwas eintippen' }));
    await user.click(entry('Lokal B'));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('an action that takes the open entry away asks about its unsaved form first; on another entry it runs as before', async () => {
    const user = userEvent.setup();
    markMealsNotMeal.mockResolvedValue(ok({ done: ['b'], records: [{ ...THREE[1], mealType: 'not_a_meal' }] }));
    render(<Harness initial={THREE} />);
    await user.click(screen.getByRole('button', { name: 'Etwas eintippen' }));

    await user.click(screen.getByRole('button', { name: 'Keine Bewirtung: Lokal A, 10.01.2025' }));
    const dialog = screen.getByRole('dialog', { name: 'Ungespeicherte Änderungen verwerfen?' });
    expect(markMealsNotMeal).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole('button', { name: 'Weiter bearbeiten' }));
    expect(markMealsNotMeal).not.toHaveBeenCalled();
    expect(openForm()).toBe('a');

    await user.click(screen.getByRole('button', { name: 'Keine Bewirtung: Lokal B, 10.02.2025' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    await waitFor(() => expect(markMealsNotMeal).toHaveBeenCalledWith(['b']));
    expect(openForm()).toBe('a');
  });
});
