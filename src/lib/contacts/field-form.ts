/**
 * Pure helpers for the custom field inputs of the contact screen. No server
 * imports, so the client component and the tests can both use them. The rules
 * themselves live in the contacts package; this only turns form text into the
 * typed values the package expects and names the field when that is impossible.
 */

export type FieldType = 'text' | 'number' | 'date' | 'boolean' | 'select' | 'multi_select' | 'url';

export interface FormField {
  key: string;
  label: string;
  type: FieldType;
  options: string[] | null;
  archived: boolean;
}

/** What one input holds while editing: text for most types, a list for several choices. */
export type FieldFormValue = string | string[];
export type FieldFormState = Record<string, FieldFormValue>;

export const FIELD_TYPE_LABELS: Record<FieldType, string> = {
  text: 'Text',
  number: 'Zahl',
  date: 'Datum',
  boolean: 'Ja oder Nein',
  select: 'Auswahl (eine Option)',
  multi_select: 'Auswahl (mehrere Optionen)',
  url: 'Link',
};

export const PREFERRED_CONTACT_LABELS: Record<string, string> = {
  email: 'E-Mail',
  phone: 'Telefon',
  post: 'Post',
  none: 'Kein Kontakt gewünscht',
};

/** The form state for a contact's stored values. Fields without a value start empty. */
export function fieldFormFrom(fields: readonly FormField[], values: Record<string, unknown>): FieldFormState {
  const state: FieldFormState = {};
  for (const f of fields) {
    const v = values[f.key];
    if (f.type === 'multi_select') state[f.key] = Array.isArray(v) ? v.map(String) : [];
    else if (v === undefined || v === null) state[f.key] = '';
    else state[f.key] = String(v);
  }
  return state;
}

/** The typed value an input stands for, null when it is empty, or `invalid` when it cannot be read. */
function typed(field: FormField, raw: FieldFormValue): unknown | null | 'invalid' {
  if (field.type === 'multi_select') {
    const list = Array.isArray(raw) ? raw : [];
    return list.length === 0 ? null : [...list];
  }
  const text = (Array.isArray(raw) ? '' : raw).trim();
  if (text === '') return null;
  switch (field.type) {
    case 'number': {
      // German input writes the decimal point as a comma.
      const n = Number(text.replace(',', '.'));
      return Number.isFinite(n) && /^-?\d+([.,]\d+)?$/.test(text) ? n : 'invalid';
    }
    case 'boolean':
      return text === 'true' ? true : text === 'false' ? false : 'invalid';
    default:
      return text;
  }
}

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/**
 * The patch to send for the edited inputs. Only active fields whose value
 * changed are included (null clears a value), so an untouched field and every
 * archived field are never sent. Inputs that cannot be read are reported by key
 * and left out of the patch.
 */
export function customFieldPatch(
  fields: readonly FormField[],
  form: FieldFormState,
  current: Record<string, unknown>,
): { patch: Record<string, unknown>; invalid: string[] } {
  const patch: Record<string, unknown> = {};
  const invalid: string[] = [];
  for (const f of fields) {
    if (f.archived || !(f.key in form)) continue;
    const value = typed(f, form[f.key]);
    if (value === 'invalid') {
      invalid.push(f.key);
      continue;
    }
    if (!same(value, current[f.key])) patch[f.key] = value;
  }
  return { patch, invalid };
}

/** A field key from its label: lower case, letters, digits and underscores, starting with a letter. */
export function fieldKeyFromLabel(label: string): string {
  const base = label
    .toLowerCase()
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  const key = /^[a-z]/.test(base) ? base : `f_${base}`;
  return key.slice(0, 40).replace(/_+$/g, '');
}

/** The options of a select field from one line of text, separated by commas. Empty and repeated entries are dropped. */
export function optionsFromText(text: string): string[] {
  return [...new Set(text.split(',').map((o) => o.replace(/\s+/g, ' ').trim()).filter(Boolean))];
}

/**
 * The count next to the "Kontakte" link of the meal page: every active contact
 * the contacts page lists, which is the active persons plus the organizations.
 * The guest picker keeps offering persons only.
 */
export function contactsTabCount(persons: readonly { archived: boolean }[], organizations: number): number {
  return persons.filter((p) => !p.archived).length + Math.max(0, organizations);
}
