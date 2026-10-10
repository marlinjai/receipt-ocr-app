// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { DirectoryContact, DirectoryField } from '@/lib/contacts/directory';

const actions = {
  listDirectoryAction: vi.fn(),
  listFieldsAction: vi.fn(),
  previewEraseAction: vi.fn(),
  eraseDirectoryAction: vi.fn(),
  updateDirectoryAction: vi.fn(),
  createFieldAction: vi.fn(),
  archiveFieldAction: vi.fn(),
  createDirectoryAction: vi.fn(),
};
vi.mock('./directory-actions', () => ({
  listDirectoryAction: (...a: unknown[]) => actions.listDirectoryAction(...a),
  listFieldsAction: (...a: unknown[]) => actions.listFieldsAction(...a),
  previewEraseAction: (...a: unknown[]) => actions.previewEraseAction(...a),
  eraseDirectoryAction: (...a: unknown[]) => actions.eraseDirectoryAction(...a),
  updateDirectoryAction: (...a: unknown[]) => actions.updateDirectoryAction(...a),
  createFieldAction: (...a: unknown[]) => actions.createFieldAction(...a),
  archiveFieldAction: (...a: unknown[]) => actions.archiveFieldAction(...a),
  assignCustomerNumberAction: vi.fn(),
  createDirectoryAction: (...a: unknown[]) => actions.createDirectoryAction(...a),
  exportDirectoryAction: vi.fn(),
  linkPersonAction: vi.fn(),
  mergeDirectoryAction: vi.fn(),
}));

import DirectoryPanel from './DirectoryPanel';

const contact = (over: Partial<DirectoryContact> & { id: string; kind: 'person' | 'organization'; name: string }): DirectoryContact => ({
  companyOrRole: '',
  organizationId: null,
  organizationName: null,
  email: null,
  phone: null,
  note: null,
  legalForm: null,
  addressLine1: null,
  addressLine2: null,
  postalCode: null,
  city: null,
  country: null,
  vatId: null,
  preferredContact: null,
  customFields: {},
  customerNumber: null,
  archived: false,
  version: 3,
  ...over,
});

const SEATS: DirectoryField = { key: 'seats', label: 'Plätze', type: 'number', options: null, archived: false };
const PERSON = contact({ id: 'p1', kind: 'person', name: 'Beispiel Person', customFields: { seats: 2 }, preferredContact: 'phone' });

beforeEach(() => {
  for (const fn of Object.values(actions)) fn.mockReset();
  actions.listDirectoryAction.mockResolvedValue({ ok: true, value: [PERSON] });
  actions.listFieldsAction.mockResolvedValue({ ok: true, value: [SEATS] });
});
afterEach(cleanup);

