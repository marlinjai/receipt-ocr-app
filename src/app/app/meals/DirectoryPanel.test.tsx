// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
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
  createDirectoryAction: vi.fn(),
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
    actions.previewEraseAction.mockResolvedValue({ ok: true, value: { exists: true, meals: 2, printedNames: 'held', linkedPersons: 0 } });
    actions.eraseDirectoryAction.mockResolvedValue({ ok: true, value: { outcome: 'erased', printedNamesRemoved: 0, printedNamesHeld: 2 } });
    const user = userEvent.setup();
    render(<DirectoryPanel />);
    await user.click(await screen.findByRole('button', { name: 'Löschen' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog.textContent).toContain('2 Bewirtungen');
    expect(dialog.textContent).toContain('bleiben zehn Jahre erhalten');
    expect(actions.eraseDirectoryAction).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Endgültig löschen' }));
    await waitFor(() => expect(actions.eraseDirectoryAction).toHaveBeenCalledWith('p1'));
    expect(await screen.findByText('Kontakt gelöscht.')).toBeTruthy();
  });

  it('says that printed names are removed when an export exists, and cancelling erases nothing', async () => {
    actions.previewEraseAction.mockResolvedValue({ ok: true, value: { exists: true, meals: 1, printedNames: 'removed', linkedPersons: 0 } });
    const user = userEvent.setup();
    render(<DirectoryPanel />);
    await user.click(await screen.findByRole('button', { name: 'Löschen' }));
    expect((await screen.findByRole('alertdialog')).textContent).toContain('werden jetzt entfernt');
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
