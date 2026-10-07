// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Contact } from '@/lib/contacts/store';
import type { MealDetailsInput } from '@/lib/meals/input';
import { GUEST_A, SMALL_BUSINESS, UNANSWERED, meal } from '@/lib/meals/__tests__/fixtures';
import type { MealRecord } from '@/lib/meals/types';
import MealDetailsForm, { type SaveMealResult } from '../MealDetailsForm';

afterEach(cleanup);

const CONTACTS: Contact[] = [
  { id: 'c-1', name: 'Erika Beispiel', companyOrRole: 'Beispiel GmbH', note: null, archived: false },
  { id: 'c-2', name: 'Max Muster', companyOrRole: 'Muster AG', note: null, archived: false },
  { id: 'c-9', name: 'Alma Archiv', companyOrRole: '', note: null, archived: true },
];

const untouched = meal({
  mealType: null, occasion: '', place: '', host: '', tip: null, consumption: null, detailsAt: null, guests: [],
});

/** A save that behaves like the server: stores the input on the record. */
function savingServer(record: MealRecord) {
  return vi.fn(async (_rowId: string, input: MealDetailsInput): Promise<SaveMealResult> => {
    const guests = input.guestContactIds.map((id) => {
      const c = CONTACTS.find((x) => x.id === id)!;
      return { contactId: c.id, name: c.name, company: c.companyOrRole };
    });
    return {
      ok: true,
      value: {
        changed: true,
        record: { ...record, ...input, date: input.date ?? record.date, gross: input.gross ?? record.gross, guests },
      },
    };
  });
}

function setup(record: MealRecord, overrides: Partial<React.ComponentProps<typeof MealDetailsForm>> = {}) {
  const onSave = overrides.onSave ?? savingServer(record);
  const onCreateContact = overrides.onCreateContact ?? vi.fn();
  const onSaved = vi.fn();
  render(
    <MealDetailsForm
      record={record}
      contacts={CONTACTS}
      settings={SMALL_BUSINESS}
      defaultHost="Inhaber Beispiel"
      onSave={onSave}
      onCreateContact={onCreateContact}
      onSaved={onSaved}
      {...overrides}
    />,
  );
  return { onSave, onCreateContact, onSaved, user: userEvent.setup() };
}

describe('forward', () => {
  it('an untouched receipt: pick a guest, name the occasion, see "Vollständig" with the amount, save', async () => {
    const { user, onSave, onSaved } = setup(untouched);
    // Prefilled, nothing asked twice.
    expect(screen.getByLabelText('Ort (Name und Anschrift)')).toHaveProperty('value', 'Testlokal');
    expect(screen.getByLabelText('Gastgeber')).toHaveProperty('value', 'Inhaber Beispiel');
    expect(screen.getByText(/Noch nicht vollständig/)).toBeTruthy();

    await user.type(screen.getByRole('combobox'), 'eri');
    await user.keyboard('{Enter}');
    expect(within(screen.getByLabelText('Ausgewählte Teilnehmer')).getByText('Erika Beispiel (Beispiel GmbH)')).toBeTruthy();

    await user.type(screen.getByLabelText('Anlass'), 'Planung Messeauftritt 2026');
    await user.type(screen.getByLabelText('Trinkgeld'), '11,00');

    expect(screen.getByText('Vollständig.')).toBeTruthy();
    // 70 percent of 119 + 11.
    expect(screen.getByText(/91,00/)).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Speichern' }));
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenCalledWith('row-1', {
      mealType: 'business_meal_external',
      occasion: 'Planung Messeauftritt 2026',
      place: 'Testlokal',
      host: 'Inhaber Beispiel',
      tip: 11,
      consumption: null,
      taxLines: null,
      guestContactIds: ['c-1'],
      date: '2025-03-14',
      gross: 119,
    });
    expect(await screen.findByText('Gespeichert.')).toBeTruthy();
    expect(onSaved).toHaveBeenCalledWith(expect.objectContaining({ occasion: 'Planung Messeauftritt 2026' }), true);
  });

  it('never offers an archived contact', async () => {
    const { user } = setup(untouched);
    await user.type(screen.getByRole('combobox'), 'Alma');
    expect(screen.queryByRole('option', { name: /Alma Archiv/ })).toBeNull();
  });

  it('a new guest is created inline and added', async () => {
    const created: Contact = { id: 'c-3', name: 'Nora Neu', companyOrRole: 'Neu KG', note: null, archived: false };
    const onCreateContact = vi.fn(async () => ({ ok: true as const, value: created }));
    const onContactCreated = vi.fn();
    const { user } = setup(untouched, { onCreateContact, onContactCreated });
    await user.type(screen.getByRole('combobox'), 'Nora Neu');
    await user.click(screen.getByRole('option', { name: /Neuen Kontakt anlegen/ }));
    await user.type(screen.getByLabelText('Firma oder Funktion des neuen Kontakts'), 'Neu KG');
    await user.click(screen.getByRole('button', { name: 'Anlegen und hinzufügen' }));
    expect(onCreateContact).toHaveBeenCalledWith({ name: 'Nora Neu', companyOrRole: 'Neu KG' });
    expect(await screen.findByText('Nora Neu (Neu KG)')).toBeTruthy();
    expect(onContactCreated).toHaveBeenCalledWith(created);
  });

  it('creating a contact that already exists selects the existing one instead of failing', async () => {
    const onCreateContact = vi.fn(async () => ({ ok: false as const, error: 'contact_duplicate', detail: 'c-2' }));
    const { user } = setup(untouched, { onCreateContact });
    await user.type(screen.getByRole('combobox'), 'M. Muster');
    await user.click(screen.getByRole('option', { name: /Neuen Kontakt anlegen/ }));
    await user.click(screen.getByRole('button', { name: 'Anlegen und hinzufügen' }));
    expect(await screen.findByText('Max Muster (Muster AG)')).toBeTruthy();
  });
});

