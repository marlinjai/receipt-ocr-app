import type { OcrResult } from '@/lib/ocr-types';

export interface ExtractionResult {
  name: string | null; // descriptive summary
  vendor: string | null;
  gross: number | null; // total incl. tax
  net: number | null; // before tax
  taxRate: number | null; // percentage, e.g. 19 for 19%
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
const EU_TOTAL = /(?:gesamt|summe|montant|totale?|brutto)\s*[:\-]?\s*/i;
const NET_PATTERN = /(?:sub\s*total|net|netto|net\s*amount|before\s*tax|excl\.?\s*(?:tax|vat|mwst))\s*[:\-]?\s*/i;
const TAX_PATTERN = /(?:(?:sales\s+)?tax|vat|mwst|ust|tva|iva|gst|hst)\s*[:\-]?\s*/i;

function extractAmountFromLine(line: string): number | null {
  const amounts = line.match(AMOUNT_PATTERN);
  if (amounts) {
    const val = parseAmount(amounts[amounts.length - 1]);
    if (val !== null && val > 0) return val;
  }
  return null;
}

interface AmountBreakdown {
  gross: number | null;
  net: number | null;
  tax: number | null;
}

function extractAmounts(text: string): AmountBreakdown {
  const lines = text.split('\n');
  let gross: number | null = null;
  let net: number | null = null;
  let tax: number | null = null;

  // Extract net (subtotal / before tax)
  for (const line of lines) {
    if (NET_PATTERN.test(line)) {
      const val = extractAmountFromLine(line);
      if (val !== null) { net = val; break; }
    }
  }

  // Extract tax
  for (const line of lines) {
    if (TAX_PATTERN.test(line) && !MEDIUM_PRIORITY_TOTAL.test(line)) {
      const val = extractAmountFromLine(line);
      if (val !== null) { tax = val; break; }
    }
  }

  // Extract gross (total)
  // Pass 1: High-priority labeled totals
  for (const line of lines) {
    if (HIGH_PRIORITY_TOTAL.test(line)) {
      const val = extractAmountFromLine(line);
      if (val !== null) { gross = val; break; }
    }
  }

  // Pass 2: Generic "Total" (excluding subtotal)
  if (gross === null) {
    for (const line of lines) {
      if (MEDIUM_PRIORITY_TOTAL.test(line) && !SUBTOTAL_PATTERN.test(line) && !TAX_PATTERN.test(line)) {
        const val = extractAmountFromLine(line);
        if (val !== null) { gross = val; break; }
      }
    }
  }

  // Pass 3: European keywords
  if (gross === null) {
    for (const line of lines) {
      if (EU_TOTAL.test(line)) {
        const val = extractAmountFromLine(line);
        if (val !== null) { gross = val; break; }
      }
    }
  }

  // Pass 4: Fallback — largest amount
  if (gross === null) {
    const allAmounts = text.match(AMOUNT_PATTERN);
    if (allAmounts) {
      for (const raw of allAmounts) {
        const val = parseAmount(raw);
        if (val !== null && val > 0 && (gross === null || val > gross)) {
          gross = val;
        }
      }
    }
  }

  // Derive missing values if we have two of three
  if (gross !== null && net !== null && tax === null) {
    const derived = Math.round((gross - net) * 100) / 100;
    if (derived > 0) tax = derived;
  } else if (gross !== null && tax !== null && net === null) {
    const derived = Math.round((gross - tax) * 100) / 100;
    if (derived > 0) net = derived;
  } else if (net !== null && tax !== null && gross === null) {
    gross = Math.round((net + tax) * 100) / 100;
  }

  return { gross, net, tax };
}

// ── Date Extraction ──────────────────────────────────────────────────

const EXPIRY_KEYWORDS = /\b(?:exp|expir|valid\s*thru|valid\s*through|card|cvv|cvc)\b/i;
const LABELED_DATE = /(?:date|invoice\s+date|transaction\s+date|receipt\s+date)\s*[:\-]\s*/i;

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
  let m = line.match(ISO_DATE);
  if (m) return toISO(parseInt(m[1]), parseInt(m[2]), parseInt(m[3]));

