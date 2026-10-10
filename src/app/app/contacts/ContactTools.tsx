'use client';

import { useId, useState } from 'react';
import type { DirectoryContact, DirectoryField } from '@/lib/contacts/directory';
import { KIND_LABELS } from '@/lib/contacts/contact-list';
import { FIELD_TYPE_LABELS, optionsFromText, type FieldType } from '@/lib/contacts/field-form';

/**
 * The two tools that are rarely needed and therefore kept out of the list:
 * merging two contacts that are the same, and the company's own fields.
 */

export interface NewFieldInput {
  label: string;
  type: FieldType;
  options: string[] | null;
}

interface ContactToolsProps {
  /** Active contacts: only those can be merged. */
  contacts: readonly DirectoryContact[];
  /** Every custom field of the company, archived ones included. */
  fields: readonly DirectoryField[];
  busy: string | null;
  /** Resolves to true when the merge went through, so the choice can be cleared. */
  onMerge: (loserId: string, winnerId: string) => Promise<boolean>;
  /** Resolves to true when the field was created, so the inputs can be cleared. */
  onCreateField: (input: NewFieldInput) => Promise<boolean>;
  onArchiveField: (key: string) => void;
}

export default function ContactTools(props: ContactToolsProps) {
  const { contacts, fields, busy } = props;
  const id = useId();
  const idle = busy === null;

  const [loserId, setLoserId] = useState('');
  const [winnerId, setWinnerId] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [newField, setNewField] = useState<{ label: string; type: FieldType; options: string }>({ label: '', type: 'text', options: '' });

  const loser = contacts.find((c) => c.id === loserId) ?? null;
  const winner = contacts.find((c) => c.id === winnerId) ?? null;
  // Only two contacts of the same kind can be merged, so the second choice offers nothing else.
  const winners = contacts.filter((c) => c.id !== loserId && (!loser || c.kind === loser.kind));
  const choosable = newField.type === 'select' || newField.type === 'multi_select';
  const option = (c: DirectoryContact) => `${c.name} (${KIND_LABELS[c.kind]}${c.customerNumber ? `, Kundennummer ${c.customerNumber}` : ''})`;

  const merge = async () => {
    if (!loser || !winner) return;
    if (await props.onMerge(loser.id, winner.id)) {
      setLoserId('');
      setWinnerId('');
    }
    setConfirming(false);
  };

  const addField = async () => {
    const created = await props.onCreateField({
      label: newField.label.trim(),
      type: newField.type,
      options: choosable ? optionsFromText(newField.options) : null,
    });
    if (created) setNewField({ label: '', type: 'text', options: '' });
  };

  return (
    <div className="grid gap-6 lg:grid-cols-2 lg:items-start">
      <section className="glass-panel space-y-3 rounded-xl p-4" aria-labelledby={`${id}-merge`}>
        <h2 id={`${id}-merge`} className="text-base font-semibold" style={{ color: 'var(--foreground)' }}>
          Zusammenführen
        </h2>
        <p className="text-sm" style={{ color: 'var(--muted)' }}>
          Für doppelt angelegte Kontakte: einer der beiden geht im anderen auf. Gedruckte Namen auf bestehenden Bewirtungen bleiben unverändert.
        </p>
        {contacts.length < 2 ? (
          <p className="text-sm" style={{ color: 'var(--muted)' }}>
            Dafür braucht es mindestens zwei Kontakte.
          </p>
        ) : (
          <>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block">
                <span className="ui-label">Wird entfernt</span>
                <select
                  className="ui-input"
                  value={loserId}
                  disabled={!idle}
                  onChange={(e) => {
                    setLoserId(e.target.value);
                    setWinnerId('');
                    setConfirming(false);
                  }}
                >
                  <option value="">Bitte wählen</option>
                  {contacts.map((c) => (
                    <option key={c.id} value={c.id}>
                      {option(c)}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className="ui-label">Bleibt bestehen</span>
                <select
                  className="ui-input"
                  value={winnerId}
                  disabled={!idle || !loser}
                  onChange={(e) => {
                    setWinnerId(e.target.value);
                    setConfirming(false);
                  }}
                >
                  <option value="">{loser ? 'Bitte wählen' : 'Zuerst links wählen'}</option>
                  {winners.map((c) => (
                    <option key={c.id} value={c.id}>
                      {option(c)}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            {confirming && loser && winner ? (
              <div role="alertdialog" aria-labelledby={`${id}-merge-title`} aria-describedby={`${id}-merge-text`} className="ui-note ui-note-warn space-y-3">
                <h3 id={`${id}-merge-title`} className="text-sm font-semibold" style={{ color: 'var(--foreground)' }}>
                  {loser.name} in {winner.name} aufgehen lassen?
                </h3>
                <p id={`${id}-merge-text`} className="text-sm" style={{ color: 'var(--foreground)' }}>
                  {loser.name} verschwindet aus der Liste, die Bewirtungen laufen danach unter {winner.name}. Das lässt sich nicht rückgängig machen.
                </p>
                <div className="flex flex-wrap gap-2">
                  <button type="button" className="ui-btn ui-btn-sm ui-btn-primary" disabled={!idle} onClick={() => void merge()}>
                    {busy === 'merge' ? 'Wird zusammengeführt…' : 'Jetzt zusammenführen'}
                  </button>
                  <button type="button" className="ui-btn ui-btn-sm" disabled={!idle} onClick={() => setConfirming(false)}>
                    Abbrechen
                  </button>
                </div>
              </div>
            ) : (
              <button type="button" className="ui-btn ui-btn-sm" disabled={!idle || !loser || !winner} onClick={() => setConfirming(true)}>
                Zusammenführen
              </button>
            )}
          </>
        )}
      </section>

      <section className="glass-panel space-y-3 rounded-xl p-4" aria-labelledby={`${id}-fields`}>
        <h2 id={`${id}-fields`} className="text-base font-semibold" style={{ color: 'var(--foreground)' }}>
          Eigene Felder
        </h2>
        <p className="text-sm" style={{ color: 'var(--muted)' }}>
          Zusätzliche Angaben, die bei jedem Kontakt dieses Kontos erfasst werden können. Ein archiviertes Feld behält seine gespeicherten Werte, nimmt aber keine neuen an.
        </p>
        {fields.length > 0 && (
          <ul className="space-y-1">
            {fields.map((f) => (
              <li key={f.key} className="flex flex-wrap items-center justify-between gap-2 text-sm" style={{ color: f.archived ? 'var(--muted)' : 'var(--foreground)' }}>
                <span>
                  {f.label}
                  <span className="ml-2 text-xs" style={{ color: 'var(--muted)' }}>
                    {FIELD_TYPE_LABELS[f.type]}
                    {f.options ? `: ${f.options.join(', ')}` : ''}
                    {f.archived ? ' (archiviert)' : ''}
                  </span>
                </span>
                {!f.archived && (
                  <button type="button" className="ui-btn ui-btn-sm" disabled={!idle} aria-label={`Feld ${f.label} archivieren`} onClick={() => props.onArchiveField(f.key)}>
                    Archivieren
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
        <form
          className="space-y-3"
          aria-label="Neues Feld"
          onSubmit={(e) => {
            e.preventDefault();
            void addField();
          }}
        >
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block">
              <span className="ui-label">Name des Feldes</span>
              <input className="ui-input" value={newField.label} autoComplete="off" onChange={(e) => setNewField({ ...newField, label: e.target.value })} />
            </label>
            <label className="block">
              <span className="ui-label">Art</span>
              <select className="ui-input" value={newField.type} onChange={(e) => setNewField({ ...newField, type: e.target.value as FieldType })}>
                {Object.entries(FIELD_TYPE_LABELS).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            {choosable && (
              <label className="block sm:col-span-2">
                <span className="ui-label">Optionen, durch Komma getrennt</span>
                <input className="ui-input" value={newField.options} autoComplete="off" onChange={(e) => setNewField({ ...newField, options: e.target.value })} />
              </label>
            )}
          </div>
          <button
            type="submit"
            className="ui-btn ui-btn-sm"
            disabled={!idle || !newField.label.trim() || (choosable && optionsFromText(newField.options).length === 0)}
          >
            {busy === 'field-new' ? 'Bitte warten…' : 'Feld anlegen'}
          </button>
        </form>
      </section>
    </div>
  );
}
