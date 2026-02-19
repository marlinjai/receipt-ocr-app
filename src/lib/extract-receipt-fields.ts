import type { OcrResult } from '@/lib/storage';

export interface ExtractionResult {
  vendor: string | null;
  amount: number | null;
  date: string | null; // ISO 8601
  category: string | null; // matches CATEGORY_OPTIONS from receipts-table.ts
}

// ── Amount Extraction ────────────────────────────────────────────────

const CURRENCY_SYMBOL = /[$€£]/;
const US_NUMBER = /\d{1,3}(?:,\d{3})*\.\d{2}/; // 1,234.56
const EU_NUMBER = /\d{1,3}(?:\.\d{3})*,\d{2}/; // 1.234,56
const PLAIN_NUMBER = /\d+\.\d{2}/; // 123.45

function parseAmount(raw: string): number | null {
  const cleaned = raw.replace(CURRENCY_SYMBOL, '').trim();
  // European format: 1.234,56 → 1234.56
  if (EU_NUMBER.test(cleaned)) {
    const normalized = cleaned.replace(/\./g, '').replace(',', '.');
    const val = parseFloat(normalized);
    return isNaN(val) ? null : val;
  }
  // US format: 1,234.56 → 1234.56
  const normalized = cleaned.replace(/,/g, '');
  const val = parseFloat(normalized);
  return isNaN(val) ? null : val;
}

const AMOUNT_PATTERN = new RegExp(
  `(?:[$€£]\\s*)?(?:${US_NUMBER.source}|${EU_NUMBER.source}|${PLAIN_NUMBER.source})(?:\\s*[$€£])?`,
  'g'
);

const HIGH_PRIORITY_TOTAL = /(?:grand\s+total|total\s+due|amount\s+due|balance\s+due)\s*[:\-]?\s*/i;
const MEDIUM_PRIORITY_TOTAL = /(?:^|\s)total\s*[:\-]?\s*/i;
const SUBTOTAL_PATTERN = /sub\s*total/i;
const EU_TOTAL = /(?:gesamt|summe|montant|totale?)\s*[:\-]?\s*/i;

function extractAmount(text: string): number | null {
  const lines = text.split('\n');

  // Pass 1: High-priority labeled totals
  for (const line of lines) {
    if (HIGH_PRIORITY_TOTAL.test(line)) {
      const amounts = line.match(AMOUNT_PATTERN);
      if (amounts) {
        const val = parseAmount(amounts[amounts.length - 1]);
        if (val !== null && val > 0) return val;
      }
    }
  }

  // Pass 2: Generic "Total" (excluding subtotal)
  for (const line of lines) {
    if (MEDIUM_PRIORITY_TOTAL.test(line) && !SUBTOTAL_PATTERN.test(line)) {
      const amounts = line.match(AMOUNT_PATTERN);
      if (amounts) {
        const val = parseAmount(amounts[amounts.length - 1]);
        if (val !== null && val > 0) return val;
      }
    }
  }

  // Pass 3: European keywords
  for (const line of lines) {
    if (EU_TOTAL.test(line)) {
      const amounts = line.match(AMOUNT_PATTERN);
      if (amounts) {
        const val = parseAmount(amounts[amounts.length - 1]);
        if (val !== null && val > 0) return val;
      }
    }
  }

  // Pass 4: Fallback — largest amount on the receipt
  let largest: number | null = null;
  const allAmounts = text.match(AMOUNT_PATTERN);
  if (allAmounts) {
    for (const raw of allAmounts) {
      const val = parseAmount(raw);
      if (val !== null && val > 0 && (largest === null || val > largest)) {
        largest = val;
      }
    }
  }
  return largest;
}

// ── Date Extraction ──────────────────────────────────────────────────

const EXPIRY_KEYWORDS = /\b(?:exp|expir|valid\s*thru|valid\s*through|card|cvv|cvc)\b/i;
const LABELED_DATE = /(?:date|invoice\s+date|transaction\s+date|receipt\s+date)\s*[:\-]\s*/i;

