// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { DirectoryContact, DirectoryField } from '@/lib/contacts/directory';

/**
 * The contacts page: one list, one panel for the selected contact, the rare
 * tools on their own tab.
 *
 * `server` stands in for the contacts database: every mocked action reads or
 * changes it, exactly as the real actions change the one database, and the page
 * reloads its list from it after every change.
 */

const server: { contacts: DirectoryContact[]; fields: DirectoryField[] } = { contacts: [], fields: [] };

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

const actions = {
  listDirectoryAction: vi.fn(),
  listFieldsAction: vi.fn(),
  createDirectoryAction: vi.fn(),
  updateDirectoryAction: vi.fn(),
  linkPersonAction: vi.fn(),
  assignCustomerNumberAction: vi.fn(),
  mergeDirectoryAction: vi.fn(),
  exportDirectoryAction: vi.fn(),
  createFieldAction: vi.fn(),
  archiveFieldAction: vi.fn(),
  previewEraseAction: vi.fn(),
  eraseDirectoryAction: vi.fn(),
};
vi.mock('./actions', () => ({
  listDirectoryAction: (...a: unknown[]) => actions.listDirectoryAction(...a),
  listFieldsAction: (...a: unknown[]) => actions.listFieldsAction(...a),
  createDirectoryAction: (...a: unknown[]) => actions.createDirectoryAction(...a),
  updateDirectoryAction: (...a: unknown[]) => actions.updateDirectoryAction(...a),
  linkPersonAction: (...a: unknown[]) => actions.linkPersonAction(...a),
  assignCustomerNumberAction: (...a: unknown[]) => actions.assignCustomerNumberAction(...a),
  mergeDirectoryAction: (...a: unknown[]) => actions.mergeDirectoryAction(...a),
  exportDirectoryAction: (...a: unknown[]) => actions.exportDirectoryAction(...a),
  createFieldAction: (...a: unknown[]) => actions.createFieldAction(...a),
  archiveFieldAction: (...a: unknown[]) => actions.archiveFieldAction(...a),
  previewEraseAction: (...a: unknown[]) => actions.previewEraseAction(...a),
  eraseDirectoryAction: (...a: unknown[]) => actions.eraseDirectoryAction(...a),
}));

const guestActions = { updateContact: vi.fn(), setContactArchived: vi.fn() };
vi.mock('../meals/actions', () => ({
  updateContact: (...a: unknown[]) => guestActions.updateContact(...a),
  setContactArchived: (...a: unknown[]) => guestActions.setContactArchived(...a),
}));

vi.mock('next/link', () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a>,
}));

import ContactsClient from './ContactsClient';
import ContactsLoading from './loading';

const SEATS: DirectoryField = { key: 'seats', label: 'Plätze', type: 'number', options: null, archived: false };
const ORGANIZATION = contact({ id: 'o1', kind: 'organization', name: 'Musterwerk', postalCode: '10115', city: 'Beispielstadt', customerNumber: '0007' });
const PERSON = contact({ id: 'p1', kind: 'person', name: 'Beispiel Person', companyOrRole: 'Einkauf', customFields: { seats: 2 }, preferredContact: 'phone' });
const LINKED = contact({ id: 'p2', kind: 'person', name: 'Anna Verknüpft', organizationId: 'o1', organizationName: 'Musterwerk' });
const ARCHIVED = contact({ id: 'p3', kind: 'person', name: 'Zoe Archiviert', archived: true });

const guestOf = (c: DirectoryContact) => ({ id: c.id, name: c.name, companyOrRole: c.companyOrRole, note: c.note, archived: c.archived });
const patchServer = (id: string, patch: Partial<DirectoryContact>) => {
  server.contacts = server.contacts.map((c) => (c.id === id ? { ...c, ...patch, version: c.version + 1 } : c));
  return server.contacts.find((c) => c.id === id)!;
};

function renderPage() {
  const user = userEvent.setup();
  render(<ContactsClient initial={{ contacts: server.contacts, fields: server.fields }} />);
  return user;
}

const list = () => screen.getByRole('list', { name: 'Kontakte' });
const rows = () => within(list()).getAllByRole('button');
const rowNames = () => rows().map((r) => r.querySelector('span span')?.textContent);
const row = (name: string) => within(list()).getByRole('button', { name: new RegExp(`^${name}`) });
const panel = (name: string) => screen.getByRole('region', { name });
const queryPanel = (name: string) => screen.queryByRole('region', { name });

async function openPanel(user: ReturnType<typeof userEvent.setup>, name: string) {
  await user.click(row(name));
  return panel(name);
}

beforeEach(() => {
  server.contacts = [PERSON, ORGANIZATION, ARCHIVED, LINKED];
  server.fields = [SEATS];
  for (const fn of [...Object.values(actions), ...Object.values(guestActions)]) fn.mockReset();
  actions.listDirectoryAction.mockImplementation(async () => ({ ok: true, value: server.contacts }));
  actions.listFieldsAction.mockImplementation(async () => ({ ok: true, value: server.fields }));
});
afterEach(cleanup);