  m = line.match(NAMED_MONTH_FIRST);
  if (m) {
    const month = MONTH_MAP[m[1].toLowerCase().slice(0, 3)];
    return toISO(parseInt(m[3]), month, parseInt(m[2]));
  }

  m = line.match(NAMED_MONTH);
  if (m) {
    const month = MONTH_MAP[m[2].toLowerCase().slice(0, 3)];
    return toISO(parseInt(m[3]), month, parseInt(m[1]));
  }

  m = line.match(EU_DATE_DOT);
  if (m) {
    const a = parseInt(m[1]), b = parseInt(m[2]), y = parseInt(m[3]);
    return toISO(y, b, a);
  }

  m = line.match(US_DATE_SLASH);
  if (m) {
    const a = parseInt(m[1]), b = parseInt(m[2]), y = parseInt(m[3]);
    if (a > 12) return toISO(y, b, a);
    return toISO(y, a, b);
  }

  return null;
}

function extractDate(text: string): string | null {
  const lines = text.split('\n');

  for (const line of lines) {
    if (LABELED_DATE.test(line) && !EXPIRY_KEYWORDS.test(line)) {
      const date = parseDateFromLine(line);
      if (date) return date;
    }
  }

  for (const line of lines) {
    if (EXPIRY_KEYWORDS.test(line)) continue;
    const date = parseDateFromLine(line);
    if (date) return date;
  }

  return null;
}

// ── Vendor Extraction ────────────────────────────────────────────────