describe('DirectoryPanel: erasing one contact', () => {
  it('asks first, says that printed names are held, and erases only after the confirmation', async () => {
    actions.previewEraseAction.mockResolvedValue({ ok: true, value: { exists: true, meals: 2, printedNames: 'held', coverage: 'changed', linkedPersons: 0 } });
    actions.eraseDirectoryAction.mockResolvedValue({ ok: true, value: { outcome: 'erased', printedNamesRemoved: 0, printedNamesHeld: 2, coverage: 'changed' } });
    const user = userEvent.setup();
    render(<DirectoryPanel />);
    await user.click(await screen.findByRole('button', { name: 'Löschen' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog.textContent).toContain('2 Bewirtungen');
    expect(dialog.textContent).toContain('bleiben zehn Jahre erhalten');
    expect(dialog.textContent).toContain('seit dem letzten Export geändert');
    expect(actions.eraseDirectoryAction).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Endgültig löschen' }));
    await waitFor(() => expect(actions.eraseDirectoryAction).toHaveBeenCalledWith('p1'));
    expect(await screen.findByText('Kontakt gelöscht.')).toBeTruthy();
  });

  it('says that printed names are removed only because the register is unchanged since the last export, and cancelling erases nothing', async () => {
    actions.previewEraseAction.mockResolvedValue({ ok: true, value: { exists: true, meals: 1, printedNames: 'removed', coverage: 'identical', linkedPersons: 0 } });
    const user = userEvent.setup();
    render(<DirectoryPanel />);
    await user.click(await screen.findByRole('button', { name: 'Löschen' }));
    const text = (await screen.findByRole('alertdialog')).textContent ?? '';
    expect(text).toContain('werden jetzt entfernt');
    expect(text).toContain('seit dem letzten Export dieses Kontos unverändert');
    await user.click(screen.getByRole('button', { name: 'Abbrechen' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(actions.eraseDirectoryAction).not.toHaveBeenCalled();
  });
});

describe('DirectoryPanel: custom fields on the form', () => {
  it('sends only the changed field and keeps the preferred contact method', async () => {
    actions.updateDirectoryAction.mockResolvedValue({ ok: true, value: PERSON });
    const user = userEvent.setup();
    render(<DirectoryPanel />);
    await user.click(await screen.findByRole('button', { name: 'Angaben bearbeiten' }));
    const seats = screen.getByLabelText('Plätze');
    await user.clear(seats);
    await user.type(seats, '4');
    await user.click(screen.getByRole('button', { name: 'Speichern' }));
    await waitFor(() => expect(actions.updateDirectoryAction).toHaveBeenCalled());
    expect(actions.updateDirectoryAction).toHaveBeenCalledWith('p1', { email: null, phone: null, preferredContact: 'phone', customFields: { seats: 4 } }, 3);
  });

  it('marks an unreadable number under its input and sends nothing', async () => {
    const user = userEvent.setup();
    render(<DirectoryPanel />);
    await user.click(await screen.findByRole('button', { name: 'Angaben bearbeiten' }));
    const seats = screen.getByLabelText('Plätze');
    await user.clear(seats);
    await user.type(seats, 'vier');
    await user.click(screen.getByRole('button', { name: 'Speichern' }));
    expect(await screen.findByText('Dieser Wert passt nicht zum Feld.')).toBeTruthy();
    expect(seats.getAttribute('aria-invalid')).toBe('true');
    expect(actions.updateDirectoryAction).not.toHaveBeenCalled();
  });

  it('shows the error the package returns under the field it names', async () => {
    actions.updateDirectoryAction.mockResolvedValue({ ok: false, error: 'field_archived', field: 'seats' });
    const user = userEvent.setup();
    render(<DirectoryPanel />);
    await user.click(await screen.findByRole('button', { name: 'Angaben bearbeiten' }));
    const seats = screen.getByLabelText('Plätze');
    await user.clear(seats);
    await user.type(seats, '5');
    await user.click(screen.getByRole('button', { name: 'Speichern' }));
    expect(await screen.findByText('Das Feld ist archiviert und nimmt keine neuen Werte an.')).toBeTruthy();
  });

  it('defines a new field with a key derived from its label', async () => {
    actions.createFieldAction.mockResolvedValue({ ok: true, value: SEATS });
    const user = userEvent.setup();
    render(<DirectoryPanel />);
    await user.type(await screen.findByLabelText('Name des Feldes'), 'Bevorzugte Küche');
    await user.click(screen.getByRole('button', { name: 'Feld anlegen' }));
    await waitFor(() => expect(actions.createFieldAction).toHaveBeenCalledWith({ key: 'bevorzugte_kueche', label: 'Bevorzugte Küche', type: 'text', options: null }));
  });
});

describe('DirectoryPanel: creating with details', () => {
  it('a new person carries the custom field value and the preferred contact method', async () => {
    actions.createDirectoryAction.mockResolvedValue({ ok: true, value: contact({ id: 'p9', kind: 'person', name: 'Neue Testperson' }) });
    const user = userEvent.setup();
    render(<DirectoryPanel />);
    await user.click(await screen.findByRole('button', { name: 'Person mit Angaben anlegen' }));
    const form = screen.getByRole('form', { name: 'Neue Person' });
    await user.type(within(form).getByLabelText('Name'), 'Neue Testperson');
    await user.selectOptions(within(form).getByLabelText('Bevorzugter Kontaktweg'), 'phone');
    await user.type(within(form).getByLabelText('Plätze'), '4');
    await user.click(within(form).getByRole('button', { name: 'Speichern' }));
    await waitFor(() =>
      expect(actions.createDirectoryAction).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'person', name: 'Neue Testperson', companyOrRole: '', preferredContact: 'phone', customFields: { seats: 4 } }),
      ),
    );
    expect(await screen.findByText('Person angelegt.')).toBeTruthy();
  });

  it('a new organization carries them too', async () => {
    actions.createDirectoryAction.mockResolvedValue({ ok: true, value: contact({ id: 'o9', kind: 'organization', name: 'Neue Organisation' }) });
    const user = userEvent.setup();
    render(<DirectoryPanel />);
    await user.click(await screen.findByRole('button', { name: 'Organisation anlegen' }));
    const form = screen.getByRole('form', { name: 'Neue Organisation' });
    await user.type(within(form).getByLabelText('Name'), 'Neue Organisation');
    await user.selectOptions(within(form).getByLabelText('Bevorzugter Kontaktweg'), 'post');
    await user.type(within(form).getByLabelText('Plätze'), '12');
    await user.click(within(form).getByRole('button', { name: 'Speichern' }));
    await waitFor(() =>
      expect(actions.createDirectoryAction).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'organization', name: 'Neue Organisation', preferredContact: 'post', customFields: { seats: 12 } }),
      ),
    );
  });

  it('a value the package refuses at creation is shown under its input, as on the edit form, and the form stays open', async () => {
    actions.createDirectoryAction.mockResolvedValue({ ok: false, error: 'invalid_value', field: 'seats' });
    const user = userEvent.setup();
    render(<DirectoryPanel />);
    await user.click(await screen.findByRole('button', { name: 'Person mit Angaben anlegen' }));
    const form = screen.getByRole('form', { name: 'Neue Person' });
    await user.type(within(form).getByLabelText('Name'), 'Neue Testperson');
    // Taken before the save: once the error line is shown it is part of the label.
    const input = within(form).getByLabelText('Plätze');
    await user.type(input, '4');
    await user.click(within(form).getByRole('button', { name: 'Speichern' }));
    await waitFor(() => expect(input.getAttribute('aria-invalid')).toBe('true'));
    expect(within(form).getByText('Dieser Wert passt nicht zum Feld.')).toBeTruthy();
    expect(screen.getByRole('form', { name: 'Neue Person' })).toBeTruthy();
  });

  it('a person cannot be saved without a name', async () => {
    const user = userEvent.setup();
    render(<DirectoryPanel />);
    await user.click(await screen.findByRole('button', { name: 'Person mit Angaben anlegen' }));
    const form = screen.getByRole('form', { name: 'Neue Person' });
    expect((within(form).getByRole('button', { name: 'Speichern' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('shows only the newest load when two overlap: an older answer never undoes a newer one', async () => {
    const answers: Array<(v: unknown) => void> = [];
    actions.listDirectoryAction.mockImplementation(() => new Promise((resolve) => answers.push(resolve)));
    const onChanged = vi.fn();
    const { rerender } = render(<DirectoryPanel refreshKey={0} onChanged={onChanged} />);
    await waitFor(() => expect(answers).toHaveLength(1));
    rerender(<DirectoryPanel refreshKey={1} onChanged={onChanged} />);
    await waitFor(() => expect(answers).toHaveLength(2));
    const newer = contact({ id: 'p2', kind: 'person', name: 'Neuerer Stand' });
    answers[1]({ ok: true, value: [newer] });
    expect((await screen.findAllByText('Neuerer Stand')).length).toBeGreaterThan(0);
    answers[0]({ ok: true, value: [PERSON] });
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryAllByText('Beispiel Person')).toHaveLength(0);
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(onChanged).toHaveBeenCalledWith([newer]);
  });

  it('reloads its list when the parent reports a change made elsewhere', async () => {
    const { rerender } = render(<DirectoryPanel refreshKey={0} />);
    await screen.findAllByText('Beispiel Person');
    expect(actions.listDirectoryAction).toHaveBeenCalledTimes(1);
    actions.listDirectoryAction.mockResolvedValue({ ok: true, value: [PERSON, contact({ id: 'p2', kind: 'person', name: 'Anderswo Angelegt' })] });
    rerender(<DirectoryPanel refreshKey={1} />);
    expect((await screen.findAllByText('Anderswo Angelegt')).length).toBeGreaterThan(0);
    expect(actions.listDirectoryAction).toHaveBeenCalledTimes(2);
  });
});