describe('contacts page: one list', () => {
  it('lists persons and organizations together, sorted by name, each once, without the archived ones', () => {
    renderPage();
    expect(rowNames()).toEqual(['Anna Verknüpft', 'Beispiel Person', 'Musterwerk']);
    expect(within(list()).getAllByRole('button', { name: /Beispiel Person/ })).toHaveLength(1);
    expect(screen.getAllByText('Beispiel Person')).toHaveLength(1);
    expect(screen.getByText('3 Kontakte')).toBeTruthy();
  });

  it('a row shows the kind, the organization of a person or the place of an organization, and the customer number', () => {
    renderPage();
    expect(row('Anna Verknüpft').textContent).toBe('Anna VerknüpftPersonMusterwerk');
    expect(row('Beispiel Person').textContent).toBe('Beispiel PersonPersonEinkauf');
    expect(row('Musterwerk').textContent).toBe('MusterwerkOrganisation10115 BeispielstadtKundennummer 0007');
  });

  it('never says "Verzeichnis": that word belongs to the meal register', async () => {
    const user = renderPage();
    expect(document.body.textContent).not.toContain('Verzeichnis');
    await openPanel(user, 'Beispiel Person');
    expect(document.body.textContent).not.toContain('Verzeichnis');
    await user.click(screen.getByRole('tab', { name: 'Verwaltung' }));
    expect(document.body.textContent).not.toContain('Verzeichnis');
  });

  it('filters by kind with the segmented control', async () => {
    const user = renderPage();
    const filter = screen.getByRole('group', { name: 'Art der Kontakte' });
    expect(within(filter).getByRole('button', { name: 'Alle' }).getAttribute('aria-pressed')).toBe('true');

    await user.click(within(filter).getByRole('button', { name: 'Organisationen' }));
    expect(rowNames()).toEqual(['Musterwerk']);
    expect(within(filter).getByRole('button', { name: 'Organisationen' }).getAttribute('aria-pressed')).toBe('true');

    await user.click(within(filter).getByRole('button', { name: 'Personen' }));
    expect(rowNames()).toEqual(['Anna Verknüpft', 'Beispiel Person']);

    await user.click(within(filter).getByRole('button', { name: 'Alle' }));
    expect(rowNames()).toHaveLength(3);
  });

  it('searches name, organization and customer number', async () => {
    const user = renderPage();
    const search = screen.getByRole('searchbox', { name: 'Suche' });
    await user.type(search, 'musterwerk');
    expect(rowNames()).toEqual(['Anna Verknüpft', 'Musterwerk']);
    await user.clear(search);
    await user.type(search, '0007');
    expect(rowNames()).toEqual(['Musterwerk']);
    await user.clear(search);
    await user.type(search, 'beispiel pers');
    expect(rowNames()).toEqual(['Beispiel Person']);
  });

  it('includes the archived ones on request and marks them', async () => {
    const user = renderPage();
    const toggle = screen.getByRole('button', { name: 'Archivierte anzeigen (1)' });
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    await user.click(toggle);
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    expect(rowNames()).toEqual(['Anna Verknüpft', 'Beispiel Person', 'Musterwerk', 'Zoe Archiviert']);
    expect(row('Zoe Archiviert').textContent).toContain('Person, archiviert');
    await user.click(toggle);
    expect(rowNames()).toHaveLength(3);
  });
});