// Words that are NOT vendor names — generic document/receipt headings
const GENERIC_HEADINGS = /^(?:invoice|receipt|bill|statement|order|confirmation|tax\s+invoice|credit\s+note|purchase\s+order|sales\s+receipt|payment\s+receipt|original|copy|duplicate|page)(?:\s*#?\s*\d*)?$/i;

const NOISE_PATTERNS = [
  /^\d+$/, // pure numbers
  /^[\d\s.,$€£%\-+*/=]+$/, // numbers + symbols only
  /^\s*$/, // blank
  /^.{1,2}$/, // too short
  /^tel|^phone|^fax|^www\.|^http/i, // contact info
  /^\d{1,5}\s+\w+\s+(st|rd|ave|blvd|dr|ln|ct|way|street|road|avenue|drive)/i, // address
  /^bill\s+to|^ship\s+to|^sold\s+to|^customer|^client/i, // recipient labels
  /^date|^invoice\s+(date|number|no)|^order\s+(date|number|no)/i, // metadata labels
  /^\d{4,5}\s+\w+/i, // zip + city
];

function isNoiseLine(text: string): boolean {
  const trimmed = text.trim();
  if (GENERIC_HEADINGS.test(trimmed)) return true;
  return NOISE_PATTERNS.some((p) => p.test(trimmed));
}

function extractVendorSpatial(blocks: OcrResult['blocks']): string | null {
  if (!blocks || blocks.length === 0) return null;

  const sorted = [...blocks].sort((a, b) => a.boundingBox.y - b.boundingBox.y);

  for (const block of sorted.slice(0, 10)) {
    const text = block.text.trim();
    if (!isNoiseLine(text) && text.length >= 3 && text.length <= 60) {
      return text;
    }
  }
  return null;
}

function extractVendorFallback(text: string): string | null {
  const lines = text.split('\n').slice(0, 8);
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

// ── Name Generation ──────────────────────────────────────────────────

// Lines that look like purchased items (not totals, not headers, not metadata)
const ITEM_LINE = /^(.{3,40})\s+[$€£]?\d/;
const SKIP_FOR_ITEMS = /(?:total|tax|subtotal|change|balance|due|paid|visa|mastercard|amex|card|cash|date|invoice|receipt|tel|phone|fax|www|straße|strasse|street|ave|blvd|road|st\s+\d|bill\s+to|ship\s+to)/i;

function extractName(vendor: string | null, ocrData: OcrResult): string | null {
  const lines = ocrData.fullText.split('\n');

  // Try to find 1-3 item lines to summarize what was bought
  const items: string[] = [];
  for (const line of lines) {
    if (items.length >= 3) break;
    const trimmed = line.trim();
    if (SKIP_FOR_ITEMS.test(trimmed)) continue;
    // Skip lines that contain the vendor name (avoid "Vendor - Vendor" in name)
    if (vendor && trimmed.toLowerCase().includes(vendor.toLowerCase())) continue;
    const match = trimmed.match(ITEM_LINE);
    if (match) {
      const itemName = match[1].replace(/\s+x?\d+$/, '').trim();
      if (itemName.length >= 3) items.push(itemName);
    }
  }

  if (vendor && items.length > 0) {
    return `${vendor} - ${items.join(', ')}`;
  }
  if (vendor) {
    return `${vendor} Receipt`;
  }
  if (items.length > 0) {
    return items.join(', ');
  }
  return null;
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
  { pattern: /\b(?:restaurant|cafe|coffee|bakery|pizza|burger|sushi|grill|diner|food|grocery|supermarket|market|meal|breakfast|lunch|dinner)\b/i, category: 'Food' },
  { pattern: /\b(?:hotel|motel|airline|flight|airport|rental\s*car|taxi|parking|gas\s*station|fuel|petrol|travel|booking)\b/i, category: 'Travel' },
  { pattern: /\b(?:office|supplies|paper|ink|toner|printer|desk|chair|stationery|software|license|saas|design|consulting|freelance|web\s*design|development|hosting|domain|server)\b/i, category: 'Office' },
  { pattern: /\b(?:electric|water|gas|internet|phone|utility|telecom|broadband|mobile|wireless)\b/i, category: 'Utilities' },
  { pattern: /\b(?:cinema|theater|theatre|movie|concert|ticket|game|streaming|music|subscription|entertainment)\b/i, category: 'Entertainment' },
];

// Broader keyword scan that also checks for common receipt item patterns
const ITEM_CATEGORY_HINTS: Array<{ pattern: RegExp; category: string }> = [
  { pattern: /\b(?:latte|espresso|cappuccino|americano|mocha|frappuccino|tea|drink|sandwich|salad|soup|appetizer|dessert|entree|main\s+course)\b/i, category: 'Food' },
  { pattern: /\b(?:check.?in|check.?out|room\s+\d|night|nights|stay|accommodation|boarding|layover|fare|mileage|km|miles)\b/i, category: 'Travel' },
  { pattern: /\b(?:a4|a3|letter|legal|copy|copies|print|scan|usb|hdmi|cable|adapter|keyboard|mouse|monitor)\b/i, category: 'Office' },
  { pattern: /\b(?:kwh|kilowatt|bandwidth|data\s+plan|gb|mbps|minutes|sms)\b/i, category: 'Utilities' },
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

  // Pass 3: Item-level hints (more specific patterns)
  for (const { pattern, category } of ITEM_CATEGORY_HINTS) {
    if (pattern.test(fullText)) return category;
  }

  return null;
}

// ── Main Export ───────────────────────────────────────────────────────

export function extractReceiptFields(ocrData: OcrResult): ExtractionResult {
  const vendor = extractVendor(ocrData);
  const { gross, net, tax } = extractAmounts(ocrData.fullText);
  const date = extractDate(ocrData.fullText);
  const category = inferCategory(vendor, ocrData.fullText);
  const name = extractName(vendor, ocrData);

  // Calculate tax rate from gross and net
  let taxRate: number | null = null;
  if (gross !== null && net !== null && net > 0) {
    taxRate = Math.round(((gross - net) / net) * 10000) / 100; // e.g. 19.00
  }

  return { name, vendor, gross, net, taxRate, date, category };
}
