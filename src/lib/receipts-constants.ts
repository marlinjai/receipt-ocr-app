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

export const WORKSPACE_ID = 'receipt-ocr';

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