describe('contacts page: states', () => {
  it('empty: says so and offers the primary action, which opens the create flow', async () => {
    server.contacts = [];
    const user = renderPage();
    expect(screen.getByText('Noch keine Kontakte')).toBeTruthy();
    expect(screen.queryByRole('searchbox')).toBeNull();
    const buttons = screen.getAllByRole('button', { name: 'Kontakt anlegen' });
    expect(buttons).toHaveLength(2);
    await user.click(buttons[1]);
    expect(panel('Kontakt anlegen')).toBeTruthy();
  });

  it('nothing found: says so and resets search and filter in one step', async () => {
    const user = renderPage();
    await user.click(screen.getByRole('button', { name: 'Organisationen' }));
    await user.type(screen.getByRole('searchbox', { name: 'Suche' }), 'gibt es nicht');
    expect(screen.getByText('Nichts gefunden')).toBeTruthy();
    expect(screen.queryByRole('list', { name: 'Kontakte' })).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Suche zurücksetzen' }));
    expect(rowNames()).toHaveLength(3);
    expect((screen.getByRole('searchbox', { name: 'Suche' }) as HTMLInputElement).value).toBe('');
  });

  it('nothing found among the active ones: offers the archived ones', async () => {
    const user = renderPage();
    await user.type(screen.getByRole('searchbox', { name: 'Suche' }), 'zoe');
    expect(screen.getByText('Nichts gefunden')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Archivierte anzeigen' }));
    expect(rowNames()).toEqual(['Zoe Archiviert']);
  });

  it('only archived contacts: says so instead of looking empty', async () => {
    server.contacts = [ARCHIVED];
    const user = renderPage();
    expect(screen.getByText('Alle Kontakte sind archiviert')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Archivierte anzeigen' }));
    expect(rowNames()).toEqual(['Zoe Archiviert']);
  });

  it('loading: the route shows a status while the contacts are fetched', () => {
    render(<ContactsLoading />);
    expect(screen.getByRole('status').textContent).toBe('Kontakte werden geladen…');
    expect(screen.getByRole('heading', { name: 'Kontakte' })).toBeTruthy();
  });

  it('a failed reload keeps the list, says so and can be retried', async () => {
    actions.assignCustomerNumberAction.mockImplementation(async (id: string) => ({ ok: true, value: patchServer(id, { customerNumber: '0008' }) }));
    actions.listDirectoryAction.mockResolvedValueOnce({ ok: false, error: 'failed' });
    const user = renderPage();
    await openPanel(user, 'Beispiel Person');
    await user.click(screen.getByRole('button', { name: 'Kundennummer vergeben' }));

    const alert = await screen.findByText(/konnten nicht neu geladen werden/);
    expect(alert.closest('[role="alert"]')).toBeTruthy();
    // The last known state stays on screen.
    expect(rowNames()).toHaveLength(3);
    expect(row('Beispiel Person').textContent).not.toContain('0008');

    await user.click(screen.getByRole('button', { name: 'Erneut laden' }));
    await waitFor(() => expect(row('Beispiel Person').textContent).toContain('Kundennummer 0008'));
    expect(screen.queryByText(/konnten nicht neu geladen werden/)).toBeNull();
  });

  it('shows only the newest load when two overlap: an older answer never undoes a newer one', async () => {
    actions.assignCustomerNumberAction.mockResolvedValue({ ok: true, value: PERSON });
    actions.listDirectoryAction.mockResolvedValueOnce({ ok: false, error: 'failed' });
    const user = renderPage();
    await openPanel(user, 'Beispiel Person');
    await user.click(screen.getByRole('button', { name: 'Kundennummer vergeben' }));
    const retry = await screen.findByRole('button', { name: 'Erneut laden' });

    const answers: Array<(v: unknown) => void> = [];
    actions.listDirectoryAction.mockImplementation(() => new Promise((resolve) => answers.push(resolve)));
    await user.click(retry);
    await user.click(screen.getByRole('button', { name: /Erneut laden|Wird geladen/ }));
    await waitFor(() => expect(answers).toHaveLength(2));

    answers[1]({ ok: true, value: [contact({ id: 'n1', kind: 'person', name: 'Neuerer Stand' })] });
    await waitFor(() => expect(rowNames()).toEqual(['Neuerer Stand']));
    answers[0]({ ok: true, value: [PERSON] });
    await new Promise((r) => setTimeout(r, 20));
    expect(rowNames()).toEqual(['Neuerer Stand']);
  });
});

describe('contacts page: the panel of one contact', () => {
  it('opens beside the list, marks the row as current and moves the focus to its heading', async () => {
    const user = renderPage();
    expect(queryPanel('Beispiel Person')).toBeNull();
    const region = await openPanel(user, 'Beispiel Person');

    expect(row('Beispiel Person').getAttribute('aria-current')).toBe('true');
    expect(row('Musterwerk').getAttribute('aria-current')).toBeNull();
    expect(document.activeElement).toBe(within(region).getByRole('heading', { name: 'Beispiel Person' }));
    // The list stays in the document next to it.
    expect(rowNames()).toHaveLength(3);
    // Everything about the contact is here.
    expect(within(region).getByText('Einkauf')).toBeTruthy();
    expect(within(region).getByText('Telefon', { selector: 'dd' })).toBeTruthy();
    expect(within(region).getByText('Plätze')).toBeTruthy();
    for (const name of ['Bearbeiten', 'Kundennummer vergeben', 'Exportieren', 'Archivieren', 'Löschen']) {
      expect(within(region).getByRole('button', { name })).toBeTruthy();
    }
  });

  it('Escape closes it and returns the focus to the row', async () => {
    const user = renderPage();
    await openPanel(user, 'Musterwerk');
    await user.keyboard('{Escape}');
    expect(queryPanel('Musterwerk')).toBeNull();
    expect(document.activeElement).toBe(row('Musterwerk'));
    expect(row('Musterwerk').getAttribute('aria-current')).toBeNull();
  });

  it('the close button does the same', async () => {
    const user = renderPage();
    const region = await openPanel(user, 'Beispiel Person');
    await user.click(within(region).getByRole('button', { name: /Schließen/ }));
    expect(queryPanel('Beispiel Person')).toBeNull();
    expect(document.activeElement).toBe(row('Beispiel Person'));
  });

  it('is reachable by keyboard alone: Enter on a row opens it', async () => {
    const user = renderPage();
    row('Beispiel Person').focus();
    await user.keyboard('{Enter}');
    expect(panel('Beispiel Person')).toBeTruthy();
  });

  it('switching to another row keeps one panel', async () => {
    const user = renderPage();
    await openPanel(user, 'Beispiel Person');
    await openPanel(user, 'Musterwerk');
    expect(queryPanel('Beispiel Person')).toBeNull();
    expect(screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)).toEqual(['Musterwerk']);
    expect(within(list()).getAllByRole('button', { current: true })).toHaveLength(1);
  });

  it('an organization lists its persons, and a person leads to its organization', async () => {
    const user = renderPage();
    const org = await openPanel(user, 'Musterwerk');
    expect(within(org).getByRole('heading', { name: 'Personen (1)' })).toBeTruthy();
    expect(within(org).queryByRole('button', { name: 'Archivieren' })).toBeNull();
    await user.click(within(org).getByRole('button', { name: 'Anna Verknüpft' }));

    const person = panel('Anna Verknüpft');
    expect((within(person).getByRole('combobox', { name: 'Organisation' }) as HTMLSelectElement).value).toBe('o1');
    await user.click(within(person).getByRole('button', { name: 'Organisation öffnen' }));
    expect(panel('Musterwerk')).toBeTruthy();
  });

  it('links a person to an organization with the version it read', async () => {
    actions.linkPersonAction.mockImplementation(async (id: string, organizationId: string | null) => ({
      ok: true,
      value: patchServer(id, { organizationId, organizationName: organizationId ? 'Musterwerk' : null }),
    }));
    const user = renderPage();
    const region = await openPanel(user, 'Beispiel Person');
    const save = within(region).getByRole('button', { name: 'Verknüpfen' }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    await user.selectOptions(within(region).getByRole('combobox', { name: 'Organisation' }), 'o1');
    await user.click(save);

    await waitFor(() => expect(actions.linkPersonAction).toHaveBeenCalledWith('p1', 'o1', 3));
    expect(await screen.findByText('Verknüpfung gespeichert.')).toBeTruthy();
    await waitFor(() => expect(row('Beispiel Person').textContent).toBe('Beispiel PersonPersonMusterwerk'));

    // The next change uses the version of the reloaded contact, never the one the panel opened with.
    await user.selectOptions(within(panel('Beispiel Person')).getByRole('combobox', { name: 'Organisation' }), '');
    await user.click(within(panel('Beispiel Person')).getByRole('button', { name: 'Verknüpfen' }));
    await waitFor(() => expect(actions.linkPersonAction).toHaveBeenLastCalledWith('p1', null, 4));
  });

  it('assigns a customer number', async () => {
    actions.assignCustomerNumberAction.mockImplementation(async (id: string) => ({ ok: true, value: patchServer(id, { customerNumber: '0008' }) }));
    const user = renderPage();
    const region = await openPanel(user, 'Beispiel Person');
    await user.click(within(region).getByRole('button', { name: 'Kundennummer vergeben' }));
    await waitFor(() => expect(actions.assignCustomerNumberAction).toHaveBeenCalledWith('p1'));
    expect(await within(region).findByText('0008')).toBeTruthy();
    expect(within(region).queryByRole('button', { name: 'Kundennummer vergeben' })).toBeNull();
  });

  it('exports one contact as a file', async () => {
    actions.exportDirectoryAction.mockResolvedValue({ ok: true, value: '{"id":"p1"}' });
    const createObjectURL = vi.fn(() => 'blob:test');
    Object.assign(URL, { createObjectURL, revokeObjectURL: vi.fn() });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    const user = renderPage();
    const region = await openPanel(user, 'Beispiel Person');
    await user.click(within(region).getByRole('button', { name: 'Exportieren' }));
    await waitFor(() => expect(click).toHaveBeenCalledTimes(1));
    expect(actions.exportDirectoryAction).toHaveBeenCalledWith('p1');
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    click.mockRestore();
  });

  it('archives a person: it leaves the list, stays open and can be restored', async () => {
    guestActions.setContactArchived.mockImplementation(async (id: string, archived: boolean) => ({ ok: true, value: guestOf(patchServer(id, { archived })) }));
    const user = renderPage();
    const region = await openPanel(user, 'Beispiel Person');
    await user.click(within(region).getByRole('button', { name: 'Archivieren' }));

    await waitFor(() => expect(rowNames()).toEqual(['Anna Verknüpft', 'Musterwerk']));
    expect(guestActions.setContactArchived).toHaveBeenCalledWith('p1', true);
    expect(screen.getByRole('button', { name: 'Archivierte anzeigen (2)' })).toBeTruthy();
    // An archived contact is not edited, linked or numbered; it is restored first.
    expect(within(region).queryByRole('button', { name: 'Bearbeiten' })).toBeNull();
    expect(within(region).queryByRole('combobox', { name: 'Organisation' })).toBeNull();

    await user.click(within(region).getByRole('button', { name: 'Wiederherstellen' }));
    await waitFor(() => expect(rowNames()).toEqual(['Anna Verknüpft', 'Beispiel Person', 'Musterwerk']));
    expect(guestActions.setContactArchived).toHaveBeenLastCalledWith('p1', false);
    expect(within(region).getByRole('button', { name: 'Bearbeiten' })).toBeTruthy();
  });

  it('a failed action is shown inside the panel', async () => {
    actions.assignCustomerNumberAction.mockResolvedValue({ ok: false, error: 'customer_number_conflict' });
    const user = renderPage();
    const region = await openPanel(user, 'Beispiel Person');
    await user.click(within(region).getByRole('button', { name: 'Kundennummer vergeben' }));
    expect((await within(region).findByRole('alert')).textContent).toContain('Die Kundennummer ist bereits vergeben');
  });
});

describe('contacts page: erasing one contact', () => {
  it('asks first, says that printed names are held, and erases only after the confirmation', async () => {
    actions.previewEraseAction.mockResolvedValue({ ok: true, value: { exists: true, meals: 2, printedNames: 'held', coverage: 'changed', linkedPersons: 0 } });
    actions.eraseDirectoryAction.mockImplementation(async (id: string) => {
      server.contacts = server.contacts.filter((c) => c.id !== id);
      return { ok: true, value: { outcome: 'erased', printedNamesRemoved: 0, printedNamesHeld: 2, coverage: 'changed' } };
    });
    const user = renderPage();
    const region = await openPanel(user, 'Beispiel Person');
    await user.click(within(region).getByRole('button', { name: 'Löschen' }));

    const dialog = await screen.findByRole('alertdialog');
    expect(dialog.textContent).toContain('Beispiel Person endgültig löschen?');
    expect(dialog.textContent).toContain('2 Bewirtungen');
    expect(dialog.textContent).toContain('bleiben zehn Jahre erhalten');
    expect(dialog.textContent).toContain('seit dem letzten Export geändert');
    expect(actions.eraseDirectoryAction).not.toHaveBeenCalled();
    // The safe answer has the focus.
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Abbrechen' }));

    await user.click(within(dialog).getByRole('button', { name: 'Endgültig löschen' }));
    await waitFor(() => expect(actions.eraseDirectoryAction).toHaveBeenCalledWith('p1'));
    expect(await screen.findByText('Kontakt gelöscht.')).toBeTruthy();
    expect(queryPanel('Beispiel Person')).toBeNull();
    expect(rowNames()).toEqual(['Anna Verknüpft', 'Musterwerk']);
  });

  it('says that printed names are removed only because the register is unchanged since the last export, and cancelling erases nothing', async () => {
    actions.previewEraseAction.mockResolvedValue({ ok: true, value: { exists: true, meals: 1, printedNames: 'removed', coverage: 'identical', linkedPersons: 0 } });
    const user = renderPage();
    const region = await openPanel(user, 'Beispiel Person');
    await user.click(within(region).getByRole('button', { name: 'Löschen' }));
    const text = (await screen.findByRole('alertdialog')).textContent ?? '';
    expect(text).toContain('werden jetzt entfernt');
    expect(text).toContain('seit dem letzten Export dieses Kontos unverändert');

    await user.click(screen.getByRole('button', { name: 'Abbrechen' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(actions.eraseDirectoryAction).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(within(region).getByRole('button', { name: 'Löschen' }));
  });

  it('Escape leaves the question first and the panel second', async () => {
    actions.previewEraseAction.mockResolvedValue({ ok: true, value: { exists: true, meals: 0, printedNames: 'held', coverage: 'no_export', linkedPersons: 1 } });
    const user = renderPage();
    const region = await openPanel(user, 'Musterwerk');
    await user.click(within(region).getByRole('button', { name: 'Löschen' }));
    expect((await screen.findByRole('alertdialog')).textContent).toContain('1 verknüpfte Person bleibt');

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(panel('Musterwerk')).toBeTruthy();
    await user.keyboard('{Escape}');
    expect(queryPanel('Musterwerk')).toBeNull();
    expect(actions.eraseDirectoryAction).not.toHaveBeenCalled();
  });

  it('a preview that fails erases nothing and says so', async () => {
    actions.previewEraseAction.mockResolvedValue({ ok: false, error: 'forbidden' });
    const user = renderPage();
    const region = await openPanel(user, 'Beispiel Person');
    await user.click(within(region).getByRole('button', { name: 'Löschen' }));
    expect((await within(region).findByRole('alert')).textContent).toContain('fehlt die Berechtigung');
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });
});

describe('contacts page: one edit action', () => {
  async function startEdit(user: ReturnType<typeof userEvent.setup>, name: string, formName: string) {
    const region = await openPanel(user, name);
    await user.click(within(region).getByRole('button', { name: 'Bearbeiten' }));
    return screen.getByRole('form', { name: formName });
  }

  it('a person has one form for the name and for every other detail', async () => {
    const user = renderPage();
    const form = await startEdit(user, 'Beispiel Person', 'Person bearbeiten');
    expect((within(form).getByLabelText('Name') as HTMLInputElement).value).toBe('Beispiel Person');
    expect((within(form).getByLabelText('Firma oder Funktion') as HTMLInputElement).value).toBe('Einkauf');
    for (const label of ['E-Mail', 'Telefon', 'Bevorzugter Kontaktweg', 'Plätze', 'Notiz (wird nicht gedruckt)']) {
      expect(within(form).getByLabelText(label)).toBeTruthy();
    }
    expect(screen.queryByRole('button', { name: 'Korrigieren' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Angaben bearbeiten' })).toBeNull();
  });

  it('sends only the changed custom field and keeps the preferred contact method; the name is not saved again', async () => {
    actions.updateDirectoryAction.mockImplementation(async (id: string) => ({ ok: true, value: patchServer(id, { customFields: { seats: 4 } }) }));
    const user = renderPage();
    const form = await startEdit(user, 'Beispiel Person', 'Person bearbeiten');
    const seats = within(form).getByLabelText('Plätze');
    await user.clear(seats);
    await user.type(seats, '4');
    await user.click(within(form).getByRole('button', { name: 'Speichern' }));

    await waitFor(() => expect(actions.updateDirectoryAction).toHaveBeenCalled());
    expect(actions.updateDirectoryAction).toHaveBeenCalledWith('p1', { email: null, phone: null, preferredContact: 'phone', customFields: { seats: 4 } }, 3);
    expect(guestActions.updateContact).not.toHaveBeenCalled();
    expect(await screen.findByText('Änderungen gespeichert.')).toBeTruthy();
    expect(screen.queryByRole('form')).toBeNull();
  });

  it('a corrected name goes through the guest action, which also corrects the names printed on meals', async () => {
    guestActions.updateContact.mockImplementation(async (id: string, input: { name: string; companyOrRole: string; note: string | null }) => ({
      ok: true,
      value: guestOf(patchServer(id, input)),
    }));
    const user = renderPage();
    const form = await startEdit(user, 'Beispiel Person', 'Person bearbeiten');
    const name = within(form).getByLabelText('Name');
    await user.clear(name);
    await user.type(name, 'Beispiel  Persona ');
    await user.type(within(form).getByLabelText('Notiz (wird nicht gedruckt)'), 'Vegetarisch');
    await user.click(within(form).getByRole('button', { name: 'Speichern' }));

    await waitFor(() => expect(guestActions.updateContact).toHaveBeenCalledWith('p1', { name: 'Beispiel Persona', companyOrRole: 'Einkauf', note: 'Vegetarisch' }));
    expect(actions.updateDirectoryAction).not.toHaveBeenCalled();
    await waitFor(() => expect(rowNames()).toContain('Beispiel Persona'));
    expect(panel('Beispiel Persona')).toBeTruthy();
  });

  it('name and details together: the details first with the version read, then the name', async () => {
    const order: string[] = [];
    actions.updateDirectoryAction.mockImplementation(async (id: string, patch: { email: string | null }) => {
      order.push('details');
      return { ok: true, value: patchServer(id, { email: patch.email }) };
    });
    guestActions.updateContact.mockImplementation(async (id: string, input: { name: string }) => {
      order.push('name');
      return { ok: true, value: guestOf(patchServer(id, { name: input.name })) };
    });
    const user = renderPage();
    const form = await startEdit(user, 'Beispiel Person', 'Person bearbeiten');
    await user.type(within(form).getByLabelText('Name'), ' Zwei');
    await user.type(within(form).getByLabelText('E-Mail'), 'person@example.test');
    await user.click(within(form).getByRole('button', { name: 'Speichern' }));

    await waitFor(() => expect(order).toEqual(['details', 'name']));
    expect(actions.updateDirectoryAction).toHaveBeenCalledWith('p1', { email: 'person@example.test', phone: null, preferredContact: 'phone' }, 3);
    expect(guestActions.updateContact).toHaveBeenCalledWith('p1', { name: 'Beispiel Person Zwei', companyOrRole: 'Einkauf', note: null });
  });

  it('when the details are refused, the name is not saved either and the form stays open', async () => {
    actions.updateDirectoryAction.mockResolvedValue({ ok: false, error: 'stale' });
    const user = renderPage();
    const form = await startEdit(user, 'Beispiel Person', 'Person bearbeiten');
    await user.type(within(form).getByLabelText('Name'), ' Zwei');
    await user.type(within(form).getByLabelText('Telefon'), '030 000000');
    await user.click(within(form).getByRole('button', { name: 'Speichern' }));

    expect((await within(form).findByRole('alert')).textContent).toContain('wurde inzwischen geändert');
    expect(guestActions.updateContact).not.toHaveBeenCalled();
    expect((within(form).getByLabelText('Name') as HTMLInputElement).value).toBe('Beispiel Person Zwei');
  });

  it('a name that already exists is reported under the name input', async () => {
    guestActions.updateContact.mockResolvedValue({ ok: false, error: 'contact_duplicate', detail: 'p2' });
    const user = renderPage();
    const form = await startEdit(user, 'Beispiel Person', 'Person bearbeiten');
    const name = within(form).getByLabelText('Name');
    await user.clear(name);
    await user.type(name, 'Anna Verknüpft');
    await user.click(within(form).getByRole('button', { name: 'Speichern' }));

    await waitFor(() => expect(name.getAttribute('aria-invalid')).toBe('true'));
    expect(within(form).getByText('Diesen Kontakt gibt es bereits.')).toBeTruthy();
    expect(screen.getByRole('form', { name: 'Person bearbeiten' })).toBeTruthy();
  });

  it('marks an unreadable number under its input and sends nothing', async () => {
    const user = renderPage();
    const form = await startEdit(user, 'Beispiel Person', 'Person bearbeiten');
    const seats = within(form).getByLabelText('Plätze');
    await user.clear(seats);
    await user.type(seats, 'vier');
    await user.click(within(form).getByRole('button', { name: 'Speichern' }));
    expect(await screen.findByText('Dieser Wert passt nicht zum Feld.')).toBeTruthy();
    expect(seats.getAttribute('aria-invalid')).toBe('true');
    expect(actions.updateDirectoryAction).not.toHaveBeenCalled();
    expect(guestActions.updateContact).not.toHaveBeenCalled();
  });

  it('shows the error the package returns under the field it names', async () => {
    actions.updateDirectoryAction.mockResolvedValue({ ok: false, error: 'field_archived', field: 'seats' });
    const user = renderPage();
    const form = await startEdit(user, 'Beispiel Person', 'Person bearbeiten');
    const seats = within(form).getByLabelText('Plätze');
    await user.clear(seats);
    await user.type(seats, '5');
    await user.click(within(form).getByRole('button', { name: 'Speichern' }));
    expect(await screen.findByText('Das Feld ist archiviert und nimmt keine neuen Werte an.')).toBeTruthy();
  });

  it('saving without a change calls nothing and closes the form', async () => {
    const user = renderPage();
    const form = await startEdit(user, 'Beispiel Person', 'Person bearbeiten');
    await user.click(within(form).getByRole('button', { name: 'Speichern' }));
    expect(screen.queryByRole('form')).toBeNull();
    expect(actions.updateDirectoryAction).not.toHaveBeenCalled();
    expect(guestActions.updateContact).not.toHaveBeenCalled();
  });

  it('an organization is saved with all its fields through the directory action', async () => {
    actions.updateDirectoryAction.mockImplementation(async (id: string, patch: Partial<DirectoryContact>) => ({ ok: true, value: patchServer(id, patch) }));
    const user = renderPage();
    const form = await startEdit(user, 'Musterwerk', 'Organisation bearbeiten');
    expect(within(form).queryByLabelText('Firma oder Funktion')).toBeNull();
    await user.type(within(form).getByLabelText('Umsatzsteuer-ID'), 'DE000000000');
    await user.type(within(form).getByLabelText('Land (Zwei-Buchstaben-Code, z. B. DE)'), 'de');
    await user.click(within(form).getByRole('button', { name: 'Speichern' }));

    await waitFor(() => expect(actions.updateDirectoryAction).toHaveBeenCalled());
    expect(actions.updateDirectoryAction).toHaveBeenCalledWith(
      'o1',
      expect.objectContaining({ name: 'Musterwerk', postalCode: '10115', city: 'Beispielstadt', vatId: 'DE000000000', country: 'DE', note: null }),
      3,
    );
    expect(guestActions.updateContact).not.toHaveBeenCalled();
  });

  it('Escape leaves an untouched form but never discards typed changes', async () => {
    const user = renderPage();
    let form = await startEdit(user, 'Beispiel Person', 'Person bearbeiten');
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('form')).toBeNull();
    expect(panel('Beispiel Person')).toBeTruthy();

    await user.click(within(panel('Beispiel Person')).getByRole('button', { name: 'Bearbeiten' }));
    form = screen.getByRole('form', { name: 'Person bearbeiten' });
    await user.type(within(form).getByLabelText('Telefon'), '030');
    await user.keyboard('{Escape}');
    expect((within(screen.getByRole('form', { name: 'Person bearbeiten' })).getByLabelText('Telefon') as HTMLInputElement).value).toBe('030');

    await user.click(within(form).getByRole('button', { name: 'Abbrechen' }));
    expect(screen.queryByRole('form')).toBeNull();
    expect(within(panel('Beispiel Person')).queryByText('030')).toBeNull();
  });
});

describe('contacts page: creating', () => {
  const created = (input: Partial<DirectoryContact> & { kind: 'person' | 'organization'; name: string }, id: string) => {
    const row = contact({ id, kind: input.kind, name: input.name, companyOrRole: input.companyOrRole ?? '' });
    server.contacts = [...server.contacts, row];
    return row;
  };

  async function startCreate(user: ReturnType<typeof userEvent.setup>) {
    await user.click(screen.getByRole('button', { name: 'Kontakt anlegen' }));
    return panel('Kontakt anlegen');
  }

  it('asks first whether it is a person or an organization, and shows no form before that', async () => {
    const user = renderPage();
    const region = await startCreate(user);
    const choice = within(region).getByRole('group', { name: 'Was soll angelegt werden?' });
    expect(within(choice).getAllByRole('button').map((b) => b.textContent)).toEqual(['Person', 'Organisation']);
    expect(screen.queryByRole('form')).toBeNull();
    expect(document.activeElement).toBe(within(region).getByRole('heading', { name: 'Kontakt anlegen' }));

    await user.click(within(choice).getByRole('button', { name: 'Person' }));
    const form = screen.getByRole('form', { name: 'Neue Person' });
    expect(within(form).getByLabelText('Firma oder Funktion')).toBeTruthy();
    expect(within(form).queryByLabelText('Umsatzsteuer-ID')).toBeNull();
  });

  it('a new person carries its details, is listed once and is opened', async () => {
    actions.createDirectoryAction.mockImplementation(async (input: Partial<DirectoryContact> & { kind: 'person'; name: string }) => ({ ok: true, value: created(input, 'p9') }));
    const user = renderPage();
    const region = await startCreate(user);
    await user.click(within(region).getByRole('button', { name: 'Person' }));
    const form = screen.getByRole('form', { name: 'Neue Person' });
    await user.type(within(form).getByLabelText('Name'), 'Neue Testperson');
    await user.type(within(form).getByLabelText('Firma oder Funktion'), 'Beispiel');
    await user.type(within(form).getByLabelText('E-Mail'), 'person@example.test');
    await user.selectOptions(within(form).getByLabelText('Bevorzugter Kontaktweg'), 'email');
    await user.type(within(form).getByLabelText('Plätze'), '3');
    await user.click(within(form).getByRole('button', { name: 'Speichern' }));

    await waitFor(() =>
      expect(actions.createDirectoryAction).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: 'person',
          name: 'Neue Testperson',
          companyOrRole: 'Beispiel',
          email: 'person@example.test',
          preferredContact: 'email',
          customFields: { seats: 3 },
        }),
      ),
    );
    expect(await screen.findByText('Person angelegt.')).toBeTruthy();
    await waitFor(() => expect(rowNames()).toEqual(['Anna Verknüpft', 'Beispiel Person', 'Musterwerk', 'Neue Testperson']));
    expect(within(list()).getAllByRole('button', { name: /Neue Testperson/ })).toHaveLength(1);
    expect(panel('Neue Testperson')).toBeTruthy();
    expect(row('Neue Testperson').getAttribute('aria-current')).toBe('true');
  });

  it('a new organization carries its details too', async () => {
    actions.createDirectoryAction.mockImplementation(async (input: Partial<DirectoryContact> & { kind: 'organization'; name: string }) => ({ ok: true, value: created(input, 'o9') }));
    const user = renderPage();
    const region = await startCreate(user);
    await user.click(within(region).getByRole('button', { name: 'Organisation' }));
    const form = screen.getByRole('form', { name: 'Neue Organisation' });
    await user.type(within(form).getByLabelText('Name'), 'Neue Organisation');
    await user.type(within(form).getByLabelText('Ort'), 'Beispielstadt');
    await user.selectOptions(within(form).getByLabelText('Bevorzugter Kontaktweg'), 'post');
    await user.type(within(form).getByLabelText('Plätze'), '12');
    await user.click(within(form).getByRole('button', { name: 'Speichern' }));

    await waitFor(() =>
      expect(actions.createDirectoryAction).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'organization', name: 'Neue Organisation', city: 'Beispielstadt', preferredContact: 'post', customFields: { seats: 12 } }),
      ),
    );
    expect(await screen.findByText('Organisation angelegt.')).toBeTruthy();
  });

  it('changing the kind keeps what was typed (backtrack and revise)', async () => {
    actions.createDirectoryAction.mockImplementation(async (input: Partial<DirectoryContact> & { kind: 'organization'; name: string }) => ({ ok: true, value: created(input, 'o9') }));
    const user = renderPage();
    const region = await startCreate(user);
    await user.click(within(region).getByRole('button', { name: 'Person' }));
    await user.type(within(screen.getByRole('form', { name: 'Neue Person' })).getByLabelText('Name'), 'Doch eine Firma');
    await user.type(within(screen.getByRole('form', { name: 'Neue Person' })).getByLabelText('Firma oder Funktion'), 'Nur für Personen');

    await user.click(within(region).getByRole('button', { name: 'Organisation' }));
    const form = screen.getByRole('form', { name: 'Neue Organisation' });
    expect((within(form).getByLabelText('Name') as HTMLInputElement).value).toBe('Doch eine Firma');
    await user.click(within(form).getByRole('button', { name: 'Speichern' }));

    await waitFor(() => expect(actions.createDirectoryAction).toHaveBeenCalled());
    const sent = actions.createDirectoryAction.mock.calls[0][0];
    expect(sent).toMatchObject({ kind: 'organization', name: 'Doch eine Firma' });
    // What only a person records is not sent for an organization.
    expect(sent).not.toHaveProperty('companyOrRole');
  });

  it('a value the package refuses is shown under its input and the form stays open with its values', async () => {
    actions.createDirectoryAction.mockResolvedValue({ ok: false, error: 'invalid_value', field: 'seats' });
    const user = renderPage();
    const region = await startCreate(user);
    await user.click(within(region).getByRole('button', { name: 'Person' }));
    const form = screen.getByRole('form', { name: 'Neue Person' });
    await user.type(within(form).getByLabelText('Name'), 'Neue Testperson');
    // Taken before the save: once the error line is shown it is part of the label.
    const input = within(form).getByLabelText('Plätze');
    await user.type(input, '4');
    await user.click(within(form).getByRole('button', { name: 'Speichern' }));

    await waitFor(() => expect(input.getAttribute('aria-invalid')).toBe('true'));
    expect(within(form).getByText('Dieser Wert passt nicht zum Feld.')).toBeTruthy();
    expect((within(screen.getByRole('form', { name: 'Neue Person' })).getByLabelText('Name') as HTMLInputElement).value).toBe('Neue Testperson');
  });

  it('a contact that already exists is reported under the name', async () => {
    actions.createDirectoryAction.mockResolvedValue({ ok: false, error: 'duplicate' });
    const user = renderPage();
    const region = await startCreate(user);
    await user.click(within(region).getByRole('button', { name: 'Organisation' }));
    const form = screen.getByRole('form', { name: 'Neue Organisation' });
    const name = within(form).getByLabelText('Name');
    await user.type(name, 'Musterwerk');
    await user.click(within(form).getByRole('button', { name: 'Speichern' }));
    await waitFor(() => expect(name.getAttribute('aria-invalid')).toBe('true'));
    expect(within(form).getByText('Diesen Kontakt gibt es bereits.')).toBeTruthy();
  });

  it('cannot be saved without a name', async () => {
    const user = renderPage();
    const region = await startCreate(user);
    await user.click(within(region).getByRole('button', { name: 'Person' }));
    const form = screen.getByRole('form', { name: 'Neue Person' });
    expect((within(form).getByRole('button', { name: 'Speichern' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('cancelling returns the focus to the button it started from, and starting again begins empty', async () => {
    const user = renderPage();
    let region = await startCreate(user);
    await user.click(within(region).getByRole('button', { name: 'Person' }));
    await user.type(within(screen.getByRole('form', { name: 'Neue Person' })).getByLabelText('Name'), 'Verworfen');
    await user.click(within(region).getByRole('button', { name: 'Abbrechen' }));
    expect(queryPanel('Kontakt anlegen')).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Kontakt anlegen' }));

    region = await startCreate(user);
    expect(screen.queryByRole('form')).toBeNull();
    await user.click(within(region).getByRole('button', { name: 'Person' }));
    expect((within(screen.getByRole('form', { name: 'Neue Person' })).getByLabelText('Name') as HTMLInputElement).value).toBe('');
  });

  it('starting from the tools tab leads back to the list', async () => {
    const user = renderPage();
    await user.click(screen.getByRole('tab', { name: 'Verwaltung' }));
    await user.click(screen.getByRole('button', { name: 'Kontakt anlegen' }));
    expect(screen.getByRole('tab', { name: /Kontakte/ }).getAttribute('aria-selected')).toBe('true');
    expect(panel('Kontakt anlegen')).toBeTruthy();
  });
});

describe('contacts page: the rare tools are out of the main flow', () => {
  it('the list tab shows neither merging nor custom field definitions', () => {
    renderPage();
    expect(screen.queryByRole('heading', { name: 'Zusammenführen' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Eigene Felder' })).toBeNull();
    expect(screen.queryByLabelText('Name des Feldes')).toBeNull();
  });

  it('each tool says in one sentence what it is for', async () => {
    const user = renderPage();
    await user.click(screen.getByRole('tab', { name: 'Verwaltung' }));
    expect(within(screen.getByRole('region', { name: 'Zusammenführen' })).getByText(/Für doppelt angelegte Kontakte/)).toBeTruthy();
    expect(within(screen.getByRole('region', { name: 'Eigene Felder' })).getByText(/Zusätzliche Angaben/)).toBeTruthy();
    expect(screen.queryByRole('list', { name: 'Kontakte' })).toBeNull();
  });

  it('merges two contacts of the same kind after a confirmation', async () => {
    actions.mergeDirectoryAction.mockImplementation(async (loserId: string, winnerId: string) => {
      server.contacts = server.contacts.filter((c) => c.id !== loserId);
      return { ok: true, value: { outcome: 'merged', winner: server.contacts.find((c) => c.id === winnerId)!, repointed: 0 } };
    });
    const user = renderPage();
    await user.click(screen.getByRole('tab', { name: 'Verwaltung' }));
    const tool = screen.getByRole('region', { name: 'Zusammenführen' });
    const loser = within(tool).getByLabelText('Wird entfernt');
    const winner = within(tool).getByLabelText('Bleibt bestehen') as HTMLSelectElement;
    // Archived contacts are not offered.
    expect(within(loser).queryByRole('option', { name: /Zoe Archiviert/ })).toBeNull();
    expect(winner.disabled).toBe(true);

    await user.selectOptions(loser, 'p1');
    // Only the other person is offered: a person and an organization cannot be merged.
    expect(within(winner).getAllByRole('option').map((o) => (o as HTMLOptionElement).value)).toEqual(['', 'p2']);
    await user.selectOptions(winner, 'p2');
    await user.click(within(tool).getByRole('button', { name: 'Zusammenführen' }));

    const dialog = within(tool).getByRole('alertdialog');
    expect(dialog.textContent).toContain('Beispiel Person in Anna Verknüpft aufgehen lassen?');
    expect(actions.mergeDirectoryAction).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole('button', { name: 'Jetzt zusammenführen' }));

    await waitFor(() => expect(actions.mergeDirectoryAction).toHaveBeenCalledWith('p1', 'p2'));
    expect(await screen.findByText('Zusammengeführt.')).toBeTruthy();
    await user.click(screen.getByRole('tab', { name: /Kontakte/ }));
    expect(rowNames()).toEqual(['Anna Verknüpft', 'Musterwerk']);
  });

  it('cancelling the merge question merges nothing', async () => {
    const user = renderPage();
    await user.click(screen.getByRole('tab', { name: 'Verwaltung' }));
    const tool = screen.getByRole('region', { name: 'Zusammenführen' });
    await user.selectOptions(within(tool).getByLabelText('Wird entfernt'), 'p1');
    await user.selectOptions(within(tool).getByLabelText('Bleibt bestehen'), 'p2');
    await user.click(within(tool).getByRole('button', { name: 'Zusammenführen' }));
    await user.click(within(tool).getByRole('button', { name: 'Abbrechen' }));
    expect(within(tool).queryByRole('alertdialog')).toBeNull();
    expect(actions.mergeDirectoryAction).not.toHaveBeenCalled();
  });

  it('a failed merge is shown on the tools tab and keeps the choice', async () => {
    actions.mergeDirectoryAction.mockResolvedValue({ ok: false, error: 'kind_mismatch' });
    const user = renderPage();
    await user.click(screen.getByRole('tab', { name: 'Verwaltung' }));
    const tool = screen.getByRole('region', { name: 'Zusammenführen' });
    await user.selectOptions(within(tool).getByLabelText('Wird entfernt'), 'p1');
    await user.selectOptions(within(tool).getByLabelText('Bleibt bestehen'), 'p2');
    await user.click(within(tool).getByRole('button', { name: 'Zusammenführen' }));
    await user.click(within(tool).getByRole('button', { name: 'Jetzt zusammenführen' }));
    expect((await screen.findByRole('alert')).textContent).toContain('können nicht zusammengeführt werden');
    expect((within(tool).getByLabelText('Wird entfernt') as HTMLSelectElement).value).toBe('p1');
  });

  it('defines a new field with a key derived from its label', async () => {
    actions.createFieldAction.mockImplementation(async (input: { key: string; label: string }) => {
      const field: DirectoryField = { key: input.key, label: input.label, type: 'text', options: null, archived: false };
      server.fields = [...server.fields, field];
      return { ok: true, value: field };
    });
    const user = renderPage();
    await user.click(screen.getByRole('tab', { name: 'Verwaltung' }));
    const tool = screen.getByRole('region', { name: 'Eigene Felder' });
    await user.type(within(tool).getByLabelText('Name des Feldes'), 'Bevorzugte Küche');
    await user.click(within(tool).getByRole('button', { name: 'Feld anlegen' }));

    await waitFor(() => expect(actions.createFieldAction).toHaveBeenCalledWith({ key: 'bevorzugte_kueche', label: 'Bevorzugte Küche', type: 'text', options: null }));
    expect(await screen.findByText('Feld angelegt.')).toBeTruthy();
    expect((within(tool).getByLabelText('Name des Feldes') as HTMLInputElement).value).toBe('');
    // The new field is on the form of a contact straight away.
    await user.click(screen.getByRole('tab', { name: /Kontakte/ }));
    await user.click(within(await openPanel(user, 'Beispiel Person')).getByRole('button', { name: 'Bearbeiten' }));
    expect(screen.getByLabelText('Bevorzugte Küche')).toBeTruthy();
  });

  it('a choice field needs its options', async () => {
    actions.createFieldAction.mockResolvedValue({ ok: true, value: SEATS });
    const user = renderPage();
    await user.click(screen.getByRole('tab', { name: 'Verwaltung' }));
    const tool = screen.getByRole('region', { name: 'Eigene Felder' });
    await user.type(within(tool).getByLabelText('Name des Feldes'), 'Kategorie');
    await user.selectOptions(within(tool).getByLabelText('Art'), 'select');
    const create = within(tool).getByRole('button', { name: 'Feld anlegen' }) as HTMLButtonElement;
    expect(create.disabled).toBe(true);
    await user.type(within(tool).getByLabelText('Optionen, durch Komma getrennt'), 'A, B, A');
    await user.click(create);
    await waitFor(() => expect(actions.createFieldAction).toHaveBeenCalledWith({ key: 'kategorie', label: 'Kategorie', type: 'select', options: ['A', 'B'] }));
  });

  it('archives a field', async () => {
    actions.archiveFieldAction.mockImplementation(async (key: string) => {
      server.fields = server.fields.map((f) => (f.key === key ? { ...f, archived: true } : f));
      return { ok: true, value: server.fields[0] };
    });
    const user = renderPage();
    await user.click(screen.getByRole('tab', { name: 'Verwaltung' }));
    await user.click(screen.getByRole('button', { name: 'Feld Plätze archivieren' }));
    await waitFor(() => expect(actions.archiveFieldAction).toHaveBeenCalledWith('seats'));
    expect(await screen.findByText('Feld archiviert.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Feld Plätze archivieren' })).toBeNull();
    expect(screen.getByText(/\(archiviert\)/)).toBeTruthy();
  });
});
