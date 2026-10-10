'use client';

import { useId, useState } from 'react';
import type { DirectoryContact, DirectoryField, DirectoryInput, DirectoryKind } from '@/lib/contacts/directory';
import { PREFERRED_CONTACT_LABELS, fieldFormFrom, type FieldFormState, type FieldFormValue } from '@/lib/contacts/field-form';

/**
 * The one form a contact is created and edited with. A person and an
 * organization share it; the kind decides which inputs are shown. It only holds
 * the inputs: saving, and the choice of server action, belong to the page.
 */

export interface ContactFormValues {
  name: string;
  /** Persons only: the label printed next to the name on meals. */
  companyOrRole: string;
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

const EMPTY_VALUES: Omit<ContactFormValues, 'fields'> = {
  name: '',
  companyOrRole: '',
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
};

export function emptyFormValues(fields: readonly DirectoryField[]): ContactFormValues {
  return { ...EMPTY_VALUES, fields: fieldFormFrom(fields, {}) };
}

export function formValuesFrom(c: DirectoryContact, fields: readonly DirectoryField[]): ContactFormValues {
  return {
    name: c.name,
    companyOrRole: c.companyOrRole,
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

const blank = (v: string) => (v.trim() === '' ? null : v.trim());

/** Everything an organization records, as the directory action takes it. */
export function organizationInput(form: ContactFormValues): DirectoryInput {
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

/**
 * The part of a person the directory action saves. Name, company and note are
 * NOT in it: they are printed on meals and are saved through the guest action,
 * which also corrects the printed copies.
 */
export function personDetailsInput(form: ContactFormValues): DirectoryInput {
  return { email: blank(form.email), phone: blank(form.phone), preferredContact: blank(form.preferredContact) };
}

/** A new person with everything recorded about one. */
export function newPersonInput(form: ContactFormValues): DirectoryInput {
  return { ...personDetailsInput(form), name: form.name.trim(), companyOrRole: form.companyOrRole.trim(), note: blank(form.note) };
}

interface ContactFormProps {
  kind: DirectoryKind;
  mode: 'create' | 'edit';
  initial: ContactFormValues;
  /** The company's active custom fields. */
  fields: readonly DirectoryField[];
  /** Accessible name of the form, for example "Neue Person". */
  label: string;
  saving: boolean;
  disabled: boolean;
  /** A failure that belongs to the form as a whole. */
  error: string | null;
  /** Failures by input: `name`, or the key of a custom field. */
  fieldErrors: Record<string, string>;
  onSubmit: (values: ContactFormValues) => void;
  onCancel: () => void;
  /** Reports whether the inputs differ from where they started, so Escape never discards work. */
  onDirtyChange?: (dirty: boolean) => void;
}

export default function ContactForm(props: ContactFormProps) {
  const { kind, mode, fields, fieldErrors } = props;
  const id = useId();
  const [values, setValues] = useState<ContactFormValues>(props.initial);

  const change = (patch: Partial<ContactFormValues>) => {
    setValues((v) => ({ ...v, ...patch }));
    props.onDirtyChange?.(true);
  };
  const setField = (key: string, value: FieldFormValue) => change({ fields: { ...values.fields, [key]: value } });

  const nameErrorId = `${id}-name-error`;

  return (
    <form
      className="space-y-4"
      aria-label={props.label}
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        if (!props.disabled && values.name.trim()) props.onSubmit(values);
      }}
    >
      {props.error && (
        <p role="alert" className="ui-note ui-note-danger">
          {props.error}
        </p>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block sm:col-span-2">
          <span className="ui-label">Name</span>
          <input
            id={`${id}-name`}
            className="ui-input"
            value={values.name}
            required
            autoComplete="off"
            aria-invalid={fieldErrors.name ? true : undefined}
            aria-describedby={fieldErrors.name ? nameErrorId : undefined}
            onChange={(e) => change({ name: e.target.value })}
          />
          {fieldErrors.name && (
            <span id={nameErrorId} role="alert" className="mt-1 block text-xs" style={{ color: 'var(--danger)' }}>
              {fieldErrors.name}
            </span>
          )}
        </label>

        {kind === 'person' && (
          <TextField id={`${id}-company`} label="Firma oder Funktion" value={values.companyOrRole} wide onChange={(v) => change({ companyOrRole: v })} />
        )}

        {kind === 'organization' && (
          <>
            <TextField id={`${id}-legal`} label="Rechtsform (z. B. GmbH, Einzelunternehmen)" value={values.legalForm} wide onChange={(v) => change({ legalForm: v })} />
            <TextField id={`${id}-street1`} label="Straße und Hausnummer" value={values.addressLine1} onChange={(v) => change({ addressLine1: v })} />
            <TextField id={`${id}-street2`} label="Adresszusatz" value={values.addressLine2} onChange={(v) => change({ addressLine2: v })} />
            <TextField id={`${id}-zip`} label="Postleitzahl" value={values.postalCode} onChange={(v) => change({ postalCode: v })} />
            <TextField id={`${id}-city`} label="Ort" value={values.city} onChange={(v) => change({ city: v })} />
            <TextField id={`${id}-country`} label="Land (Zwei-Buchstaben-Code, z. B. DE)" value={values.country} maxLength={2} onChange={(v) => change({ country: v })} />
            <TextField id={`${id}-vat`} label="Umsatzsteuer-ID" value={values.vatId} onChange={(v) => change({ vatId: v })} />
          </>
        )}

        <TextField id={`${id}-email`} label="E-Mail" value={values.email} type="email" onChange={(v) => change({ email: v })} />
        <TextField id={`${id}-phone`} label="Telefon" value={values.phone} type="tel" onChange={(v) => change({ phone: v })} />
        <label className="block">
          <span className="ui-label">Bevorzugter Kontaktweg</span>
          <select className="ui-input" value={values.preferredContact} onChange={(e) => change({ preferredContact: e.target.value })}>
            <option value="">Keine Angabe</option>
            {Object.entries(PREFERRED_CONTACT_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>

        {fields.map((f) => (
          <CustomFieldInput
            key={f.key}
            id={`${id}-custom-${f.key}`}
            field={f}
            value={values.fields[f.key] ?? (f.type === 'multi_select' ? [] : '')}
            error={fieldErrors[f.key]}
            onChange={(v) => setField(f.key, v)}
          />
        ))}

        <TextField id={`${id}-note`} label="Notiz (wird nicht gedruckt)" value={values.note} wide onChange={(v) => change({ note: v })} />
      </div>

      {kind === 'person' && mode === 'edit' && (
        <p className="text-xs" style={{ color: 'var(--muted)' }}>
          Eine Korrektur von Name oder Firma gilt auch für bereits erfasste Bewirtungen mit dieser Person.
        </p>
      )}

      <div className="flex flex-wrap gap-2">
        <button type="submit" className="ui-btn ui-btn-primary" disabled={props.disabled || !values.name.trim()}>
          {props.saving ? 'Wird gespeichert…' : 'Speichern'}
        </button>
        <button type="button" className="ui-btn" onClick={props.onCancel} disabled={props.disabled}>
          Abbrechen
        </button>
      </div>
    </form>
  );
}

function TextField(props: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  maxLength?: number;
  type?: string;
  wide?: boolean;
}) {
  return (
    <label className={`block${props.wide ? ' sm:col-span-2' : ''}`}>
      <span className="ui-label">{props.label}</span>
      <input
        id={props.id}
        className="ui-input"
        value={props.value}
        maxLength={props.maxLength}
        type={props.type ?? 'text'}
        autoComplete="off"
        onChange={(e) => props.onChange(e.target.value)}
      />
    </label>
  );
}

/** One input for a custom field, chosen by its type. An error is tied to the input for screen readers. */
function CustomFieldInput(props: {
  id: string;
  field: DirectoryField;
  value: FieldFormValue;
  error?: string;
  onChange: (v: FieldFormValue) => void;
}) {
  const { id, field, value, error } = props;
  const errorId = `${id}-error`;
  const text = Array.isArray(value) ? '' : value;
  const described = error ? { 'aria-invalid': true, 'aria-describedby': errorId } : {};
  const errorLine = error ? (
    <span id={errorId} role="alert" className="mt-1 block text-xs" style={{ color: 'var(--danger)' }}>
      {error}
    </span>
  ) : null;

  if (field.type === 'multi_select') {
    const chosen = Array.isArray(value) ? value : [];
    return (
      <fieldset className="block sm:col-span-2" {...described}>
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
          {options.map(([v, label]) => (
            <option key={v} value={v}>
              {label}
            </option>
          ))}
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
