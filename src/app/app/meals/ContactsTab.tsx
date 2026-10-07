'use client';

import { useState } from 'react';
import type { Contact } from '@/lib/contacts/store';
import { mealActionMessage } from '@/lib/meals/messages';
import { createContact, setContactArchived, updateContact } from './actions';

interface ContactsTabProps {
  contacts: Contact[];
  onContactChanged: (contact: Contact) => void;
}

interface Editing {
  id: string | null; // null = new contact
  name: string;
  company: string;
  note: string;
}

/** The contact list: the people who can be named as guests. Add, correct, archive. */
export default function ContactsTab({ contacts, onContactChanged }: ContactsTabProps) {
  const [editing, setEditing] = useState<Editing | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);

  const visible = contacts.filter((c) => showArchived || !c.archived);
  const archivedCount = contacts.filter((c) => c.archived).length;

  const save = async () => {
    if (!editing || busy) return;
    setBusy(editing.id ?? 'new');
    setError(null);
    try {
      const input = { name: editing.name, companyOrRole: editing.company, note: editing.note };
      const result = editing.id ? await updateContact(editing.id, input) : await createContact(input);
      if (!result.ok) {
        setError(mealActionMessage(result.error, result.detail));
        return;
      }
      onContactChanged(result.value);
      setEditing(null);
    } catch {
      setError(mealActionMessage('failed'));
    } finally {
      setBusy(null);
    }
  };

  const toggleArchived = async (contact: Contact) => {
    if (busy) return;
    setBusy(contact.id);
    setError(null);
    try {
      const result = await setContactArchived(contact.id, !contact.archived);
      if (!result.ok) {
        setError(mealActionMessage(result.error, result.detail));
        return;
      }
      onContactChanged(result.value);
    } catch {
      setError(mealActionMessage('failed'));
    } finally {
      setBusy(null);
    }
  };

  const editor = editing && (
    <form
      className="glass-panel space-y-3 rounded-xl p-4"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <h2 className="text-sm font-semibold" style={{ color: 'var(--foreground)' }}>
        {editing.id ? 'Kontakt korrigieren' : 'Neuer Kontakt'}
      </h2>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block">
          <span className="ui-label">Name</span>
          <input className="ui-input" value={editing.name} autoFocus onChange={(e) => setEditing({ ...editing, name: e.target.value })} />
        </label>
        <label className="block">
          <span className="ui-label">Firma oder Funktion</span>
          <input className="ui-input" value={editing.company} onChange={(e) => setEditing({ ...editing, company: e.target.value })} />
        </label>
      </div>
      <label className="block">
        <span className="ui-label">Notiz (optional, wird nicht gedruckt)</span>
        <input className="ui-input" value={editing.note} onChange={(e) => setEditing({ ...editing, note: e.target.value })} />
      </label>
      {editing.id && (
        <p className="text-xs" style={{ color: 'var(--muted)' }}>
          Eine Korrektur gilt auch für bereits erfasste Bewirtungen mit diesem Kontakt.
        </p>
      )}
      <div className="flex gap-2">
        <button type="submit" className="ui-btn ui-btn-primary" disabled={Boolean(busy) || !editing.name.trim()}>
          {busy ? 'Wird gespeichert…' : 'Speichern'}
        </button>
        <button type="button" className="ui-btn" onClick={() => { setEditing(null); setError(null); }} disabled={Boolean(busy)}>
          Abbrechen
        </button>
      </div>
    </form>
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm" style={{ color: 'var(--muted)' }}>
          Personen, die als Teilnehmer einer Bewirtung ausgewählt werden können.
        </p>
        <div className="flex gap-2">
          {archivedCount > 0 && (
            <button type="button" className="ui-btn ui-btn-sm" aria-pressed={showArchived} onClick={() => setShowArchived((v) => !v)}>
              {showArchived ? 'Archivierte ausblenden' : `Archivierte anzeigen (${archivedCount})`}
            </button>
          )}
          <button type="button" className="ui-btn ui-btn-primary ui-btn-sm" onClick={() => { setEditing({ id: null, name: '', company: '', note: '' }); setError(null); }}>
            Kontakt anlegen
          </button>
        </div>
      </div>

      {error && (
        <p role="alert" className="ui-note ui-note-danger">
          {error}
        </p>
      )}

      {editing && editing.id === null && editor}

      {visible.length === 0 ? (
        <div className="glass-panel rounded-xl p-8 text-center text-sm" style={{ color: 'var(--muted)' }}>
          Noch keine Kontakte. Kontakte entstehen auch direkt beim Erfassen einer Bewirtung: einfach den Namen eintippen.
        </div>
      ) : (
        <ul className="space-y-2">
          {visible.map((c) =>
            editing?.id === c.id ? (
              <li key={c.id}>{editor}</li>
            ) : (
              <li key={c.id} className="glass-panel flex flex-wrap items-center justify-between gap-3 rounded-xl px-4 py-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium" style={{ color: c.archived ? 'var(--muted)' : 'var(--foreground)' }}>
                    {c.name}
                    {c.archived && <span className="ml-2 text-xs font-normal">(archiviert)</span>}
                  </p>
                  <p className="truncate text-xs" style={{ color: 'var(--muted)' }}>
                    {[c.companyOrRole, c.note].filter(Boolean).join(' · ') || 'Keine Firma hinterlegt'}
                  </p>
                </div>
                <div className="flex gap-2">
                  {!c.archived && (
                    <button
                      type="button"
                      className="ui-btn ui-btn-sm"
                      onClick={() => { setEditing({ id: c.id, name: c.name, company: c.companyOrRole, note: c.note ?? '' }); setError(null); }}
                      disabled={Boolean(busy)}
                    >
                      Korrigieren
                    </button>
                  )}
                  <button type="button" className="ui-btn ui-btn-sm" onClick={() => void toggleArchived(c)} disabled={Boolean(busy)}>
                    {busy === c.id ? 'Bitte warten…' : c.archived ? 'Wiederherstellen' : 'Archivieren'}
                  </button>
                </div>
              </li>
            ),
          )}
        </ul>
      )}
    </div>
  );
}
