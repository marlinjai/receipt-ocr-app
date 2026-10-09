'use client';

import { useId, useMemo, useRef, useState } from 'react';
import { formatGuest, type Contact, type ContactInput } from '@/lib/contacts/store';
import { mealActionMessage } from '@/lib/meals/messages';
import type { MealGuestEntry } from '@/lib/meals/types';

export type CreateContactResult =
  | { ok: true; value: Contact }
  | { ok: false; error: string; detail?: string };

interface GuestPickerProps {
  guests: MealGuestEntry[];
  /** Every contact of the workspace, archived ones included (they are never offered). */
  contacts: Contact[];
  onChange: (guests: MealGuestEntry[]) => void;
  onCreateContact: (input: ContactInput) => Promise<CreateContactResult>;
  /** Called with a contact that was just created, so the caller can add it to its list. */
  onContactCreated?: (contact: Contact) => void;
  disabled?: boolean;
  invalid?: boolean;
  describedBy?: string;
}

function toGuest(contact: Contact): MealGuestEntry {
  return { contactId: contact.id, name: contact.name, company: contact.companyOrRole };
}

/**
 * Pick the persons hosted from the contact list: type to filter, Enter or
 * click to add, or create a new contact inline. Archived contacts are never
 * offered; one that is already on the meal stays as a removable chip.
 */