describe('backtrack and revise', () => {
  it('switching to "Keine Bewirtung" and back keeps every entered detail', async () => {
    const { user } = setup(meal());
    expect(screen.getByText('Vollständig.')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Keine Bewirtung' }));
    expect(screen.queryByText('Vollständig.')).toBeNull();
    expect(screen.queryByLabelText('Anlass')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Geschäftsessen (extern)' }));
    expect(screen.getByLabelText('Anlass')).toHaveProperty('value', 'Abstimmung Relaunch Webshop, Angebot Phase 2');
    expect(screen.getByText('Erika Beispiel (Beispiel GmbH)')).toBeTruthy();
    expect(screen.getByText('Vollständig.')).toBeTruthy();
    // Back where it started: nothing to save.
    expect(screen.queryByText('Ungespeicherte Änderungen')).toBeNull();
  });

  it('removing the only guest shows the "eaten alone" help with a way forward', async () => {
    const { user } = setup(meal());
    await user.click(screen.getByRole('button', { name: 'Erika Beispiel entfernen' }));
    expect(screen.getByText(/Ohne Gast ist es keine Bewirtung/)).toBeTruthy();
    expect(screen.getByText(/Es fehlt: Teilnehmer/)).toBeTruthy();
    const hint = screen.getByText(/Ohne Gast ist es keine Bewirtung/).closest('.ui-note') as HTMLElement;
    await user.click(within(hint).getByRole('button', { name: 'Verpflegung auf Reise' }));
    expect(screen.getByText(/wird gesondert gezählt, nicht im Verzeichnis/)).toBeTruthy();
  });

  it('changing the tip changes the shown deductible amount at once', async () => {
    const { user } = setup(meal({ gross: 100, tip: null }));
    expect(screen.getByText(/70,00/)).toBeTruthy();
    await user.type(screen.getByLabelText('Trinkgeld'), '10');
    expect(screen.getByText(/77,00/)).toBeTruthy();
  });

  it('a generic occasion is called out as such', async () => {
    const { user } = setup(meal({ occasion: '' }));
    await user.type(screen.getByLabelText('Anlass'), 'Geschäftsessen');
    expect(screen.getByText(/Zu allgemein/)).toBeTruthy();
  });
});

describe('resume', () => {
  it('a partially saved entry opens with what was saved and says exactly what is missing', () => {
    setup(meal({ occasion: '', guests: [], host: 'Andere Gastgeberin' }));
    expect(screen.getByLabelText('Gastgeber')).toHaveProperty('value', 'Andere Gastgeberin');
    expect(screen.getByLabelText('Trinkgeld')).toHaveProperty('value', '11');
    expect(screen.getByText(/Es fehlt: Anlass, Teilnehmer/)).toBeTruthy();
    expect(screen.queryByText('Ungespeicherte Änderungen')).toBeNull();
  });

  it('a row reclassified away from Bewirtung says the details are kept but not in the register', () => {
    setup(meal({ category: 'Reisekosten' }));
    expect(screen.getByText(/nicht mehr als Bewirtung kategorisiert/)).toBeTruthy();
    expect(screen.getByLabelText('Anlass')).toHaveProperty('value', 'Abstimmung Relaunch Webshop, Angebot Phase 2');
  });

  it('a refreshed copy of the same row does not wipe what is being typed; another row starts fresh', async () => {
    const record = meal({ occasion: '' });
    const props = {
      contacts: CONTACTS, settings: SMALL_BUSINESS, defaultHost: 'Inhaber Beispiel',
      onSave: vi.fn(), onCreateContact: vi.fn(),
    };
    const user = userEvent.setup();
    const { rerender } = render(<MealDetailsForm record={record} {...props} />);
    await user.type(screen.getByLabelText('Anlass'), 'Halb getippt');
    rerender(<MealDetailsForm record={{ ...record, confidence: 50 }} {...props} />);
    expect(screen.getByLabelText('Anlass')).toHaveProperty('value', 'Halb getippt');
    rerender(<MealDetailsForm record={meal({ rowId: 'row-2', occasion: 'Anderer Beleg, anderes Thema' })} {...props} />);
    expect(screen.getByLabelText('Anlass')).toHaveProperty('value', 'Anderer Beleg, anderes Thema');
  });
});

describe('re-entry', () => {
  it('saving a completed entry untouched reports that nothing changed', async () => {
    const record = meal();
    const onSave = vi.fn(async (): Promise<SaveMealResult> => ({ ok: true, value: { record, changed: false } }));
    const { user, onSaved } = setup(record, { onSave });
    await user.click(screen.getByRole('button', { name: 'Speichern' }));
    expect(await screen.findByText('Keine Änderungen, nichts gespeichert.')).toBeTruthy();
    expect(onSaved).toHaveBeenCalledWith(record, false);
  });

  it('editing a completed entry saves the edit in place', async () => {
    const { user, onSave } = setup(meal());
    const occasion = screen.getByLabelText('Anlass');
    await user.clear(occasion);
    await user.type(occasion, 'Abnahme Fotoproduktion');
    expect(screen.getByText('Ungespeicherte Änderungen')).toBeTruthy();
    await user.keyboard('{Control>}{Enter}{/Control}');
    expect(onSave).toHaveBeenCalledWith('row-1', expect.objectContaining({ occasion: 'Abnahme Fotoproduktion', guestContactIds: [GUEST_A.contactId] }));
  });
});

describe('errors surface and the draft survives', () => {
  it('a refused save shows the reason and keeps the input', async () => {
    const onSave = vi.fn(async (): Promise<SaveMealResult> => ({ ok: false, error: 'unauthorized' }));
    const { user, onSaved } = setup(meal({ occasion: '' }), { onSave });
    await user.type(screen.getByLabelText('Anlass'), 'Planung Messeauftritt');
    await user.click(screen.getByRole('button', { name: 'Speichern' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/Anmeldung ist abgelaufen/);
    expect(screen.getByLabelText('Anlass')).toHaveProperty('value', 'Planung Messeauftritt');
    expect(onSaved).not.toHaveBeenCalled();
  });

  it('a save that throws (no connection) shows an error instead of looking like success', async () => {
    const onSave = vi.fn(async () => {
      throw new Error('fetch failed');
    });
    const { user } = setup(meal(), { onSave });
    await user.type(screen.getByLabelText('Trinkgeld'), '1');
    await user.click(screen.getByRole('button', { name: 'Speichern' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/nicht geklappt/);
    expect(screen.queryByText('Gespeichert.')).toBeNull();
  });

  it('an unreadable amount is marked and nothing is sent', async () => {
    const { user, onSave } = setup(meal());
    const tip = screen.getByLabelText('Trinkgeld');
    await user.clear(tip);
    await user.type(tip, 'zehn');
    await user.click(screen.getByRole('button', { name: 'Speichern' }));
    expect(onSave).not.toHaveBeenCalled();
    expect(tip.getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByText(/Bitte einen Betrag eingeben/)).toBeTruthy();
  });
});

describe('settings', () => {
  it('without the section 19 answer the form shows no amount and says where to answer', () => {
    setup(meal(), { settings: UNANSWERED });
    expect(screen.getByText(/Kleinunternehmerregelung beantwortet/)).toBeTruthy();
    expect(screen.queryByText(/Abziehbar 70 %/)).toBeNull();
  });

  it('warns when the total is above the host-name threshold', () => {
    setup(meal({ gross: 300 }));
    expect(screen.getByText(/muss die\s+Rechnung Namen und Anschrift des Gastgebers tragen/)).toBeTruthy();
  });
});