// Date formats
const ISO_DATE = /(\d{4})-(\d{2})-(\d{2})/;
const US_DATE_SLASH = /(\d{1,2})\/(\d{1,2})\/(\d{2,4})/;
const EU_DATE_DOT = /(\d{1,2})\.(\d{1,2})\.(\d{2,4})/;
const NAMED_MONTH = /(\d{1,2})\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*[,.]?\s+(\d{2,4})/i;
const NAMED_MONTH_FIRST = /(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*[.]?\s+(\d{1,2})[,.]?\s+(\d{2,4})/i;

const MONTH_MAP: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

function normalizeYear(y: number): number {
  if (y < 100) return y + 2000;
  return y;
}

function toISO(year: number, month: number, day: number): string | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const y = normalizeYear(year);
  if (y < 1900 || y > 2100) return null;
  const d = new Date(y, month - 1, day);
  if (d.getFullYear() !== y || d.getMonth() !== month - 1 || d.getDate() !== day) return null;
  return d.toISOString();
}

function parseDateFromLine(line: string): string | null {
  // ISO: 2025-01-15
  let m = line.match(ISO_DATE);
  if (m) return toISO(parseInt(m[1]), parseInt(m[2]), parseInt(m[3]));

  // Named month first: Jan 15, 2025
  m = line.match(NAMED_MONTH_FIRST);
  if (m) {
    const month = MONTH_MAP[m[1].toLowerCase().slice(0, 3)];
    return toISO(parseInt(m[3]), month, parseInt(m[2]));
  }

  // Day named month: 15 Jan 2025
  m = line.match(NAMED_MONTH);
  if (m) {
    const month = MONTH_MAP[m[2].toLowerCase().slice(0, 3)];
    return toISO(parseInt(m[3]), month, parseInt(m[1]));
  }

  // European dot: 15.01.2025 → DD.MM.YYYY
  m = line.match(EU_DATE_DOT);
  if (m) {
    const a = parseInt(m[1]), b = parseInt(m[2]), y = parseInt(m[3]);
    return toISO(y, b, a);
  }

  // US slash: 01/15/2025 → MM/DD/YYYY (disambiguate if possible)
  m = line.match(US_DATE_SLASH);
  if (m) {
    const a = parseInt(m[1]), b = parseInt(m[2]), y = parseInt(m[3]);
    // If first number > 12, it must be day (DD/MM/YYYY)
    if (a > 12) return toISO(y, b, a);
    // Otherwise assume US: MM/DD/YYYY
    return toISO(y, a, b);
  }

  return null;
}

function extractDate(text: string): string | null {
  const lines = text.split('\n');

  // Pass 1: Labeled dates
  for (const line of lines) {
    if (LABELED_DATE.test(line) && !EXPIRY_KEYWORDS.test(line)) {
      const date = parseDateFromLine(line);
      if (date) return date;
    }
  }

  // Pass 2: Scan all lines, skip expiry-related
  for (const line of lines) {
    if (EXPIRY_KEYWORDS.test(line)) continue;
    const date = parseDateFromLine(line);
    if (date) return date;
  }

  return null;
}

// ── Vendor Extraction ────────────────────────────────────────────────

const NOISE_PATTERNS = [
  /^\d+$/, // pure numbers
  /^[\d\s.,$€£%\-+*/=]+$/, // numbers + symbols only
  /^\s*$/, // blank
  /^.{1,2}$/, // too short
  /^tel|^phone|^fax|^www\.|^http/i, // contact info
  /^\d{1,5}\s+\w+\s+(st|rd|ave|blvd|dr|ln|ct|way|street|road|avenue|drive)/i, // address
];

function isNoiseLine(text: string): boolean {
  return NOISE_PATTERNS.some((p) => p.test(text.trim()));
}

function extractVendorSpatial(blocks: OcrResult['blocks']): string | null {
  if (!blocks || blocks.length === 0) return null;

  // Sort by y position (topmost first)
  const sorted = [...blocks].sort((a, b) => a.boundingBox.y - b.boundingBox.y);

  // Take the first non-noise block
  for (const block of sorted.slice(0, 10)) {
    const text = block.text.trim();
    if (!isNoiseLine(text) && text.length >= 3 && text.length <= 60) {
      return text;
    }
  }
  return null;
}

