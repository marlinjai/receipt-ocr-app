// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { DirectoryContact, DirectoryField } from '@/lib/contacts/directory';
import type { Contact } from '@/lib/contacts/store';
import type { MealsPageData } from './actions';

/**
 * The Kontakte tab shows the same persons twice: in the guest list (fed by the
 * page) and in the directory (which loads its own list). These tests hold the
 * two and the tab badge together without a page reload, in both directions.
 *
 * `server` stands in for the contacts database: every mocked action reads or
 * changes it, exactly as the real actions change the one database.
 */

const server: { contacts: DirectoryContact[]; fields: DirectoryField[] } = { contacts: [], fields: [] };

const directoryContact = (over: Partial<DirectoryContact> & { id: string; kind: 'person' | 'organization'; name: string }): DirectoryContact => ({
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
  version: 1,
  ...over,
});

const guestOf = (c: DirectoryContact): Contact => ({ id: c.id, name: c.name, companyOrRole: c.companyOrRole, note: c.note, archived: c.archived });

const mealActions = {
  createContact: vi.fn(),
  updateContact: vi.fn(),
  setContactArchived: vi.fn(),
  getMealsPageData: vi.fn(),
};
vi.mock('./actions', () => ({
  createContact: (...a: unknown[]) => mealActions.createContact(...a),
  updateContact: (...a: unknown[]) => mealActions.updateContact(...a),
  setContactArchived: (...a: unknown[]) => mealActions.setContactArchived(...a),
  getMealsPageData: (...a: unknown[]) => mealActions.getMealsPageData(...a),
}));

const directoryActions = {
  listDirectoryAction: vi.fn(),
  listFieldsAction: vi.fn(),
  createDirectoryAction: vi.fn(),
  previewEraseAction: vi.fn(),
  eraseDirectoryAction: vi.fn(),
};
vi.mock('./directory-actions', () => ({
  listDirectoryAction: (...a: unknown[]) => directoryActions.listDirectoryAction(...a),
  listFieldsAction: (...a: unknown[]) => directoryActions.listFieldsAction(...a),
  createDirectoryAction: (...a: unknown[]) => directoryActions.createDirectoryAction(...a),
  previewEraseAction: (...a: unknown[]) => directoryActions.previewEraseAction(...a),
  eraseDirectoryAction: (...a: unknown[]) => directoryActions.eraseDirectoryAction(...a),
  updateDirectoryAction: vi.fn(),
  createFieldAction: vi.fn(),
  archiveFieldAction: vi.fn(),
  assignCustomerNumberAction: vi.fn(),
  exportDirectoryAction: vi.fn(),
  linkPersonAction: vi.fn(),
  mergeDirectoryAction: vi.fn(),
}));

// The other tabs are not under test and pull in the receipt viewer.
vi.mock('./QueueTab', () => ({ default: () => null }));
vi.mock('./RegisterTab', () => ({ default: () => null }));
vi.mock('./DismissedMeals', () => ({ default: () => null }));
vi.mock('next/link', () => ({ default: ({ children }: { children: React.ReactNode }) => <a>{children}</a> }));

import MealsClient from './MealsClient';

const SEATS: DirectoryField = { key: 'seats', label: 'Plätze', type: 'number', options: null, archived: false };
const ORGANIZATION = directoryContact({ id: 'o1', kind: 'organization', name: 'Beispiel Organisation' });
const PERSON = directoryContact({ id: 'p1', kind: 'person', name: 'Beispiel Person', companyOrRole: 'Beispiel' });

function pageData(): MealsPageData {
  return {
    records: [],
    contacts: server.contacts.filter((c) => c.kind === 'person').map(guestOf),
    organizationCount: server.contacts.filter((c) => c.kind === 'organization' && !c.archived).length,
    settings: { smallBusiness: null, hostNameThreshold: 250 } as unknown as MealsPageData['settings'],
    defaultHost: '',
  };
}

async function openContactsTab() {
  const user = userEvent.setup();
  render(<MealsClient initial={pageData()} />);
  await user.click(screen.getByRole('tab', { name: /Kontakte/ }));
  // The name also appears as an option of the merge selects, so more than once.
  await screen.findAllByText('Beispiel Organisation');
  return user;
}

const badge = () => screen.getByRole('tab', { name: /Kontakte/ }).textContent?.replace('Kontakte', '');
const directory = () => screen.getByRole('region', { name: 'Verzeichnis' });
const directoryEntries = () => within(directory()).getAllByRole('button', { name: 'Exportieren' }).length;
const guestListEntries = () => screen.queryAllByRole('button', { name: 'Korrigieren' }).length;

beforeEach(() => {
  server.contacts = [ORGANIZATION, PERSON];
  server.fields = [SEATS];
  for (const fn of [...Object.values(mealActions), ...Object.values(directoryActions)]) fn.mockReset();
  directoryActions.listDirectoryAction.mockImplementation(async () => ({ ok: true, value: server.contacts.filter((c) => !c.archived) }));
  directoryActions.listFieldsAction.mockImplementation(async () => ({ ok: true, value: server.fields }));
  mealActions.getMealsPageData.mockImplementation(async () => ({ ok: true, value: pageData() }));
});
afterEach(cleanup);

