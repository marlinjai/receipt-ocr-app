// @vitest-environment jsdom
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Contact } from '@/lib/contacts/store';
import { GUEST_A, SMALL_BUSINESS, UNANSWERED, meal } from '@/lib/meals/__tests__/fixtures';
import type { MealDetailsInput } from '@/lib/meals/input';
import { incompleteQueue } from '@/lib/meals/register';
import type { MealRecord } from '@/lib/meals/types';
import ConfirmDialog from '@/components/ui/ConfirmDialog';

const saveMealTaxSettings = vi.fn();
const markMealsNotMeal = vi.fn();
const deleteMealReceipts = vi.fn();
const saveMeal = vi.fn();
const createContact = vi.fn();
vi.mock('./actions', () => ({
  saveMealTaxSettings: (...a: unknown[]) => saveMealTaxSettings(...a),
  markMealsNotMeal: (...a: unknown[]) => markMealsNotMeal(...a),
  deleteMealReceipts: (...a: unknown[]) => deleteMealReceipts(...a),
  restoreMeals: vi.fn(),
  saveMeal: (...a: unknown[]) => saveMeal(...a),
  createContact: (...a: unknown[]) => createContact(...a),
  saveReceiptRotation: vi.fn(),
}));
// The form is the real one; the receipt beside it only reports which receipt it shows.
vi.mock('@/components/meals/ReceiptViewer', () => ({
  default: ({ files }: { files: unknown[] }) => <div data-testid="receipt">{files.length} Datei</div>,
}));

import RegisterTab from './RegisterTab';

const fetchMock = vi.fn();
const records = [
  meal({ rowId: 'a' }),
  meal({ rowId: 'b', date: '2025-08-01', guests: [] }),
  meal({ rowId: 'c', date: '2025-09-01', mealType: 'travel_meal', gross: 20 }),
];

