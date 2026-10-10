'use client';

import { useEffect, useState } from 'react';
import type { DirectoryContact, DirectoryField, DirectoryInput, ErasePreview } from '@/lib/contacts/directory';
import { directoryMessage, eraseConfirmation, fieldErrorMessage } from '@/lib/contacts/directory-messages';
import {
  FIELD_TYPE_LABELS,
  PREFERRED_CONTACT_LABELS,
  customFieldPatch,
  fieldFormFrom,
  fieldKeyFromLabel,
  optionsFromText,
  type FieldFormState,
  type FieldFormValue,
  type FieldType,
} from '@/lib/contacts/field-form';
import {
  archiveFieldAction,
  assignCustomerNumberAction,
  createDirectoryAction,
  createFieldAction,
  eraseDirectoryAction,
  exportDirectoryAction,
  linkPersonAction,
  listDirectoryAction,
  listFieldsAction,
  mergeDirectoryAction,
  previewEraseAction,
  updateDirectoryAction,
} from './directory-actions';

/**
 * The directory of persons and organizations (wave 3, docs/plans/2026-10-09-contact-screen.md).
 * Organizations get their address, legal form and VAT ID here. Persons are linked to an
 * organization, merged, numbered, exported and erased one at a time. The company defines its
 * own fields here, and every contact carries a value for each, plus a preferred contact method.
 */

type Editing = { mode: 'create' } | { mode: 'edit'; contact: DirectoryContact };

interface DetailForm {
  name: string;
  legalForm: string;
  addressLine1: string;
  addressLine2: string;
  postalCode: string;
  city: string;
  country: string;
  vatId: string;
  email: string;
  phone: string;
  note: string;
  preferredContact: string;
  fields: FieldFormState;
}

const EMPTY_FORM: DetailForm = {
  name: '',
  legalForm: '',
  addressLine1: '',
  addressLine2: '',
  postalCode: '',
  city: '',
  country: '',
  vatId: '',
  email: '',
  phone: '',
  note: '',
  preferredContact: '',
  fields: {},
};

const blank = (v: string) => (v.trim() === '' ? null : v.trim());

function formFrom(c: DirectoryContact, fields: readonly DirectoryField[]): DetailForm {
  return {
    name: c.name,
    legalForm: c.legalForm ?? '',
    addressLine1: c.addressLine1 ?? '',
    addressLine2: c.addressLine2 ?? '',
    postalCode: c.postalCode ?? '',
    city: c.city ?? '',
    country: c.country ?? '',
    vatId: c.vatId ?? '',
    email: c.email ?? '',
    phone: c.phone ?? '',
    note: c.note ?? '',
    preferredContact: c.preferredContact ?? '',
    fields: fieldFormFrom(fields, c.customFields),
  };
}

/** The organization's own inputs. A person's name, company and note are edited in the guest list above. */
function organizationInput(form: DetailForm): DirectoryInput {
  return {
    name: form.name.trim(),
    legalForm: blank(form.legalForm),
    addressLine1: blank(form.addressLine1),
    addressLine2: blank(form.addressLine2),
    postalCode: blank(form.postalCode),
    city: blank(form.city),
    country: blank(form.country)?.toUpperCase() ?? null,
    vatId: blank(form.vatId),
    email: blank(form.email),
    phone: blank(form.phone),
    note: blank(form.note),
    preferredContact: blank(form.preferredContact),
  };
}

function personInput(form: DetailForm): DirectoryInput {
  return { email: blank(form.email), phone: blank(form.phone), preferredContact: blank(form.preferredContact) };
}

interface DirectoryPanelProps {
  /** Called with the listed contacts after every load, so the tab badge and the guest list can follow. */
  onChanged?: (contacts: DirectoryContact[]) => void;
}

