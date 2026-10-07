import type { ConsumptionKey, MealTypeKey } from '@/lib/receipts-constants';
import { inputFromRecord, sameMealInput, type MealDetailsInput } from './input';
import type { MealGuestEntry, MealRecord, TaxLine } from './types';

/**
 * The meal form's state, as pure functions: record -> draft (what the inputs
 * show) -> input (what gets saved). Keeping this out of the component makes
 * the flow paths testable without a browser, and guarantees the panel form
 * and the queue form behave identically.
 */

export interface TaxLineDraft {
  rate: string;
  net: string;
  tax: string;
}

export interface MealDraft {
  mealType: MealTypeKey | null;
  occasion: string;
  place: string;
  host: string;
  /** Text as typed; German decimal comma allowed. */
  tip: string;
  consumption: ConsumptionKey | null;
  guests: MealGuestEntry[];
  date: string;
  gross: string;
  taxLines: TaxLineDraft[];
}

export interface DraftDefaults {
  /** The host used most recently in this workspace. */
  host: string;
}

function amountText(value: number | null): string {
  return value === null || value === undefined ? '' : String(value).replace('.', ',');
}

/**
 * The draft a record opens with. Three fields are PREFILLED when the record
 * has nothing stored: meal type (external business meal, the common case),
 * place (from the vendor) and host (the one used last). Prefills are part of
 * the draft only; nothing is stored until the user saves.
 */
export function draftFromRecord(record: MealRecord, defaults: DraftDefaults): MealDraft {
  return {
    mealType: record.mealType ?? 'business_meal_external',
    occasion: record.occasion,
    place: record.place || record.vendor || '',
    host: record.host || defaults.host,
    tip: amountText(record.tip),
    consumption: record.consumption,
    guests: record.guests,
    date: record.date ?? '',
    gross: amountText(record.gross),
    taxLines: (record.taxLines ?? []).map((l) => ({
      rate: amountText(l.rate),
      net: amountText(l.net),
      tax: amountText(l.tax),
    })),
  };
}

/** Parse "12,50", "12.50", "1.234,56" or "12" to a number; null for empty; NaN for garbage. */
export function parseAmount(text: string): number | null {
  const trimmed = text.trim().replace(/\s|€|EUR/gi, '');
  if (!trimmed) return null;
  let normalized = trimmed;
  if (/,/.test(trimmed)) normalized = trimmed.replace(/\./g, '').replace(',', '.');
  if (!/^\d+(\.\d+)?$/.test(normalized)) return NaN;
  return Number(normalized);
}

export type DraftField = 'tip' | 'gross' | 'date' | 'taxLines';

export type DraftParse =
  | { ok: true; input: MealDetailsInput }
  | { ok: false; errors: Partial<Record<DraftField, string>> };

/** Turn the draft into the input to save, or say which fields cannot be read. */
export function draftToInput(draft: MealDraft): DraftParse {
  const errors: Partial<Record<DraftField, string>> = {};

  const tip = parseAmount(draft.tip);
  if (tip !== null && (Number.isNaN(tip) || tip < 0)) errors.tip = 'Bitte einen Betrag eingeben, zum Beispiel 5,00.';

  const gross = parseAmount(draft.gross);
  if (gross !== null && (Number.isNaN(gross) || gross <= 0)) {
    errors.gross = 'Bitte einen Betrag größer als null eingeben.';
  }

  const date = draft.date.trim();
  if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) errors.date = 'Bitte ein gültiges Datum wählen.';

  const taxLines: TaxLine[] = [];
  for (const line of draft.taxLines) {
    if (!line.rate.trim() && !line.net.trim() && !line.tax.trim()) continue; // an empty row is no row
    const rate = parseAmount(line.rate);
    const net = parseAmount(line.net);
    const tax = parseAmount(line.tax);
    if (
      rate === null || net === null || tax === null ||
      Number.isNaN(rate) || Number.isNaN(net) || Number.isNaN(tax) ||
      rate > 100
    ) {
      errors.taxLines = 'Jede Steuerzeile braucht Steuersatz, Netto und Steuer als Zahl.';
      break;
    }
    taxLines.push({ rate, net, tax });
  }

  if (Object.keys(errors).length > 0) return { ok: false, errors };

  return {
    ok: true,
    input: {
      mealType: draft.mealType,
      occasion: draft.occasion.replace(/[ \t]+/g, ' ').trim(),
      place: draft.place.replace(/[ \t]+/g, ' ').trim(),
      host: draft.host.replace(/[ \t]+/g, ' ').trim(),
      tip: tip === null || tip === 0 ? null : Math.round(tip * 100) / 100,
      consumption: draft.consumption,
      taxLines: taxLines.length > 0 ? taxLines : null,
      guestContactIds: draft.guests.map((g) => g.contactId),
      date: date || null,
      gross: gross === null ? null : Math.round(gross * 100) / 100,
    },
  };
}

/**
 * The record as it would read once the draft is saved. The form shows the
 * status and the deductible amount of THIS (through the same rules as
 * everywhere else), so the user sees "complete" before pressing save.
 */
export function previewRecord(record: MealRecord, draft: MealDraft): MealRecord {
  const parsed = draftToInput(draft);
  if (!parsed.ok) return { ...record, guests: draft.guests, mealType: draft.mealType };
  const { input } = parsed;
  return {
    ...record,
    mealType: input.mealType,
    occasion: input.occasion,
    place: input.place,
    host: input.host,
    tip: input.tip,
    consumption: input.consumption,
    taxLines: input.taxLines,
    date: input.date ?? record.date,
    gross: input.gross ?? record.gross,
    guests: draft.guests,
  };
}

/** True when saving the draft would change what is stored. */
export function isDraftDirty(record: MealRecord, draft: MealDraft): boolean {
  const parsed = draftToInput(draft);
  if (!parsed.ok) return true;
  const stored = inputFromRecord(record);
  const merged = {
    ...parsed.input,
    date: parsed.input.date ?? stored.date,
    gross: parsed.input.gross ?? stored.gross,
  };
  return !sameMealInput(merged, stored);
}
