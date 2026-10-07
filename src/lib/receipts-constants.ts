export const CATEGORY_OPTIONS = [
  'Bewirtung',
  'Reisekosten',
  'Bürobedarf',
  'Software & Lizenzen',
  'Telefon & Internet',
  'Hardware & IT',
  'Miete & Nebenkosten',
  'Versicherungen',
  'Fachliteratur',
  'Sonstige Ausgaben',
];

export const CATEGORY_TO_KONTO: Record<string, string> = {
  'Bewirtung': '4650',
  'Reisekosten': '4670',
  'Bürobedarf': '4930',
  'Software & Lizenzen': '4806',
  'Telefon & Internet': '4920',
  'Hardware & IT': '4855',
  'Miete & Nebenkosten': '4210',
  'Versicherungen': '4360',
  'Fachliteratur': '4940',
  'Sonstige Ausgaben': '4900',
};

export const ZUORDNUNG_OPTIONS = ['Universität', 'Geschäftlich', 'Privat'];

export const CURRENCY_OPTIONS = ['EUR', 'USD', 'GBP'];

export const PROJECT_OPTIONS = ['Lola Stories'];

// Shared/partial-business-use attribution defaults (the German "gemischte Nutzung" split).
// Matched by case-insensitive vendor-name substring, same lookup style as VENDOR_CATEGORY_MAP.
// Anything not listed defaults to 100% (fully attributed). Per-invoice override always wins,
// since Business Share % is a plain editable cell, not a locked default.
export const VENDOR_BUSINESS_SHARE_DEFAULTS: Record<string, number> = {
  anthropic: 30,
};

export function getDefaultBusinessSharePercent(vendor: string | null): number {
  if (!vendor) return 100;
  const lower = vendor.toLowerCase();
  for (const [key, percent] of Object.entries(VENDOR_BUSINESS_SHARE_DEFAULTS)) {
    if (lower.includes(key)) return percent;
  }
  return 100;
}

// ── Business-meal register (Bewirtungsverzeichnis) ──────────────────────────

export const MEAL_CATEGORY = 'Bewirtung';
export const PRIVATE_ZUORDNUNG = 'Privat';

/**
 * Meal types. `key` is the stable value used in code and in the export (it
 * matches the `hospitality.type` values of the earlier spreadsheet automation);
 * `label` is the select option name stored on the row and shown in the app.
 */
export const MEAL_TYPES = [
  { key: 'business_meal_external', label: 'Geschäftsessen (extern)' },
  { key: 'staff_meal_internal', label: 'Mitarbeiterbewirtung (intern)' },
  { key: 'travel_meal', label: 'Verpflegung auf Reise' },
  { key: 'not_a_meal', label: 'Keine Bewirtung' },
] as const;

export type MealTypeKey = (typeof MEAL_TYPES)[number]['key'];

export const MEAL_TYPE_OPTIONS: string[] = MEAL_TYPES.map((t) => t.label);

export const CONSUMPTION_TYPES = [
  { key: 'dine_in', label: 'Vor Ort' },
  { key: 'takeaway', label: 'Außer Haus' },
] as const;

export type ConsumptionKey = (typeof CONSUMPTION_TYPES)[number]['key'];

export const CONSUMPTION_OPTIONS: string[] = CONSUMPTION_TYPES.map((t) => t.label);

export function mealTypeKeyFromLabel(label: string | null | undefined): MealTypeKey | null {
  return MEAL_TYPES.find((t) => t.label === label)?.key ?? null;
}

export function mealTypeLabel(key: MealTypeKey): string {
  return MEAL_TYPES.find((t) => t.key === key)!.label;
}

export function consumptionKeyFromLabel(label: string | null | undefined): ConsumptionKey | null {
  return CONSUMPTION_TYPES.find((t) => t.label === label)?.key ?? null;
}

export function consumptionLabel(key: ConsumptionKey): string {
  return CONSUMPTION_TYPES.find((t) => t.key === key)!.label;
}

/** Names of the meal columns on the Receipts table (see COLUMNS in app/actions.ts). */
export const MEAL_COLUMNS = {
  mealType: 'Meal Type',
  occasion: 'Occasion',
  place: 'Place',
  tip: 'Tip',
  host: 'Host',
  consumption: 'Consumption',
  detailsAt: 'Meal Details At',
  taxLines: 'Tax Lines',
} as const;