export default function GuestPicker({
  guests,
  contacts,
  onChange,
  onCreateContact,
  onContactCreated,
  disabled,
  invalid,
  describedBy,
}: GuestPickerProps) {
  const listId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [creating, setCreating] = useState<{ name: string; company: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selected = useMemo(() => new Set(guests.map((g) => g.contactId)), [guests]);
  const matches = useMemo(() => {
    const q = query.trim().toLocaleLowerCase('de-DE');
    return contacts
      .filter((c) => !c.archived && !selected.has(c.id))
      .filter((c) => !q || `${c.name} ${c.companyOrRole}`.toLocaleLowerCase('de-DE').includes(q))
      .slice(0, 8);
  }, [contacts, selected, query]);

  const trimmed = query.trim();
  const exactExists = contacts.some(
    (c) => !c.archived && c.name.toLocaleLowerCase('de-DE') === trimmed.toLocaleLowerCase('de-DE'),
  );
  const showCreate = trimmed.length > 0 && !exactExists;
  const optionCount = matches.length + (showCreate ? 1 : 0);

  const add = (contact: Contact) => {
    if (!selected.has(contact.id)) onChange([...guests, toGuest(contact)]);
    setQuery('');
    setActive(0);
    setError(null);
    inputRef.current?.focus();
  };

  const remove = (contactId: string) => onChange(guests.filter((g) => g.contactId !== contactId));

  const choose = (index: number) => {
    if (index < matches.length) add(matches[index]);
    else if (showCreate) {
      setCreating({ name: trimmed, company: '' });
      setOpen(false);
    }
  };

  const submitNew = async () => {
    if (!creating || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await onCreateContact({ name: creating.name, companyOrRole: creating.company });
      if (result.ok) {
        onContactCreated?.(result.value);
        add(result.value);
        setCreating(null);
        return;
      }
      // Already there (same name and company): take the existing contact.
      if (result.error === 'contact_duplicate' && result.detail) {
        const existing = contacts.find((c) => c.id === result.detail);
        if (existing && !existing.archived) {
          add(existing);
          setCreating(null);
          return;
        }
        setError(
          existing?.archived
            ? 'Diesen Kontakt gibt es bereits, er ist archiviert. Bitte im Reiter Kontakte wiederherstellen.'
            : mealActionMessage(result.error),
        );
        return;
      }
      setError(mealActionMessage(result.error, result.detail));
    } catch {
      setError(mealActionMessage('failed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      {guests.length > 0 && (
        <ul className="mb-2 flex flex-wrap gap-1.5" aria-label="Ausgewählte Teilnehmer">
          {guests.map((g, i) => (
            <li key={g.contactId ?? `held-${i}`} className="ui-chip">
              <span>{g.contactId === null ? `${formatGuest(g.name, g.company)} (Kontakt entfernt)` : formatGuest(g.name, g.company)}</span>
              <button
                type="button"
                onClick={() => g.contactId !== null && remove(g.contactId)}
                disabled={disabled || g.contactId === null}
                aria-label={`${g.name} entfernen`}
                className="flex h-6 w-6 items-center justify-center rounded-full hover:bg-white/10"
                style={{ color: 'var(--muted)' }}
              >
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden>
                  <path d="M2.5 2.5l7 7M9.5 2.5l-7 7" />
                </svg>
              </button>
            </li>
          ))}
        </ul>
      )}

      {creating ? (
        <div className="ui-note space-y-2">
          <p className="text-xs font-medium" style={{ color: 'var(--muted)' }}>
            Neuen Kontakt anlegen
          </p>
          <input
            className="ui-input"
            aria-label="Name des neuen Kontakts"
            placeholder="Vor- und Nachname"
            value={creating.name}
            autoFocus
            onChange={(e) => setCreating({ ...creating, name: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                void submitNew();
              }
            }}
          />
          <input
            className="ui-input"
            aria-label="Firma oder Funktion des neuen Kontakts"
            placeholder="Firma oder Funktion (optional)"
            value={creating.company}
            onChange={(e) => setCreating({ ...creating, company: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                void submitNew();
              }
            }}
          />
          <div className="flex gap-2">
            <button type="button" className="ui-btn ui-btn-primary ui-btn-sm" onClick={() => void submitNew()} disabled={busy || !creating.name.trim()}>
              {busy ? 'Wird angelegt…' : 'Anlegen und hinzufügen'}
            </button>
            <button
              type="button"
              className="ui-btn ui-btn-sm"
              onClick={() => {
                setCreating(null);
                setError(null);
              }}
              disabled={busy}
            >
              Abbrechen
            </button>
          </div>
        </div>
      ) : (
        <div className="relative">
          <input
            ref={inputRef}
            className="ui-input"
            role="combobox"
            aria-expanded={open && optionCount > 0}
            aria-controls={listId}
            aria-autocomplete="list"
            aria-label="Teilnehmer suchen oder anlegen"
            aria-invalid={invalid || undefined}
            aria-describedby={describedBy}
            placeholder={guests.length === 0 ? 'Name eingeben' : 'Weiteren Namen eingeben'}
            value={query}
            disabled={disabled}
            autoComplete="off"
            onChange={(e) => {
              setQuery(e.target.value);
              setOpen(true);
              setActive(0);
            }}
            onFocus={() => setOpen(true)}
            onBlur={() => setOpen(false)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setOpen(true);
                setActive((i) => Math.min(i + 1, Math.max(optionCount - 1, 0)));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setActive((i) => Math.max(i - 1, 0));
              } else if (e.key === 'Enter' && open && optionCount > 0) {
                e.preventDefault();
                choose(active);
              } else if (e.key === 'Escape' && open) {
                e.stopPropagation();
                setOpen(false);
              } else if (e.key === 'Backspace' && !query && guests.length > 0) {
                const last = [...guests].reverse().find((g) => g.contactId !== null);
                if (last?.contactId) remove(last.contactId);
              }
            }}
          />
          {open && optionCount > 0 && (
            <ul
              id={listId}
              role="listbox"
              className="absolute left-0 right-0 top-full z-30 mt-1 max-h-64 overflow-auto rounded-lg border p-1 shadow-2xl"
              style={{ background: '#17171c', borderColor: 'var(--border)' }}
            >
              {matches.map((c, i) => (
                <li
                  key={c.id}
                  role="option"
                  aria-selected={i === active}
                  // mousedown, not click: the input's blur would close the list first.
                  onMouseDown={(e) => {
                    e.preventDefault();
                    add(c);
                  }}
                  onMouseEnter={() => setActive(i)}
                  className="cursor-pointer rounded-md px-2.5 py-2 text-sm"
                  style={{ background: i === active ? 'var(--accent-muted)' : 'transparent', color: 'var(--foreground)' }}
                >
                  {c.name}
                  {c.companyOrRole && <span style={{ color: 'var(--muted)' }}> · {c.companyOrRole}</span>}
                </li>
              ))}
              {showCreate && (
                <li
                  role="option"
                  aria-selected={active === matches.length}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    choose(matches.length);
                  }}
                  onMouseEnter={() => setActive(matches.length)}
                  className="cursor-pointer rounded-md px-2.5 py-2 text-sm"
                  style={{ background: active === matches.length ? 'var(--accent-muted)' : 'transparent', color: 'var(--accent)' }}
                >
                  Neuen Kontakt anlegen: „{trimmed}“
                </li>
              )}
            </ul>
          )}
        </div>
      )}

      {error && (
        <p role="alert" className="mt-2 text-xs" style={{ color: 'var(--danger)' }}>
          {error}
        </p>
      )}
    </div>
  );
}