function extractVendorFallback(text: string): string | null {
  const lines = text.split('\n').slice(0, 5);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!isNoiseLine(trimmed) && trimmed.length >= 3 && trimmed.length <= 60) {
      return trimmed;
    }
  }
  return null;
}

function extractVendor(ocrData: OcrResult): string | null {
  return extractVendorSpatial(ocrData.blocks) ?? extractVendorFallback(ocrData.fullText);
}

// ── Category Inference ───────────────────────────────────────────────

const VENDOR_CATEGORY_MAP: Record<string, string> = {
  // Food & Beverage
  mcdonald: 'Food', 'burger king': 'Food', wendy: 'Food', subway: 'Food',
  starbucks: 'Food', dunkin: 'Food', chipotle: 'Food', domino: 'Food',
  'pizza hut': 'Food', 'taco bell': 'Food', chick: 'Food', panera: 'Food',
  'whole foods': 'Food', trader: 'Food', kroger: 'Food', safeway: 'Food',
  walmart: 'Food', aldi: 'Food', lidl: 'Food', rewe: 'Food', edeka: 'Food',
  costco: 'Food', target: 'Food',
  // Travel
  uber: 'Travel', lyft: 'Travel', delta: 'Travel', united: 'Travel',
  american: 'Travel', southwest: 'Travel', jetblue: 'Travel', hilton: 'Travel',
  marriott: 'Travel', airbnb: 'Travel', hertz: 'Travel', avis: 'Travel',
  shell: 'Travel', bp: 'Travel', exxon: 'Travel', chevron: 'Travel',
  // Office
  staples: 'Office', 'office depot': 'Office', amazon: 'Office',
  // Utilities
  'at&t': 'Utilities', verizon: 'Utilities', 't-mobile': 'Utilities',
  comcast: 'Utilities', spectrum: 'Utilities',
  // Entertainment
  netflix: 'Entertainment', spotify: 'Entertainment', apple: 'Entertainment',
  google: 'Entertainment', steam: 'Entertainment', amc: 'Entertainment',
};

const KEYWORD_CATEGORIES: Array<{ pattern: RegExp; category: string }> = [
  { pattern: /\b(?:restaurant|cafe|coffee|bakery|pizza|burger|sushi|grill|diner|food|grocery|supermarket|market)\b/i, category: 'Food' },
  { pattern: /\b(?:hotel|motel|airline|flight|airport|rental\s*car|taxi|parking|gas\s*station|fuel|petrol)\b/i, category: 'Travel' },
  { pattern: /\b(?:office|supplies|paper|ink|toner|printer|desk|chair|stationery)\b/i, category: 'Office' },
  { pattern: /\b(?:electric|water|gas|internet|phone|utility|telecom|broadband)\b/i, category: 'Utilities' },
  { pattern: /\b(?:cinema|theater|theatre|movie|concert|ticket|game|streaming|music|subscription)\b/i, category: 'Entertainment' },
];

function inferCategory(vendor: string | null, fullText: string): string | null {
  // Pass 1: Known vendor lookup
  if (vendor) {
    const lower = vendor.toLowerCase();
    for (const [key, category] of Object.entries(VENDOR_CATEGORY_MAP)) {
      if (lower.includes(key)) return category;
    }
  }

  // Pass 2: Keyword scan on full text
  for (const { pattern, category } of KEYWORD_CATEGORIES) {
    if (pattern.test(fullText)) return category;
  }

  return null;
}

// ── Main Export ───────────────────────────────────────────────────────

export function extractReceiptFields(ocrData: OcrResult): ExtractionResult {
  const vendor = extractVendor(ocrData);
  const amount = extractAmount(ocrData.fullText);
  const date = extractDate(ocrData.fullText);
  const category = inferCategory(vendor, ocrData.fullText);

  return { vendor, amount, date, category };
}
