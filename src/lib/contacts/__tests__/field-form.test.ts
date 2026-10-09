import { describe, it, expect } from 'vitest';
import {
  contactsTabCount,
  customFieldPatch,
  fieldFormFrom,
  fieldKeyFromLabel,
  optionsFromText,
  type FormField,
} from '../field-form';

const field = (over: Partial<FormField> & { key: string; type: FormField['type'] }): FormField => ({
  label: over.key,
  options: null,
  archived: false,
  ...over,
});

const FIELDS: FormField[] = [
  field({ key: 'diet', type: 'text' }),
  field({ key: 'seats', type: 'number' }),
  field({ key: 'since', type: 'date' }),
  field({ key: 'vip', type: 'boolean' }),
  field({ key: 'tier', type: 'select', options: ['A', 'B'] }),
  field({ key: 'tags', type: 'multi_select', options: ['x', 'y'] }),
  field({ key: 'old', type: 'text', archived: true }),
];

describe('custom field form', () => {
  it('fills the form from stored values, empty where nothing is stored', () => {
    const form = fieldFormFrom(FIELDS, { diet: 'vegan', seats: 4, vip: false, tags: ['x'] });
    expect(form).toMatchObject({ diet: 'vegan', seats: '4', since: '', vip: 'false', tier: '', tags: ['x'] });
  });

  it('sends only what changed, with typed values', () => {
    const current = { diet: 'vegan', seats: 4 };
    const form = { ...fieldFormFrom(FIELDS, current), seats: '4,5', vip: 'true', tier: 'B', tags: ['y', 'x'] };
    expect(customFieldPatch(FIELDS, form, current)).toEqual({
      patch: { seats: 4.5, vip: true, tier: 'B', tags: ['y', 'x'] },
      invalid: [],
    });
  });

  it('clears a value with null when its input is emptied', () => {
    const current = { diet: 'vegan', tags: ['x'] };
    const form = { ...fieldFormFrom(FIELDS, current), diet: '  ', tags: [] };
    expect(customFieldPatch(FIELDS, form, current).patch).toEqual({ diet: null, tags: null });
  });

  it('sends nothing when nothing changed, so an untouched save cannot alter stored values', () => {
    const current = { diet: 'vegan', seats: 4, tags: ['x'], old: 'kept' };
    expect(customFieldPatch(FIELDS, fieldFormFrom(FIELDS, current), current)).toEqual({ patch: {}, invalid: [] });
  });

  it('never sends an archived field, even when its input was changed', () => {
    const form = { ...fieldFormFrom(FIELDS, { old: 'kept' }), old: 'changed' };
    expect(customFieldPatch(FIELDS, form, { old: 'kept' }).patch).toEqual({});
  });

  it('names an input that cannot be read as a number, and leaves it out of the patch', () => {
    const form = { ...fieldFormFrom(FIELDS, {}), seats: 'vier', diet: 'vegan' };
    expect(customFieldPatch(FIELDS, form, {})).toEqual({ patch: { diet: 'vegan' }, invalid: ['seats'] });
  });
});

describe('defining a field', () => {
  it('derives a valid key from a German label', () => {
    expect(fieldKeyFromLabel('Bevorzugte Küche')).toBe('bevorzugte_kueche');
    expect(fieldKeyFromLabel('  Größe (cm) ')).toBe('groesse_cm');
    expect(fieldKeyFromLabel('2. Ansprechpartner')).toBe('f_2_ansprechpartner');
    expect(fieldKeyFromLabel('x'.repeat(60))).toHaveLength(40);
  });

  it('reads options from one line, dropping empty and repeated entries', () => {
    expect(optionsFromText(' Gold, Silber ,, Gold,  Bronze ')).toEqual(['Gold', 'Silber', 'Bronze']);
  });
});

describe('Kontakte tab badge', () => {
  it('counts active persons plus organizations', () => {
    expect(contactsTabCount([{ archived: false }, { archived: true }], 2)).toBe(3);
    expect(contactsTabCount([], 0)).toBe(0);
  });
});