describe('Kontakte tab: the guest list, the directory and the badge agree without a reload', () => {
  it('a contact created through the guest list form appears in the directory and the badge', async () => {
    mealActions.createContact.mockImplementation(async (input: { name: string; companyOrRole: string }) => {
      const created = directoryContact({ id: 'p2', kind: 'person', name: input.name, companyOrRole: input.companyOrRole });
      server.contacts = [...server.contacts, created];
      return { ok: true, value: guestOf(created) };
    });
    const user = await openContactsTab();
    expect(badge()).toBe('2');
    expect(directoryEntries()).toBe(2);

    await user.click(screen.getByRole('button', { name: 'Kontakt anlegen' }));
    await user.type(screen.getByLabelText('Name'), 'Neue Testperson');
    await user.click(screen.getByRole('button', { name: 'Speichern' }));

    await waitFor(() => expect(directoryEntries()).toBe(3));
    expect(within(directory()).getAllByText('Neue Testperson').length).toBeGreaterThan(0);
    expect(badge()).toBe('3');
    expect(guestListEntries()).toBe(2);
    // The new contact can be edited in the directory straight away.
    expect(within(directory()).getAllByRole('button', { name: 'Angaben bearbeiten' })).toHaveLength(2);
  });

  it('a person created in the directory, with its details, appears in the guest list and the badge', async () => {
    directoryActions.createDirectoryAction.mockImplementation(async (input: Partial<DirectoryContact> & { name: string }) => {
      const created = directoryContact({ id: 'p3', kind: 'person', name: input.name, companyOrRole: input.companyOrRole ?? '' });
      server.contacts = [...server.contacts, created];
      return { ok: true, value: created };
    });
    const user = await openContactsTab();
    expect(guestListEntries()).toBe(1);

    await user.click(screen.getByRole('button', { name: 'Person mit Angaben anlegen' }));
    const form = screen.getByRole('form', { name: 'Neue Person' });
    await user.type(within(form).getByLabelText('Name'), 'Person aus dem Verzeichnis');
    await user.type(within(form).getByLabelText('Firma oder Funktion'), 'Beispiel');
    await user.type(within(form).getByLabelText('E-Mail'), 'person@example.test');
    await user.selectOptions(within(form).getByLabelText('Bevorzugter Kontaktweg'), 'email');
    await user.type(within(form).getByLabelText('Plätze'), '3');
    await user.click(within(form).getByRole('button', { name: 'Speichern' }));

    await waitFor(() => expect(guestListEntries()).toBe(2));
    expect(directoryActions.createDirectoryAction).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'person',
        name: 'Person aus dem Verzeichnis',
        companyOrRole: 'Beispiel',
        email: 'person@example.test',
        preferredContact: 'email',
        customFields: { seats: 3 },
      }),
    );
    expect(badge()).toBe('3');
    expect(directoryEntries()).toBe(3);
  });

  it('archiving in the guest list takes the person out of the directory and the badge', async () => {
    mealActions.setContactArchived.mockImplementation(async (id: string, archived: boolean) => {
      server.contacts = server.contacts.map((c) => (c.id === id ? { ...c, archived } : c));
      return { ok: true, value: guestOf(server.contacts.find((c) => c.id === id)!) };
    });
    const user = await openContactsTab();

    await user.click(screen.getByRole('button', { name: 'Archivieren' }));

    await waitFor(() => expect(directoryEntries()).toBe(1));
    expect(within(directory()).queryAllByText('Beispiel Person')).toHaveLength(0);
    expect(badge()).toBe('1');
    // The archived person is still there on request, and the directory still does not list it.
    await user.click(screen.getByRole('button', { name: /Archivierte anzeigen/ }));
    expect(screen.getByRole('button', { name: 'Wiederherstellen' })).toBeTruthy();
    expect(directoryEntries()).toBe(1);
  });

  it('erasing in the directory takes the person out of the guest list and the badge, and reloads the meals', async () => {
    directoryActions.previewEraseAction.mockResolvedValue({ ok: true, value: { exists: true, meals: 0, printedNames: 'held', coverage: 'no_export', linkedPersons: 0 } });
    directoryActions.eraseDirectoryAction.mockImplementation(async (id: string) => {
      server.contacts = server.contacts.filter((c) => c.id !== id);
      return { ok: true, value: { outcome: 'erased', printedNamesRemoved: 0, printedNamesHeld: 0, coverage: 'no_export' } };
    });
    const user = await openContactsTab();

    await user.click(within(directory()).getAllByRole('button', { name: 'Löschen' })[1]);
    await user.click(await screen.findByRole('button', { name: 'Endgültig löschen' }));

    await waitFor(() => expect(guestListEntries()).toBe(0));
    expect(badge()).toBe('1');
    expect(directoryEntries()).toBe(1);
    expect(mealActions.getMealsPageData).toHaveBeenCalledTimes(1);
  });
});