beforeEach(() => {
  fetchMock.mockReset();
  saveMealTaxSettings.mockReset();
  markMealsNotMeal.mockReset();
  deleteMealReceipts.mockReset();
  saveMeal.mockReset();
  createContact.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  URL.createObjectURL = vi.fn(() => 'blob:test');
  URL.revokeObjectURL = vi.fn();
  // jsdom does not implement navigation; a download click must not throw.
  HTMLAnchorElement.prototype.click = vi.fn();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** What the editor needs; these tests do not open it. */
const EDITOR_PROPS = { contacts: [] as Contact[], defaultHost: '', onRecordSaved: vi.fn(), onContactCreated: vi.fn() };

function file(headers: Record<string, string> = {}) {
  return new Response('x', { status: 200, headers });
}

describe('RegisterTab: section 19 question', () => {
  it('unanswered: asks the question, lists the entry without amounts, locks both exports', async () => {
    const onSettingsChanged = vi.fn();
    render(<RegisterTab records={records} settings={UNANSWERED} onSettingsChanged={onSettingsChanged} onRecordsSaved={vi.fn()} onRecordsRemoved={vi.fn()} onOpenQueue={vi.fn()} {...EDITOR_PROPS} />);
    expect(screen.getByRole('heading', { name: /Kleinunternehmer nach § 19/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Als CSV exportieren' })).toHaveProperty('disabled', true);
    expect(screen.getByRole('button', { name: 'Als PDF exportieren' })).toHaveProperty('disabled', true);
    const table = screen.getByRole('table');
    expect(within(table).getByText('Testlokal, Musterstraße 1, 12345 Musterstadt')).toBeTruthy();
    expect(within(table).queryByText(/€/)).toBeNull();
    expect(within(table).queryByText('Summe')).toBeNull();

    saveMealTaxSettings.mockResolvedValue({ ok: true, value: SMALL_BUSINESS });
    await userEvent.setup().click(screen.getByRole('button', { name: 'Ja, Kleinunternehmer' }));
    expect(saveMealTaxSettings).toHaveBeenCalledWith({ smallBusiness: true });
    expect(onSettingsChanged).toHaveBeenCalledWith(SMALL_BUSINESS);
  });

  it('a failed answer is shown and nothing changes', async () => {
    const onSettingsChanged = vi.fn();
    render(<RegisterTab records={records} settings={UNANSWERED} onSettingsChanged={onSettingsChanged} onRecordsSaved={vi.fn()} onRecordsRemoved={vi.fn()} onOpenQueue={vi.fn()} {...EDITOR_PROPS} />);
    saveMealTaxSettings.mockResolvedValue({ ok: false, error: 'forbidden' });
    await userEvent.setup().click(screen.getByRole('button', { name: 'Nein, mit Vorsteuerabzug' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/Berechtigung/);
    expect(onSettingsChanged).not.toHaveBeenCalled();
  });

  it('answered: shows totals, the incomplete block and the separate count', () => {
    render(<RegisterTab records={records} settings={SMALL_BUSINESS} onSettingsChanged={vi.fn()} onRecordsSaved={vi.fn()} onRecordsRemoved={vi.fn()} onOpenQueue={vi.fn()} {...EDITOR_PROPS} />);
    expect(screen.queryByRole('heading', { name: /Kleinunternehmer nach § 19/ })).toBeNull();
    const table = screen.getByRole('table');
    expect(within(table).getByText('Summe')).toBeTruthy();
    expect(within(table).getAllByText(/91,00/).length).toBeGreaterThan(0);
    expect(screen.getByText(/1 Bewirtung aus 2025 ist unvollständig und zählt nicht mit/)).toBeTruthy();
    expect(screen.getByText(/Verpflegung auf Reise: 1/)).toBeTruthy();
  });
});

describe('RegisterTab: export', () => {
  function mount() {
    render(<RegisterTab records={records} settings={SMALL_BUSINESS} onSettingsChanged={vi.fn()} onRecordsSaved={vi.fn()} onRecordsRemoved={vi.fn()} onOpenQueue={vi.fn()} {...EDITOR_PROPS} />);
    return userEvent.setup();
  }

  it('with incomplete entries: confirms with the count the server reports, then exports acknowledging exactly it', async () => {
    const user = mount();
    fetchMock
      .mockResolvedValueOnce(Response.json({ error: 'incomplete_unacknowledged', incompleteCount: 1 }, { status: 409 }))
      .mockResolvedValueOnce(file());
    await user.click(screen.getByRole('button', { name: 'Als CSV exportieren' }));

    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toMatch(/1 Bewirtung aus 2025 ist unvollständig/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toBe('/api/meals/register?year=2025&format=csv');

    await user.click(within(dialog).getByRole('button', { name: 'Trotzdem exportieren' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(String(fetchMock.mock.calls[1][0])).toBe('/api/meals/register?year=2025&format=csv&ack=1');
    await waitFor(() => expect(HTMLAnchorElement.prototype.click).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('cancelling the confirmation exports nothing', async () => {
    const user = mount();
    fetchMock.mockResolvedValueOnce(Response.json({ error: 'incomplete_unacknowledged', incompleteCount: 1 }, { status: 409 }));
    await user.click(screen.getByRole('button', { name: 'Als PDF exportieren' }));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Zurück' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(HTMLAnchorElement.prototype.click).not.toHaveBeenCalled();
  });

  it('shows the warnings the PDF export reports (for example a receipt that could not be embedded)', async () => {
    const user = mount();
    fetchMock.mockResolvedValueOnce(
      file({ 'X-Register-Warnings': encodeURIComponent(JSON.stringify(['Nr. 1: Es ist kein Beleg hinterlegt.'])) }),
    );
    await user.click(screen.getByRole('button', { name: 'Als PDF exportieren' }));
    expect(await screen.findByText('Nr. 1: Es ist kein Beleg hinterlegt.')).toBeTruthy();
  });

  it('a server error and a dead connection each produce a visible message, never a silent nothing', async () => {
    const user = mount();
    fetchMock.mockResolvedValueOnce(Response.json({ error: 'export_failed' }, { status: 500 }));
    await user.click(screen.getByRole('button', { name: 'Als CSV exportieren' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/fehlgeschlagen/);
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await user.click(screen.getByRole('button', { name: 'Als CSV exportieren' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/keine Verbindung/));
    expect(HTMLAnchorElement.prototype.click).not.toHaveBeenCalled();
  });

  it('an expired session says so', async () => {
    const user = mount();
    fetchMock.mockResolvedValueOnce(Response.json({ error: 'unauthorized' }, { status: 401 }));
    await user.click(screen.getByRole('button', { name: 'Als CSV exportieren' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/Anmeldung ist abgelaufen/);
  });
});

describe('ConfirmDialog', () => {
  it('is modal, focuses the safe choice, closes on Escape and returns focus', async () => {
    const onCancel = vi.fn();
    const onConfirm = vi.fn();
    const user = userEvent.setup();
    function Harness({ open }: { open: boolean }) {
      return (
        <>
          <button>Auslöser</button>
          <ConfirmDialog open={open} title="Wirklich?" confirmLabel="Ja" onCancel={onCancel} onConfirm={onConfirm}>
            Text
          </ConfirmDialog>
        </>
      );
    }
    const { rerender } = render(<Harness open={false} />);
    const trigger = screen.getByRole('button', { name: 'Auslöser' });
    trigger.focus();
    rerender(<Harness open />);
    const dialog = screen.getByRole('dialog');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Abbrechen' }));
    // Focus stays inside the dialog.
    await user.tab();
    await user.tab();
    expect(dialog.contains(document.activeElement)).toBe(true);
    await user.keyboard('{Escape}');
    expect(onCancel).toHaveBeenCalledTimes(1);
    await user.click(within(dialog).getByRole('button', { name: 'Ja' }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    rerender(<Harness open={false} />);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
});

describe('RegisterTab: actions on a register entry', () => {
  function Stateful() {
    const [list, setList] = useState(records);
    return (
      <RegisterTab
        records={list}
        settings={SMALL_BUSINESS}
        onSettingsChanged={vi.fn()}
        onRecordsSaved={(saved) => setList((l) => l.map((r) => saved.find((x) => x.rowId === r.rowId) ?? r))}
        onRecordsRemoved={(ids) => setList((l) => l.filter((r) => !ids.includes(r.rowId)))}
        onOpenQueue={vi.fn()}
        {...EDITOR_PROPS}
      />
    );
  }

  it('"Keine Bewirtung" always asks first on a complete entry, then the entry leaves the register and its totals', async () => {
    const user = userEvent.setup();
    markMealsNotMeal.mockResolvedValue({
      ok: true,
      value: { done: ['a'], records: [{ ...records[0], mealType: 'not_a_meal' }], skipped: [] },
    });
    render(<Stateful />);
    expect(within(screen.getByRole('table')).getByText('Summe')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: /^Keine Bewirtung: Nr\. 1, Testlokal/ }));
    const dialog = screen.getByRole('dialog', { name: 'Beleg als „Keine Bewirtung“ führen?' });
    expect(within(dialog).getByText(/Das lässt sich rückgängig machen/)).toBeTruthy();
    expect(markMealsNotMeal).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole('button', { name: 'Keine Bewirtung' }));

    const notice = await screen.findByText(/„Testlokal“ wird nicht mehr als Bewirtung geführt/);
    expect(markMealsNotMeal).toHaveBeenCalledWith(['a']);
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.getByText('Für 2025 gibt es noch keine vollständige Bewirtung.')).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(notice));
  });

  it('"Löschen" names the entry, says it cannot be undone, and removes it after the confirmation', async () => {
    const user = userEvent.setup();
    deleteMealReceipts.mockResolvedValue({ ok: true, value: { done: ['a'], records: [], skipped: [] } });
    render(<Stateful />);
    await user.click(screen.getByRole('button', { name: /^Löschen: Nr\. 1, Testlokal/ }));
    const dialog = screen.getByRole('dialog', { name: 'Beleg endgültig löschen?' });
    expect(within(dialog).getByText('Das kann nicht rückgängig gemacht werden.')).toBeTruthy();
    await user.click(within(dialog).getByRole('button', { name: 'Abbrechen' }));
    expect(deleteMealReceipts).not.toHaveBeenCalled();
    expect(screen.getByRole('table')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: /^Löschen: Nr\. 1, Testlokal/ }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Beleg löschen' }));
    await screen.findByText('„Testlokal“ gelöscht.');
    expect(deleteMealReceipts).toHaveBeenCalledWith(['a']);
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('a failed delete of the stored file keeps the entry and shows the error', async () => {
    const user = userEvent.setup();
    deleteMealReceipts.mockResolvedValue({
      ok: true,
      value: { done: [], records: [], skipped: [{ rowId: 'a', reason: 'file_delete_failed' }] },
    });
    render(<Stateful />);
    await user.click(screen.getByRole('button', { name: /^Löschen: Nr\. 1, Testlokal/ }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Beleg löschen' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Es wurde kein Beleg gelöscht.');
    expect(alert.textContent).toContain('ließ sich die gespeicherte Datei nicht löschen');
    expect(screen.getByRole('table')).toBeTruthy();
  });
});

describe('RegisterTab: editing a register entry', () => {
  const CONTACTS: Contact[] = [
    { id: 'c-1', name: 'Erika Beispiel', companyOrRole: 'Beispiel GmbH', note: null, archived: false },
    { id: 'c-2', name: 'Max Muster', companyOrRole: 'Muster AG', note: null, archived: false },
  ];
  const FIRST = meal({ rowId: 'a', files: [{ refId: 'ref-1', fileId: 'file-1', fileUrl: '/files/file-1', mimeType: 'application/pdf', originalName: 'beleg.pdf', rotation: null }] });
  const SECOND = meal({
    rowId: 'b',
    vendor: 'Zweitlokal',
    name: 'Abendessen Zweitlokal',
    date: '2025-05-02',
    place: 'Zweitlokal, Beispielweg 2, 54321 Beispielstadt',
    occasion: 'Jahresplanung Messeauftritt',
    gross: 50,
    tip: null,
  });

  /** A save that behaves like the server: stores the input on the record it was sent for. */
  function serverFor(list: MealRecord[]) {
    return async (rowId: string, input: MealDetailsInput) => {
      const record = list.find((r) => r.rowId === rowId)!;
      const guests = input.guestContactIds.map((id) => {
        const c = CONTACTS.find((x) => x.id === id)!;
        return { contactId: c.id, name: c.name, company: c.companyOrRole };
      });
      return {
        ok: true,
        value: { changed: true, record: { ...record, ...input, date: input.date ?? record.date, gross: input.gross ?? record.gross, guests } },
      };
    };
  }

  /** Does with a saved record what the page does, and shows how many meals are in the queue. */
  function Page({ initial = [FIRST, SECOND] }: { initial?: MealRecord[] }) {
    const [list, setList] = useState(initial);
    const replace = (saved: MealRecord[]) => setList((l) => l.map((r) => saved.find((x) => x.rowId === r.rowId) ?? r));
    return (
      <>
        <p data-testid="queue-count">{incompleteQueue(list).length}</p>
        <RegisterTab
          records={list}
          contacts={CONTACTS}
          settings={SMALL_BUSINESS}
          defaultHost="Inhaber Beispiel"
          onSettingsChanged={vi.fn()}
          onRecordSaved={(record) => replace([record])}
          onRecordsSaved={replace}
          onRecordsRemoved={(ids) => setList((l) => l.filter((r) => !ids.includes(r.rowId)))}
          onContactCreated={vi.fn()}
          onOpenQueue={vi.fn()}
        />
      </>
    );
  }

  const editButton = (no: number) => screen.getByRole('button', { name: new RegExp(`^Bearbeiten: Nr\\. ${no},`) });
  const editor = () => screen.getByRole('region', { name: 'Angaben zur Bewirtung' });
  const field = (name: string) => within(editor()).getByLabelText(name) as HTMLInputElement;
  const rowOf = (text: string) => within(screen.getByRole('table')).getByText(text).closest('tr')!;

  beforeEach(() => {
    saveMeal.mockImplementation(serverFor([FIRST, SECOND]));
  });

  it('"Bearbeiten" opens the queue form with the stored values and the receipt, marks the row, and moves the focus in', async () => {
    const user = userEvent.setup();
    render(<Page />);
    expect(screen.queryByRole('region', { name: 'Angaben zur Bewirtung' })).toBeNull();

    await user.click(editButton(1));
    const heading = within(editor()).getByRole('heading', { name: 'Nr. 1 bearbeiten: Mittagessen Testlokal' });
    await waitFor(() => expect(document.activeElement).toBe(heading));
    expect(field('Anlass').value).toBe('Abstimmung Relaunch Webshop, Angebot Phase 2');
    expect(field('Ort (Name und Anschrift)').value).toBe('Testlokal, Musterstraße 1, 12345 Musterstadt');
    expect(field('Gastgeber').value).toBe('Inhaber Beispiel');
    expect(field('Trinkgeld').value).toBe('11,00');
    expect(within(editor()).getByRole('button', { name: 'Geschäftsessen (extern)' }).getAttribute('aria-pressed')).toBe('true');
    expect(within(editor()).getByRole('button', { name: `${GUEST_A.name} entfernen` })).toBeTruthy();
    expect(within(editor()).getByTestId('receipt').textContent).toBe('1 Datei');

    // Recognisable without colour: the row is the current one and its button says so.
    const row = rowOf('Testlokal, Musterstraße 1, 12345 Musterstadt');
    expect(row.getAttribute('aria-current')).toBe('true');
    expect(row.getAttribute('data-editing')).toBe('true');
    const marked = within(row).getByRole('button', { name: /^Wird bearbeitet: Nr\. 1,/ });
    expect(marked.getAttribute('aria-expanded')).toBe('true');
    expect(marked.getAttribute('aria-controls')).toBe(editor().id);
    expect(rowOf('Zweitlokal, Beispielweg 2, 54321 Beispielstadt').getAttribute('aria-current')).toBeNull();
    expect(screen.getAllByRole('region', { name: 'Angaben zur Bewirtung' })).toHaveLength(1);
  });

  it('a save shows the new values and totals in the table at once, closes the form and returns the focus to the row', async () => {
    const user = userEvent.setup();
    render(<Page />);
    const table = screen.getByRole('table');
    // 119 + 11 tip, and 50: 70 % of 180.
    expect(within(table).getByText(/126,00/)).toBeTruthy();

    await user.click(editButton(1));
    await user.clear(field('Anlass'));
    await user.type(field('Anlass'), 'Abnahme Fotoproduktion Herbst');
    await user.clear(field('Trinkgeld'));
    await user.type(field('Trinkgeld'), '21');
    await user.type(within(editor()).getByRole('combobox'), 'Max');
    await user.click(within(editor()).getByRole('option', { name: /Max Muster/ }));
    await user.click(within(editor()).getByRole('button', { name: 'Speichern' }));

    await waitFor(() => expect(screen.queryByRole('region', { name: 'Angaben zur Bewirtung' })).toBeNull());
    expect(saveMeal).toHaveBeenCalledTimes(1);
    expect(saveMeal.mock.calls[0][0]).toBe('a');
    expect(saveMeal.mock.calls[0][1]).toMatchObject({ occasion: 'Abnahme Fotoproduktion Herbst', tip: 21, guestContactIds: ['c-1', 'c-2'] });
    expect(within(table).getByText('Abnahme Fotoproduktion Herbst')).toBeTruthy();
    expect(within(table).getByText('Erika Beispiel (Beispiel GmbH), Max Muster (Muster AG)')).toBeTruthy();
    // The tip, in its row and in the totals.
    expect(within(table).getAllByText(/^21,00/)).toHaveLength(2);
    // 119 + 21 tip, and 50: 70 % of 190.
    expect(within(table).getByText(/133,00/)).toBeTruthy();
    expect(screen.getByText('„Testlokal“: gespeichert.').getAttribute('role')).toBe('status');
    await waitFor(() => expect(document.activeElement).toBe(editButton(1)));
    expect(screen.getByTestId('queue-count').textContent).toBe('0');
  });

  it('an edit that removes the last guest is saved, takes the entry out of the register into the queue, and says so in one sentence', async () => {
    const user = userEvent.setup();
    render(<Page />);
    await user.click(editButton(1));
    await user.click(within(editor()).getByRole('button', { name: `${GUEST_A.name} entfernen` }));
    await user.click(within(editor()).getByRole('button', { name: 'Speichern' }));

    const notice = await screen.findByText(
      '„Testlokal“ ist jetzt unvollständig (es fehlt: Teilnehmer) und steht deshalb nicht mehr im Verzeichnis, sondern unter „Unvollständig“.',
    );
    expect(saveMeal.mock.calls[0][1]).toMatchObject({ guestContactIds: [] });
    expect(screen.queryByRole('region', { name: 'Angaben zur Bewirtung' })).toBeNull();
    const table = screen.getByRole('table');
    expect(within(table).queryByText('Testlokal, Musterstraße 1, 12345 Musterstadt')).toBeNull();
    // Only the second entry counts now: 70 % of 50.
    expect(within(table).getAllByText(/35,00/).length).toBeGreaterThan(0);
    expect(screen.getByTestId('queue-count').textContent).toBe('1');
    expect(screen.getByText(/1 Bewirtung aus 2025 ist unvollständig und zählt nicht mit/)).toBeTruthy();
    // Its row and button are gone, so the notice holds the focus.
    await waitFor(() => expect(document.activeElement).toBe(notice));
  });

  it('an occasion changed to a generic word is not refused: the entry is saved and moves to the queue', async () => {
    const user = userEvent.setup();
    render(<Page />);
    await user.click(editButton(2));
    await user.clear(field('Anlass'));
    await user.type(field('Anlass'), 'Geschäftsessen');
    await user.click(within(editor()).getByRole('button', { name: 'Speichern' }));
    expect(await screen.findByText(/„Zweitlokal“ ist jetzt unvollständig \(es fehlt: Anlass \(zu allgemein\)\)/)).toBeTruthy();
    expect(saveMeal).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('queue-count').textContent).toBe('1');
  });

  it('a date moved to another year says which register the entry is in now', async () => {
    const user = userEvent.setup();
    render(<Page />);
    await user.click(editButton(2));
    await user.clear(field('Datum'));
    await user.type(field('Datum'), '2024-05-02');
    await user.click(within(editor()).getByRole('button', { name: 'Speichern' }));
    expect(await screen.findByText('„Zweitlokal“ steht jetzt im Verzeichnis 2024.')).toBeTruthy();
    expect(within(screen.getByRole('table')).queryByText('Jahresplanung Messeauftritt')).toBeNull();
  });

  it('"Abbrechen" discards the changes, returns to the table and puts the focus back on the row', async () => {
    const user = userEvent.setup();
    render(<Page />);
    await user.click(editButton(1));
    await user.clear(field('Anlass'));
    await user.type(field('Anlass'), 'Verworfener Anlass');
    await user.click(within(editor()).getByRole('button', { name: 'Abbrechen' }));

    expect(screen.queryByRole('region', { name: 'Angaben zur Bewirtung' })).toBeNull();
    expect(saveMeal).not.toHaveBeenCalled();
    expect(within(screen.getByRole('table')).getByText('Abstimmung Relaunch Webshop, Angebot Phase 2')).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(editButton(1)));
    // Opened again, the form shows what is stored, not the discarded draft.
    await user.click(editButton(1));
    expect(field('Anlass').value).toBe('Abstimmung Relaunch Webshop, Angebot Phase 2');
  });

  it('opening another row with unsaved changes asks first: staying keeps the draft, discarding opens the other entry', async () => {
    const user = userEvent.setup();
    render(<Page />);
    await user.click(editButton(1));
    await user.clear(field('Anlass'));
    await user.type(field('Anlass'), 'Noch nicht gespeichert');

    await user.click(editButton(2));
    let dialog = screen.getByRole('dialog', { name: 'Ungespeicherte Änderungen verwerfen?' });
    expect(dialog.textContent).toContain('Nr. 1 (Mittagessen Testlokal)');
    await user.click(within(dialog).getByRole('button', { name: 'Weiter bearbeiten' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(field('Anlass').value).toBe('Noch nicht gespeichert');
    expect(within(editor()).getByRole('heading').textContent).toContain('Nr. 1 bearbeiten');

    await user.click(editButton(2));
    dialog = screen.getByRole('dialog', { name: 'Ungespeicherte Änderungen verwerfen?' });
    await user.click(within(dialog).getByRole('button', { name: 'Änderungen verwerfen' }));
    const heading = within(editor()).getByRole('heading', { name: 'Nr. 2 bearbeiten: Abendessen Zweitlokal' });
    expect(field('Anlass').value).toBe('Jahresplanung Messeauftritt');
    await waitFor(() => expect(document.activeElement).toBe(heading));
    expect(screen.getAllByRole('region', { name: 'Angaben zur Bewirtung' })).toHaveLength(1);
    expect(saveMeal).not.toHaveBeenCalled();
  });

  it('without unsaved changes another row opens at once, and only one entry is ever open', async () => {
    const user = userEvent.setup();
    render(<Page />);
    await user.click(editButton(1));
    await user.click(editButton(2));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(within(editor()).getByRole('heading').textContent).toContain('Nr. 2 bearbeiten');
    expect(screen.getAllByRole('region', { name: 'Angaben zur Bewirtung' })).toHaveLength(1);
  });

  it('Escape cancels from the keyboard: at once when nothing changed, after asking when something did', async () => {
    const user = userEvent.setup();
    render(<Page />);
    // Reached and opened by keyboard alone.
    editButton(1).focus();
    await user.keyboard('{Enter}');
    await waitFor(() => expect(document.activeElement).toBe(within(editor()).getByRole('heading')));
    await user.tab();
    expect(editor().contains(document.activeElement)).toBe(true);
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('region', { name: 'Angaben zur Bewirtung' })).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(editButton(1)));

    await user.keyboard('{Enter}');
    await user.type(field('Gastgeber'), ' und Partner');
    await user.keyboard('{Escape}');
    const dialog = screen.getByRole('dialog', { name: 'Ungespeicherte Änderungen verwerfen?' });
    // Escape in the dialog is the safe choice: it keeps the draft.
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(field('Gastgeber').value).toBe('Inhaber Beispiel und Partner');
    expect(dialog.isConnected).toBe(false);

    field('Gastgeber').focus();
    await user.keyboard('{Escape}');
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Änderungen verwerfen' }));
    expect(screen.queryByRole('region', { name: 'Angaben zur Bewirtung' })).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(editButton(1)));
    expect(saveMeal).not.toHaveBeenCalled();
  });

  it('changing the year with unsaved changes asks first too', async () => {
    const user = userEvent.setup();
    render(<Page initial={[FIRST, SECOND, meal({ rowId: 'old', date: '2024-02-01' })]} />);
    await user.click(editButton(1));
    await user.type(field('Gastgeber'), ' und Partner');
    await user.selectOptions(screen.getByLabelText('Jahr'), '2024');
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Weiter bearbeiten' }));
    expect((screen.getByLabelText('Jahr') as HTMLSelectElement).value).toBe('2025');
    expect(field('Gastgeber').value).toBe('Inhaber Beispiel und Partner');
  });

  it('a refused save and a dead connection are shown in the form, which stays open with the draft', async () => {
    const user = userEvent.setup();
    render(<Page />);
    await user.click(editButton(1));
    await user.clear(field('Anlass'));
    await user.type(field('Anlass'), 'Abnahme Fotoproduktion Herbst');

    saveMeal.mockResolvedValueOnce({ ok: false, error: 'forbidden' });
    await user.click(within(editor()).getByRole('button', { name: 'Speichern' }));
    expect((await within(editor()).findByRole('alert')).textContent).toMatch(/Berechtigung/);
    expect(field('Anlass').value).toBe('Abnahme Fotoproduktion Herbst');
    expect(within(screen.getByRole('table')).getByText('Abstimmung Relaunch Webshop, Angebot Phase 2')).toBeTruthy();

    saveMeal.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await user.click(within(editor()).getByRole('button', { name: 'Speichern' }));
    await waitFor(() => expect(within(editor()).getByRole('alert').textContent).toMatch(/nicht geklappt/));
    expect(field('Anlass').value).toBe('Abnahme Fotoproduktion Herbst');
    // Still unsaved, so leaving still asks.
    await user.click(editButton(2));
    expect(screen.getByRole('dialog', { name: 'Ungespeicherte Änderungen verwerfen?' })).toBeTruthy();
  });

  it('a save that changed nothing keeps the form open and says so', async () => {
    const user = userEvent.setup();
    saveMeal.mockResolvedValue({ ok: true, value: { record: FIRST, changed: false } });
    render(<Page />);
    await user.click(editButton(1));
    await user.click(within(editor()).getByRole('button', { name: 'Speichern' }));
    expect(await within(editor()).findByText('Keine Änderungen, nichts gespeichert.')).toBeTruthy();
  });

  it('an entry taken out of the register while it is open closes its form, which does not come back with the entry', async () => {
    const user = userEvent.setup();
    markMealsNotMeal.mockResolvedValue({ ok: true, value: { done: ['a'], records: [{ ...FIRST, mealType: 'not_a_meal' }], skipped: [] } });
    function Restorable() {
      const [list, setList] = useState<MealRecord[]>([FIRST, SECOND]);
      return (
        <>
          <button onClick={() => setList([FIRST, SECOND])}>Wieder aufnehmen</button>
          <RegisterTab
            records={list.filter((r) => r.mealType !== 'not_a_meal')}
            settings={SMALL_BUSINESS}
            onSettingsChanged={vi.fn()}
            onRecordsSaved={(saved) => setList((l) => l.map((r) => saved.find((x) => x.rowId === r.rowId) ?? r))}
            onRecordsRemoved={vi.fn()}
            onOpenQueue={vi.fn()}
            {...EDITOR_PROPS}
          />
        </>
      );
    }
    render(<Restorable />);
    await user.click(editButton(1));
    await user.click(screen.getByRole('button', { name: /^Keine Bewirtung: Nr\. 1,/ }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Keine Bewirtung' }));
    await screen.findByText(/wird nicht mehr als Bewirtung geführt/);
    expect(screen.queryByRole('region', { name: 'Angaben zur Bewirtung' })).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Wieder aufnehmen' }));
    expect(editButton(1)).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Angaben zur Bewirtung' })).toBeNull();
  });

  it('a guest created from the picker is reported to the page, as in the queue', async () => {
    const user = userEvent.setup();
    const onContactCreated = vi.fn();
    const created: Contact = { id: 'c-3', name: 'Nora Neu', companyOrRole: '', note: null, archived: false };
    createContact.mockResolvedValue({ ok: true, value: created });
    render(
      <RegisterTab
        records={[FIRST]}
        contacts={CONTACTS}
        settings={SMALL_BUSINESS}
        defaultHost=""
        onSettingsChanged={vi.fn()}
        onRecordSaved={vi.fn()}
        onRecordsSaved={vi.fn()}
        onRecordsRemoved={vi.fn()}
        onContactCreated={onContactCreated}
        onOpenQueue={vi.fn()}
      />,
    );
    await user.click(editButton(1));
    await user.type(within(editor()).getByRole('combobox'), 'Nora Neu');
    await user.click(within(editor()).getByRole('option', { name: /Neuen Kontakt anlegen/ }));
    await user.click(within(editor()).getByRole('button', { name: 'Anlegen und hinzufügen' }));
    expect(createContact).toHaveBeenCalledWith({ name: 'Nora Neu', companyOrRole: '' });
    await waitFor(() => expect(onContactCreated).toHaveBeenCalledWith(created));
  });
});
