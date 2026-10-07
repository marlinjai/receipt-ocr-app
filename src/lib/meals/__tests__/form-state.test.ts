import { describe, it, expect } from 'vitest';
import { draftFromRecord, draftToInput, isDraftDirty, parseAmount, previewRecord } from '../form-state';
import { mealDeduction, mealStatus } from '../rules';
import { GUEST_A, GUEST_B, SMALL_BUSINESS, meal } from './fixtures';

const DEFAULTS = { host: 'Inhaber Beispiel' };

const untouched = meal({
  mealType: null,
  occasion: '',
  place: '',
  host: '',
  tip: null,
  consumption: null,
  detailsAt: null,
  guests: [],
});

describe('parseAmount', () => {
  it.each([
    ['12,50', 12.5],
    ['12.50', 12.5],
    ['1.234,56', 1234.56],
    ['12', 12],
    [' 5,00 € ', 5],
    ['', null],
    ['   ', null],
  ])('%j -> %j', (text, expected) => {
    expect(parseAmount(text)).toBe(expected);
  });
  it.each(['abc', '12,5,0', '-3', '1e3'])('rejects %j', (text) => {
    expect(Number.isNaN(parseAmount(text))).toBe(true);
  });
});

describe('forward: an untouched meal receipt', () => {
  it('opens with meal type, place and host prefilled, and nothing stored yet', () => {
    const draft = draftFromRecord(untouched, DEFAULTS);
    expect(draft).toMatchObject({
      mealType: 'business_meal_external',
      place: 'Testlokal',
      host: 'Inhaber Beispiel',
      occasion: '',
      guests: [],
      tip: '',
    });
    // The prefills are a pending change: saving would store them.
    expect(isDraftDirty(untouched, draft)).toBe(true);
  });

  it('previews as complete once guests and occasion are filled, before anything is saved', () => {
    const draft = {
      ...draftFromRecord(untouched, DEFAULTS),
      occasion: 'Planung Messeauftritt 2026',
      guests: [GUEST_A],
      tip: '11,00',
    };
    const preview = previewRecord(untouched, draft);
    expect(mealStatus(preview)).toEqual({ kind: 'complete' });
    expect(mealDeduction(preview, SMALL_BUSINESS)).toMatchObject({ base: 130, deductible: 91 });
    // The stored record is still incomplete: the preview is not a save.
    expect(mealStatus(untouched).kind).toBe('incomplete');
  });

  it('turns the draft into the input to save', () => {
    const draft = {
      ...draftFromRecord(untouched, DEFAULTS),
      occasion: '  Planung   Messeauftritt 2026 ',
      guests: [GUEST_B, GUEST_A],
      tip: '11,5',
      consumption: 'dine_in' as const,
    };
    const parsed = draftToInput(draft);
    expect(parsed).toEqual({
      ok: true,
      input: {
        mealType: 'business_meal_external',
        occasion: 'Planung Messeauftritt 2026',
        place: 'Testlokal',
        host: 'Inhaber Beispiel',
        tip: 11.5,
        consumption: 'dine_in',
        taxLines: null,
        guestContactIds: ['c-2', 'c-1'],
        date: '2025-03-14',
        gross: 119,
      },
    });
  });
});

describe('backtrack and revise', () => {
  it('switching the type to "Keine Bewirtung" previews as not a meal, and back restores the entered details', () => {
    const complete = meal();
    const draft = draftFromRecord(complete, DEFAULTS);
    const away = { ...draft, mealType: 'not_a_meal' as const };
    expect(mealStatus(previewRecord(complete, away))).toEqual({ kind: 'not_a_meal' });
    // Nothing was cleared by the switch.
    expect(away.occasion).toBe(complete.occasion);
    expect(away.guests).toEqual(complete.guests);
    const back = { ...away, mealType: 'business_meal_external' as const };
    expect(mealStatus(previewRecord(complete, back))).toEqual({ kind: 'complete' });
    expect(isDraftDirty(complete, back)).toBe(false);
  });

  it('changing the tip changes the previewed deductible amount', () => {
    const complete = meal({ gross: 100, tip: null });
    const draft = draftFromRecord(complete, DEFAULTS);
    expect(mealDeduction(previewRecord(complete, draft), SMALL_BUSINESS)).toMatchObject({ deductible: 70 });
    expect(mealDeduction(previewRecord(complete, { ...draft, tip: '10' }), SMALL_BUSINESS)).toMatchObject({
      deductible: 77,
    });
  });

  it('reopening a saved entry without touching it is not dirty (no gratuitous save)', () => {
    const complete = meal({ taxLines: [{ rate: 19, net: 100, tax: 19 }] });
    expect(isDraftDirty(complete, draftFromRecord(complete, DEFAULTS))).toBe(false);
  });

  it('removing the last guest makes the preview incomplete again', () => {
    const complete = meal();
    const draft = { ...draftFromRecord(complete, DEFAULTS), guests: [] };
    expect(mealStatus(previewRecord(complete, draft))).toEqual({ kind: 'incomplete', missing: ['guests'] });
    expect(isDraftDirty(complete, draft)).toBe(true);
  });
});

describe('resume', () => {
  it('a partially saved entry reopens with exactly what was saved, prefills only where nothing is stored', () => {
    const partial = meal({ occasion: '', host: 'Andere Gastgeberin', guests: [], place: 'Eigener Ort 5' });
    const draft = draftFromRecord(partial, DEFAULTS);
    expect(draft).toMatchObject({ host: 'Andere Gastgeberin', place: 'Eigener Ort 5', occasion: '', tip: '11' });
    expect(isDraftDirty(partial, draft)).toBe(false);
    expect(mealStatus(previewRecord(partial, draft))).toEqual({
      kind: 'incomplete',
      missing: ['occasion', 'guests'],
    });
  });
});

describe('re-entry', () => {
  it('editing a completed entry yields an input that differs only in the edited field', () => {
    const complete = meal();
    const before = draftToInput(draftFromRecord(complete, DEFAULTS));
    const after = draftToInput({ ...draftFromRecord(complete, DEFAULTS), occasion: 'Abnahme Fotoproduktion' });
    if (!before.ok || !after.ok) throw new Error('expected parse');
    expect({ ...after.input, occasion: before.input.occasion }).toEqual(before.input);
  });
});

describe('unreadable input', () => {
  it('names the fields that cannot be read instead of saving garbage', () => {
    const draft = { ...draftFromRecord(meal(), DEFAULTS), tip: 'zehn', gross: '0', date: '14.03.2025' };
    const parsed = draftToInput(draft);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(Object.keys(parsed.errors).sort()).toEqual(['date', 'gross', 'tip']);
  });

  it('reads tax lines with decimal commas, skips empty rows, rejects half-filled ones', () => {
    const base = draftFromRecord(meal(), DEFAULTS);
    const good = draftToInput({
      ...base,
      taxLines: [
        { rate: '7', net: '50,00', tax: '3,50' },
        { rate: '', net: '', tax: '' },
      ],
    });
    expect(good.ok && good.input.taxLines).toEqual([{ rate: 7, net: 50, tax: 3.5 }]);
    const bad = draftToInput({ ...base, taxLines: [{ rate: '19', net: '', tax: '1,90' }] });
    expect(bad.ok).toBe(false);
  });
});