export default function DirectoryPanel({ onChanged }: DirectoryPanelProps = {}) {
  const [contacts, setContacts] = useState<DirectoryContact[] | null>(null);
  const [fields, setFields] = useState<DirectoryField[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [form, setForm] = useState<DetailForm>(EMPTY_FORM);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [linkTarget, setLinkTarget] = useState<Record<string, string>>({});
  const [mergeLoser, setMergeLoser] = useState('');
  const [mergeWinner, setMergeWinner] = useState('');
  const [erasing, setErasing] = useState<{ contact: DirectoryContact; preview: ErasePreview } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [newField, setNewField] = useState<{ label: string; type: FieldType; options: string }>({ label: '', type: 'text', options: '' });

  const activeFields = fields.filter((f) => !f.archived);

  const reload = async () => {
    const [list, defs] = await Promise.all([listDirectoryAction(false), listFieldsAction()]);
    if (defs.ok) setFields(defs.value);
    if (list.ok) {
      setContacts(list.value);
      onChanged?.(list.value);
    } else setError(directoryMessage(list.error));
  };

  useEffect(() => {
    void reload();
    // Loaded once; every change reloads through `act`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Run one change, then reload the list. Shows the message on failure, under its input when it names one. */
  const act = async (
    key: string,
    run: () => Promise<{ ok: true } | { ok: false; error: string; field?: string }>,
    done?: string,
  ) => {
    if (busy) return;
    setBusy(key);
    setError(null);
    setNotice(null);
    setFieldErrors({});
    try {
      const result = await run();
      if (!result.ok) {
        if (result.field && fields.some((f) => f.key === result.field)) {
          setFieldErrors({ [result.field]: fieldErrorMessage(result.error) });
        }
        setError(directoryMessage(result.error));
        return;
      }
      if (done) setNotice(done);
      await reload();
    } catch {
      setError(directoryMessage('failed'));
    } finally {
      setBusy(null);
    }
  };

  const startEdit = (next: Editing) => {
    setEditing(next);
    setForm(next.mode === 'edit' ? formFrom(next.contact, activeFields) : { ...EMPTY_FORM, fields: fieldFormFrom(activeFields, {}) });
    setError(null);
    setNotice(null);
    setFieldErrors({});
    setErasing(null);
  };

  const saveContact = () => {
    if (!editing) return;
    const current = editing.mode === 'edit' ? editing.contact.customFields : {};
    const { patch, invalid } = customFieldPatch(activeFields, form.fields, current);
    if (invalid.length > 0) {
      setFieldErrors(Object.fromEntries(invalid.map((k) => [k, fieldErrorMessage('invalid_value')])));
      setError(directoryMessage('invalid_value'));
      return;
    }
    const custom = Object.keys(patch).length > 0 ? { customFields: patch } : {};
    if (editing.mode === 'create') {
      const input = organizationInput(form);
      void act('save', async () => {
        const r = await createDirectoryAction({ ...input, ...custom, kind: 'organization', name: input.name ?? '' });
        if (r.ok) setEditing(null);
        return r;
      }, 'Organisation angelegt.');
    } else {
      const { contact } = editing;
      const input = contact.kind === 'organization' ? organizationInput(form) : personInput(form);
      void act('save', async () => {
        const r = await updateDirectoryAction(contact.id, { ...input, ...custom }, contact.version);
        if (r.ok) setEditing(null);
        return r;
      }, 'Änderungen gespeichert.');
    }
  };

  const exportOne = async (c: DirectoryContact) => {
    setBusy(`export-${c.id}`);
    setError(null);
    try {
      const r = await exportDirectoryAction(c.id);
      if (!r.ok) {
        setError(directoryMessage(r.error));
        return;
      }
      const url = URL.createObjectURL(new Blob([r.value], { type: 'application/json' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = `kontakt-${c.id}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } finally {
      setBusy(null);
    }
  };

  /** Ask what erasing would do before anything is deleted. */
  const askErase = async (c: DirectoryContact) => {
    if (busy) return;
    setBusy(`preview-${c.id}`);
    setError(null);
    setNotice(null);
    try {
      const r = await previewEraseAction(c.id);
      if (!r.ok) {
        setError(directoryMessage(r.error));
        return;
      }
      setErasing({ contact: c, preview: r.value });
      setEditing(null);
    } catch {
      setError(directoryMessage('failed'));
    } finally {
      setBusy(null);
    }
  };

  const confirmErase = () => {
    if (!erasing) return;
    const { contact } = erasing;
    void act(`erase-${contact.id}`, async () => {
      const r = await eraseDirectoryAction(contact.id);
      if (r.ok) {
        setErasing(null);
        setNotice(r.value.outcome === 'erased' ? 'Kontakt gelöscht.' : 'Dieser Kontakt war bereits gelöscht.');
      }
      return r;
    });
  };

  const addField = () => {
    const label = newField.label.trim();
    const choosable = newField.type === 'select' || newField.type === 'multi_select';
    void act('field-new', async () => {
      const r = await createFieldAction({
        key: fieldKeyFromLabel(label),
        label,
        type: newField.type,
        options: choosable ? optionsFromText(newField.options) : null,
      });
      if (r.ok) setNewField({ label: '', type: 'text', options: '' });
      return r;
    }, 'Feld angelegt.');
  };

  const organizations = (contacts ?? []).filter((c) => c.kind === 'organization');
  const people = (contacts ?? []).filter((c) => c.kind === 'person');
  const editingKind = editing?.mode === 'edit' ? editing.contact.kind : 'organization';
  const setField = (key: string, value: FieldFormValue) => setForm({ ...form, fields: { ...form.fields, [key]: value } });

  return (
    <section className="mt-8 space-y-4" aria-labelledby="directory-heading">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="directory-heading" className="text-base font-semibold" style={{ color: 'var(--foreground)' }}>
          Verzeichnis
        </h2>
        <button type="button" className="ui-btn ui-btn-primary ui-btn-sm" onClick={() => startEdit({ mode: 'create' })}>
          Organisation anlegen
        </button>
      </div>

      {error && <p role="alert" className="ui-note ui-note-danger">{error}</p>}
      {notice && <p role="status" className="ui-note">{notice}</p>}

      {editing && (
        <form
          className="glass-panel space-y-3 rounded-xl p-4"
          aria-label={editing.mode === 'create' ? 'Neue Organisation' : editingKind === 'organization' ? 'Organisation bearbeiten' : 'Angaben zur Person bearbeiten'}
          onSubmit={(e) => { e.preventDefault(); saveContact(); }}
        >
          {editingKind === 'person' && editing.mode === 'edit' && (
            <p className="text-sm" style={{ color: 'var(--muted)' }}>
              {editing.contact.name}: Name, Firma und Notiz werden oben in der Liste der Teilnehmer geändert.
            </p>
          )}
          <div className="grid gap-3 sm:grid-cols-2">
            {editingKind === 'organization' && (
              <>
                <TextField id="org-name" label="Name" value={form.name} required onChange={(v) => setForm({ ...form, name: v })} />
                <TextField id="org-legal" label="Rechtsform (z. B. GmbH, Einzelunternehmen)" value={form.legalForm} onChange={(v) => setForm({ ...form, legalForm: v })} />
                <TextField id="org-street1" label="Straße und Hausnummer" value={form.addressLine1} onChange={(v) => setForm({ ...form, addressLine1: v })} />
                <TextField id="org-street2" label="Adresszusatz" value={form.addressLine2} onChange={(v) => setForm({ ...form, addressLine2: v })} />
                <TextField id="org-zip" label="Postleitzahl" value={form.postalCode} onChange={(v) => setForm({ ...form, postalCode: v })} />
                <TextField id="org-city" label="Ort" value={form.city} onChange={(v) => setForm({ ...form, city: v })} />
                <TextField id="org-country" label="Land (Zwei-Buchstaben-Code, z. B. DE)" value={form.country} maxLength={2} onChange={(v) => setForm({ ...form, country: v })} />
                <TextField id="org-vat" label="Umsatzsteuer-ID" value={form.vatId} onChange={(v) => setForm({ ...form, vatId: v })} />
              </>
            )}
            <TextField id="contact-email" label="E-Mail" value={form.email} type="email" onChange={(v) => setForm({ ...form, email: v })} />
            <TextField id="contact-phone" label="Telefon" value={form.phone} type="tel" onChange={(v) => setForm({ ...form, phone: v })} />
            <label className="block">
              <span className="ui-label">Bevorzugter Kontaktweg</span>
              <select
                id="contact-preferred"
                className="ui-input"
                value={form.preferredContact}
                onChange={(e) => setForm({ ...form, preferredContact: e.target.value })}
              >
                <option value="">Keine Angabe</option>
                {Object.entries(PREFERRED_CONTACT_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
            </label>
            {activeFields.map((f) => (
              <CustomFieldInput key={f.key} field={f} value={form.fields[f.key] ?? (f.type === 'multi_select' ? [] : '')} error={fieldErrors[f.key]} onChange={(v) => setField(f.key, v)} />
            ))}
          </div>
          {editingKind === 'organization' && (
            <TextField id="org-note" label="Notiz (wird nicht gedruckt)" value={form.note} onChange={(v) => setForm({ ...form, note: v })} />
          )}
          <div className="flex gap-2">
            <button type="submit" className="ui-btn ui-btn-primary" disabled={Boolean(busy) || (editingKind === 'organization' && !form.name.trim())}>
              {busy === 'save' ? 'Wird gespeichert…' : 'Speichern'}
            </button>
            <button type="button" className="ui-btn" onClick={() => setEditing(null)} disabled={Boolean(busy)}>
              Abbrechen
            </button>
          </div>
        </form>
      )}

      {erasing && (
        <div className="glass-panel space-y-3 rounded-xl p-4" role="alertdialog" aria-labelledby="erase-heading" aria-describedby="erase-text">
          <h3 id="erase-heading" className="text-sm font-semibold" style={{ color: 'var(--foreground)' }}>
            {erasing.contact.name} endgültig löschen?
          </h3>
          <p id="erase-text" className="text-sm" style={{ color: 'var(--foreground)' }}>
            {eraseConfirmation(erasing.preview, erasing.contact.kind)}
          </p>
          <div className="flex gap-2">
            <button type="button" className="ui-btn ui-btn-sm" disabled={Boolean(busy)} onClick={confirmErase}>
              {busy === `erase-${erasing.contact.id}` ? 'Wird gelöscht…' : 'Endgültig löschen'}
            </button>
            <button type="button" className="ui-btn ui-btn-sm" disabled={Boolean(busy)} onClick={() => setErasing(null)}>
              Abbrechen
            </button>
          </div>
        </div>
      )}

      {contacts === null ? (
        <p className="text-sm" style={{ color: 'var(--muted)' }}>Wird geladen…</p>
      ) : contacts.length === 0 ? (
        <p className="glass-panel rounded-xl p-6 text-center text-sm" style={{ color: 'var(--muted)' }}>
          Noch keine Organisationen oder Personen im Verzeichnis.
        </p>
      ) : (
        <ul className="space-y-2">
          {[...organizations, ...people].map((c) => (
            <li key={c.id} className="glass-panel rounded-xl px-4 py-3">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium" style={{ color: 'var(--foreground)' }}>
                    {c.name}
                    <span className="ml-2 text-xs font-normal" style={{ color: 'var(--muted)' }}>
                      {c.kind === 'organization' ? 'Organisation' : 'Person'}
                    </span>
                  </p>
                  <p className="truncate text-xs" style={{ color: 'var(--muted)' }}>
                    {c.kind === 'organization'
                      ? [c.legalForm, [c.postalCode, c.city].filter(Boolean).join(' '), c.country].filter(Boolean).join(' · ') || 'Keine Adresse hinterlegt'
                      : c.organizationName
                        ? `Bei ${c.organizationName}`
                        : c.companyOrRole || 'Keine Organisation verknüpft'}
                    {c.customerNumber && ` · Kundennummer ${c.customerNumber}`}
                    {c.preferredContact && ` · Kontakt: ${PREFERRED_CONTACT_LABELS[c.preferredContact] ?? c.preferredContact}`}
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <button type="button" className="ui-btn ui-btn-sm" disabled={Boolean(busy)} onClick={() => startEdit({ mode: 'edit', contact: c })}>
                    {c.kind === 'organization' ? 'Bearbeiten' : 'Angaben bearbeiten'}
                  </button>
                  {c.kind === 'person' && organizations.length > 0 && (
                    <>
                      <label className="sr-only" htmlFor={`link-${c.id}`}>Organisation für {c.name}</label>
                      <select
                        id={`link-${c.id}`}
                        className="ui-input ui-btn-sm"
                        value={linkTarget[c.id] ?? c.organizationId ?? ''}
                        onChange={(e) => setLinkTarget({ ...linkTarget, [c.id]: e.target.value })}
                        disabled={Boolean(busy)}
                      >
                        <option value="">Keine Organisation</option>
                        {organizations.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
                      </select>
                      <button
                        type="button"
                        className="ui-btn ui-btn-sm"
                        disabled={Boolean(busy) || (linkTarget[c.id] ?? c.organizationId ?? '') === (c.organizationId ?? '')}
                        onClick={() => {
                          const target = (linkTarget[c.id] ?? '') || null;
                          void act(`link-${c.id}`, () => linkPersonAction(c.id, target, c.version), 'Verknüpfung gespeichert.');
                        }}
                      >
                        Verknüpfen
                      </button>
                    </>
                  )}
                  {c.customerNumber === null && (
                    <button
                      type="button"
                      className="ui-btn ui-btn-sm"
                      disabled={Boolean(busy)}
                      onClick={() => void act(`number-${c.id}`, () => assignCustomerNumberAction(c.id), 'Kundennummer vergeben.')}
                    >
                      Kundennummer vergeben
                    </button>
                  )}
                  <button type="button" className="ui-btn ui-btn-sm" disabled={Boolean(busy)} onClick={() => void exportOne(c)}>
                    Exportieren
                  </button>
                  <button type="button" className="ui-btn ui-btn-sm" disabled={Boolean(busy)} onClick={() => void askErase(c)}>
                    {busy === `preview-${c.id}` ? 'Bitte warten…' : 'Löschen'}
                  </button>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}

      {contacts && contacts.length >= 2 && (
        <fieldset className="glass-panel space-y-3 rounded-xl p-4">
          <legend className="text-sm font-semibold" style={{ color: 'var(--foreground)' }}>Zwei Kontakte zusammenführen</legend>
          <p className="text-xs" style={{ color: 'var(--muted)' }}>
            Der zu entfernende Kontakt wird im anderen aufgehen. Gedruckte Namen auf bestehenden Bewirtungen bleiben unverändert.
          </p>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block">
              <span className="ui-label">Wird entfernt</span>
              <select className="ui-input" value={mergeLoser} onChange={(e) => setMergeLoser(e.target.value)}>
                <option value="">Bitte wählen</option>
                {contacts.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </label>
            <label className="block">
              <span className="ui-label">Bleibt bestehen</span>
              <select className="ui-input" value={mergeWinner} onChange={(e) => setMergeWinner(e.target.value)}>
                <option value="">Bitte wählen</option>
                {contacts.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </label>
          </div>
          <button
            type="button"
            className="ui-btn ui-btn-sm"
            disabled={Boolean(busy) || !mergeLoser || !mergeWinner || mergeLoser === mergeWinner}
            onClick={() =>
              void act('merge', async () => {
                const r = await mergeDirectoryAction(mergeLoser, mergeWinner);
                if (r.ok) { setMergeLoser(''); setMergeWinner(''); setNotice(r.value.outcome === 'merged' ? 'Zusammengeführt.' : 'Bereits zusammengeführt.'); }
                return r;
              })
            }
          >
            Zusammenführen
          </button>
        </fieldset>
      )}

      <fieldset className="glass-panel space-y-3 rounded-xl p-4">
        <legend className="text-sm font-semibold" style={{ color: 'var(--foreground)' }}>Eigene Felder</legend>
        <p className="text-xs" style={{ color: 'var(--muted)' }}>
          Zusätzliche Angaben, die für jeden Kontakt dieses Kontos erfasst werden können. Ein archiviertes Feld behält seine gespeicherten Werte, nimmt aber keine neuen an.
        </p>
        {fields.length > 0 && (
          <ul className="space-y-1">
            {fields.map((f) => (
              <li key={f.key} className="flex flex-wrap items-center justify-between gap-2 text-sm" style={{ color: f.archived ? 'var(--muted)' : 'var(--foreground)' }}>
                <span>
                  {f.label}
                  <span className="ml-2 text-xs" style={{ color: 'var(--muted)' }}>
                    {FIELD_TYPE_LABELS[f.type]}{f.options ? `: ${f.options.join(', ')}` : ''}{f.archived ? ' (archiviert)' : ''}
                  </span>
                </span>
                {!f.archived && (
                  <button
                    type="button"
                    className="ui-btn ui-btn-sm"
                    disabled={Boolean(busy)}
                    aria-label={`Feld ${f.label} archivieren`}
                    onClick={() => void act(`field-${f.key}`, () => archiveFieldAction(f.key), 'Feld archiviert.')}
                  >
                    Archivieren
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
        <div className="grid gap-3 sm:grid-cols-3">
          <TextField id="field-label" label="Name des Feldes" value={newField.label} onChange={(v) => setNewField({ ...newField, label: v })} />
          <label className="block">
            <span className="ui-label">Art</span>
            <select id="field-type" className="ui-input" value={newField.type} onChange={(e) => setNewField({ ...newField, type: e.target.value as FieldType })}>
              {Object.entries(FIELD_TYPE_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </label>
          {(newField.type === 'select' || newField.type === 'multi_select') && (
            <TextField id="field-options" label="Optionen, durch Komma getrennt" value={newField.options} onChange={(v) => setNewField({ ...newField, options: v })} />
          )}
        </div>
        <button
          type="button"
          className="ui-btn ui-btn-sm"
          disabled={
            Boolean(busy) ||
            !newField.label.trim() ||
            ((newField.type === 'select' || newField.type === 'multi_select') && optionsFromText(newField.options).length === 0)
          }
          onClick={addField}
        >
          Feld anlegen
        </button>
      </fieldset>
    </section>
  );
}

function TextField(props: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  required?: boolean;
  maxLength?: number;
  type?: string;
}) {
  return (
    <label className="block">
      <span className="ui-label">{props.label}</span>
      <input
        id={props.id}
        className="ui-input"
        value={props.value}
        required={props.required}
        maxLength={props.maxLength}
        type={props.type ?? 'text'}
        onChange={(e) => props.onChange(e.target.value)}
      />
    </label>
  );
}

/** One input for a custom field, chosen by its type. An error is tied to the input for screen readers. */
function CustomFieldInput(props: {
  field: DirectoryField;
  value: FieldFormValue;
  error?: string;
  onChange: (v: FieldFormValue) => void;
}) {
  const { field, value, error } = props;
  const id = `custom-${field.key}`;
  const errorId = `${id}-error`;
  const text = Array.isArray(value) ? '' : value;
  const described = error ? { 'aria-invalid': true, 'aria-describedby': errorId } : {};
  const errorLine = error ? <span id={errorId} role="alert" className="mt-1 block text-xs" style={{ color: 'var(--danger, #f87171)' }}>{error}</span> : null;

  if (field.type === 'multi_select') {
    const chosen = Array.isArray(value) ? value : [];
    return (
      <fieldset className="block" {...described}>
        <legend className="ui-label">{field.label}</legend>
        <div className="flex flex-wrap gap-3">
          {(field.options ?? []).map((option) => (
            <label key={option} className="flex items-center gap-1 text-sm" style={{ color: 'var(--foreground)' }}>
              <input
                type="checkbox"
                checked={chosen.includes(option)}
                onChange={(e) => props.onChange(e.target.checked ? [...chosen, option] : chosen.filter((o) => o !== option))}
              />
              {option}
            </label>
          ))}
        </div>
        {errorLine}
      </fieldset>
    );
  }

  if (field.type === 'select' || field.type === 'boolean') {
    const options = field.type === 'boolean' ? [['true', 'Ja'], ['false', 'Nein']] : (field.options ?? []).map((o) => [o, o]);
    return (
      <label className="block">
        <span className="ui-label">{field.label}</span>
        <select id={id} className="ui-input" value={text} onChange={(e) => props.onChange(e.target.value)} {...described}>
          <option value="">Keine Angabe</option>
          {options.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
        </select>
        {errorLine}
      </label>
    );
  }

  return (
    <label className="block">
      <span className="ui-label">{field.label}</span>
      <input
        id={id}
        className="ui-input"
        value={text}
        type={field.type === 'date' ? 'date' : field.type === 'url' ? 'url' : 'text'}
        inputMode={field.type === 'number' ? 'decimal' : undefined}
        onChange={(e) => props.onChange(e.target.value)}
        {...described}
      />
      {errorLine}
    </label>
  );
}
