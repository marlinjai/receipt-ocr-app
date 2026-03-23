import type { OcrResult } from '@/lib/ocr-types';
import { CATEGORY_TO_KONTO } from '@/lib/receipts-constants';

export interface ExtractionResult {
  name: string; // descriptive summary, always generated
  vendor: string | null;
  gross: number | null; // total incl. tax
  net: number | null; // before tax
  taxRate: number | null; // percentage, e.g. 19 for 19%
  date: string | null; // ISO 8601
  category: string | null; // matches CATEGORY_OPTIONS (SKR03) from receipts-table.ts
  konto: string | null; // SKR03 account number (e.g. "4650")
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
// Pattern 1: item name followed by a price (e.g. "Cappuccino 3.50" or "USB Cable €12.99")
const ITEM_LINE_PRICE = /^(.{3,50}?)\s+[$€£]?\s*(?:\d{1,3}(?:[.,]\d{3})*[.,]\d{2}|\d+[.,]\d{2})/;
// Pattern 2: quantity + item (e.g. "2x Latte Macchiato" or "1 Chicken Sandwich")
const ITEM_LINE_QTY = /^\d+\s*[x×*]?\s+(.{3,50})/i;
// Pattern 3: item with article/SKU number prefix (e.g. "ART-1234 Wireless Mouse")
const ITEM_LINE_SKU = /^(?:[A-Z]{2,5}[-.]?\d{3,10})\s+(.{3,50})/;

const SKIP_FOR_ITEMS = /(?:total|tax|subtotal|sub-total|change|balance|due|paid|payment|visa|mastercard|amex|debit|credit|card|cash|bar|ec|girocard|date|datum|invoice|rechnung|receipt|beleg|quittung|bon|tel|phone|fax|www|http|email|mail|straße|strasse|street|ave|blvd|road|st\s+\d|platz|weg|gasse|bill\s+to|ship\s+to|sold\s+to|ust|mwst|vat|netto|brutto|zwischensumme|rückgeld|trinkgeld|tip|gratuity|discount|rabatt|coupon|gutschein|kundennr|customer|bedient|cashier|kasse|filiale|store|branch|vielen\s+dank|thank|danke|bitte|please|öffnungszeit|hours)/i;

// Additional noise: lines that are just whitespace, dashes, equals, or decorators
const DECORATOR_LINE = /^[\s\-=*_#.+~]{2,}$/;

function cleanItemName(raw: string): string {
  return raw
    .replace(/\s+x?\d+\s*$/, '') // trailing quantity "x2"
    .replace(/\s*\*+\s*$/, '') // trailing asterisks
    .replace(/\s{2,}/g, ' ') // collapse spaces
    .trim();
}

function extractItems(lines: string[], vendor: string | null): string[] {
  const items: string[] = [];
  const seen = new Set<string>();

  for (const line of lines) {
    if (items.length >= 3) break;
    const trimmed = line.trim();
    if (!trimmed || trimmed.length < 3 || trimmed.length > 80) continue;
    if (SKIP_FOR_ITEMS.test(trimmed)) continue;
    if (DECORATOR_LINE.test(trimmed)) continue;
    if (isNoiseLine(trimmed)) continue;
    // Skip vendor name lines
    if (vendor && trimmed.toLowerCase().includes(vendor.toLowerCase())) continue;

    let itemName: string | null = null;

    // Try quantity pattern first (most specific)
    const qtyMatch = trimmed.match(ITEM_LINE_QTY);
    if (qtyMatch) {
      itemName = cleanItemName(qtyMatch[1]);
    }

    // Try SKU pattern
    if (!itemName) {
      const skuMatch = trimmed.match(ITEM_LINE_SKU);
      if (skuMatch) {
        itemName = cleanItemName(skuMatch[1]);
      }
    }

    // Try price pattern (most common)
    if (!itemName) {
      const priceMatch = trimmed.match(ITEM_LINE_PRICE);
      if (priceMatch) {
        itemName = cleanItemName(priceMatch[1]);
      }
    }

    if (itemName && itemName.length >= 3 && !seen.has(itemName.toLowerCase())) {
      // Skip if the item name is just numbers or symbols
      if (/^[\d\s.,$€£%\-+*/=]+$/.test(itemName)) continue;
      seen.add(itemName.toLowerCase());
      items.push(itemName);
    }
  }

  return items;
}

function extractName(
  vendor: string | null,
  ocrData: OcrResult,
  gross: number | null,
  date: string | null,
): string {
  const lines = ocrData.fullText.split('\n');
  const items = extractItems(lines, vendor);

  // Build name from available parts
  const parts: string[] = [];

  if (vendor) parts.push(vendor);

  if (items.length > 0) {
    parts.push(items.join(', '));
  }

  if (gross !== null) {
    parts.push(`€${gross.toFixed(2)}`);
  }

  if (date) {
    const d = new Date(date);
    if (!isNaN(d.getTime())) {
      parts.push(d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' }));
    }
  }

  if (parts.length > 0) {
    return parts.join(' – ');
  }

  // Absolute fallback: first non-noise line from OCR
  for (const line of lines.slice(0, 10)) {
    const trimmed = line.trim();
    if (trimmed.length >= 3 && !isNoiseLine(trimmed)) {
      return trimmed;
    }
  }

  return 'Receipt';
}

// ── Category Inference ───────────────────────────────────────────────

const VENDOR_CATEGORY_MAP: Record<string, string> = {
  // Bewirtung (4650)
  mcdonald: 'Bewirtung', 'burger king': 'Bewirtung', wendy: 'Bewirtung', subway: 'Bewirtung',
  starbucks: 'Bewirtung', dunkin: 'Bewirtung', chipotle: 'Bewirtung', domino: 'Bewirtung',
  'pizza hut': 'Bewirtung', 'taco bell': 'Bewirtung', chick: 'Bewirtung', panera: 'Bewirtung',
  'whole foods': 'Bewirtung', trader: 'Bewirtung', kroger: 'Bewirtung', safeway: 'Bewirtung',
  walmart: 'Bewirtung', aldi: 'Bewirtung', lidl: 'Bewirtung', rewe: 'Bewirtung', edeka: 'Bewirtung',
  costco: 'Bewirtung', nordsee: 'Bewirtung', vapiano: 'Bewirtung', 'dean & david': 'Bewirtung',
  backwerk: 'Bewirtung', 'back factory': 'Bewirtung',
  // Reisekosten (4670)
  uber: 'Reisekosten', lyft: 'Reisekosten', delta: 'Reisekosten', united: 'Reisekosten',
  lufthansa: 'Reisekosten', ryanair: 'Reisekosten', easyjet: 'Reisekosten', eurowings: 'Reisekosten',
  flixbus: 'Reisekosten', 'deutsche bahn': 'Reisekosten', bahn: 'Reisekosten',
  southwest: 'Reisekosten', jetblue: 'Reisekosten', hilton: 'Reisekosten',
  marriott: 'Reisekosten', airbnb: 'Reisekosten', 'booking.com': 'Reisekosten',
  hertz: 'Reisekosten', avis: 'Reisekosten', sixt: 'Reisekosten',
  shell: 'Reisekosten', bp: 'Reisekosten', aral: 'Reisekosten', esso: 'Reisekosten',
  total: 'Reisekosten', jet: 'Reisekosten',
  // Bürobedarf (4930)
  staples: 'Bürobedarf', 'office depot': 'Bürobedarf', amazon: 'Bürobedarf',
  viking: 'Bürobedarf', 'büro discount': 'Bürobedarf',
  // Software & Lizenzen (4806)
  netflix: 'Software & Lizenzen', spotify: 'Software & Lizenzen', adobe: 'Software & Lizenzen',
  microsoft: 'Software & Lizenzen', google: 'Software & Lizenzen', apple: 'Software & Lizenzen',
  github: 'Software & Lizenzen', vercel: 'Software & Lizenzen', cloudflare: 'Software & Lizenzen',
  notion: 'Software & Lizenzen', figma: 'Software & Lizenzen', slack: 'Software & Lizenzen',
  openai: 'Software & Lizenzen', anthropic: 'Software & Lizenzen', aws: 'Software & Lizenzen',
  hetzner: 'Software & Lizenzen', digitalocean: 'Software & Lizenzen', steam: 'Software & Lizenzen',
  // Telefon & Internet (4920)
  'at&t': 'Telefon & Internet', verizon: 'Telefon & Internet', 't-mobile': 'Telefon & Internet',
  comcast: 'Telefon & Internet', spectrum: 'Telefon & Internet',
  telekom: 'Telefon & Internet', vodafone: 'Telefon & Internet', 'o2': 'Telefon & Internet',
  '1&1': 'Telefon & Internet', congstar: 'Telefon & Internet',
  // Hardware & IT (4855)
  dell: 'Hardware & IT', lenovo: 'Hardware & IT', logitech: 'Hardware & IT',
  samsung: 'Hardware & IT', 'media markt': 'Hardware & IT', saturn: 'Hardware & IT',
  cyberport: 'Hardware & IT', notebooksbilliger: 'Hardware & IT',
  // Versicherungen (4360)
  allianz: 'Versicherungen', axa: 'Versicherungen', huk: 'Versicherungen',
  ergo: 'Versicherungen', 'hanse merkur': 'Versicherungen',
};

const KEYWORD_CATEGORIES: Array<{ pattern: RegExp; category: string }> = [
  { pattern: /\b(?:restaurant|cafe|café|coffee|bakery|pizza|burger|sushi|grill|diner|food|grocery|supermarket|market|meal|breakfast|lunch|dinner|gastronomie|essen|bewirtung|catering|imbiss|bäckerei|metzgerei)\b/i, category: 'Bewirtung' },
  { pattern: /\b(?:hotel|motel|airline|flight|airport|rental\s*car|taxi|parking|gas\s*station|fuel|petrol|travel|booking|bahn|zug|flug|reise|tankstelle|mietwagen|fahrt|übernachtung)\b/i, category: 'Reisekosten' },
  { pattern: /\b(?:office|supplies|paper|ink|toner|printer|desk|chair|stationery|büro|papier|ordner|schreibwaren|möbel|büromaterial)\b/i, category: 'Bürobedarf' },
  { pattern: /\b(?:software|license|lizenz|saas|subscription|hosting|domain|server|cloud|app\s*store|play\s*store)\b/i, category: 'Software & Lizenzen' },
  { pattern: /\b(?:phone|telefon|internet|broadband|mobile|wireless|mobilfunk|festnetz|dsl|glasfaser|handy)\b/i, category: 'Telefon & Internet' },
  { pattern: /\b(?:computer|laptop|notebook|monitor|keyboard|mouse|tastatur|drucker|scanner|kabel|adapter|festplatte|ssd|ram|usb|hdmi|peripherie)\b/i, category: 'Hardware & IT' },
  { pattern: /\b(?:miete|rent|nebenkosten|electric|strom|water|wasser|gas|heizung|utility|grundsteuer|hausgeld)\b/i, category: 'Miete & Nebenkosten' },
  { pattern: /\b(?:insurance|versicherung|police|prämie|beitrag|haftpflicht|berufshaftpflicht)\b/i, category: 'Versicherungen' },
  { pattern: /\b(?:book|buch|journal|zeitschrift|fachbuch|fachliteratur|magazine|magazin|fachzeitschrift|ebook)\b/i, category: 'Fachliteratur' },
];

// Broader keyword scan that also checks for common receipt item patterns
const ITEM_CATEGORY_HINTS: Array<{ pattern: RegExp; category: string }> = [
  { pattern: /\b(?:latte|espresso|cappuccino|americano|mocha|frappuccino|tea|drink|sandwich|salad|soup|appetizer|dessert|entree|main\s+course|menü|vorspeise|hauptgericht|nachtisch|getränk)\b/i, category: 'Bewirtung' },
  { pattern: /\b(?:check.?in|check.?out|room\s+\d|night|nights|stay|accommodation|boarding|layover|fare|mileage|km|miles|einzelfahrt|tageskarte|hin\s*und\s*rück)\b/i, category: 'Reisekosten' },
  { pattern: /\b(?:a4|a3|letter|legal|copy|copies|print|scan|kopierpapier|druckerpapier|briefumschlag|heftklammer)\b/i, category: 'Bürobedarf' },
  { pattern: /\b(?:pro\s*plan|monthly|monatlich|jährlich|yearly|annual|user\s*seat|per\s*month)\b/i, category: 'Software & Lizenzen' },
  { pattern: /\b(?:kwh|kilowatt|bandwidth|data\s+plan|gb|mbps|minutes|sms|datenvolumen|flatrate|tarif)\b/i, category: 'Telefon & Internet' },
  { pattern: /\b(?:cpu|gpu|mainboard|grafikkarte|netzteil|gehäuse|arbeitsspeicher|laufwerk)\b/i, category: 'Hardware & IT' },
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

  return 'Sonstige Ausgaben';
}

// ── Main Export ───────────────────────────────────────────────────────

// Categories that qualify for the reduced 7% German MwSt rate
const REDUCED_RATE_CATEGORIES = new Set([
  'Bewirtung',      // Food/groceries qualify for 7%, restaurant dine-in is 19%
  'Fachliteratur',  // Books/publications are 7%
]);

function defaultTaxRate(category: string | null): number {
  if (category && REDUCED_RATE_CATEGORIES.has(category)) return 7;
  return 19; // Standard German MwSt
}

export function extractReceiptFields(ocrData: OcrResult): ExtractionResult {
  const vendor = extractVendor(ocrData);
  const { gross, net, tax } = extractAmounts(ocrData.fullText);
  const date = extractDate(ocrData.fullText);
  const category = inferCategory(vendor, ocrData.fullText);
  const name = extractName(vendor, ocrData, gross, date);
  const konto = category ? CATEGORY_TO_KONTO[category] ?? null : null;

  // Calculate tax rate from gross and net, or default based on category
  let taxRate: number | null = null;
  if (gross !== null && net !== null && net > 0) {
    taxRate = Math.round(((gross - net) / net) * 10000) / 100;
  } else {
    taxRate = defaultTaxRate(category);
  }

  // Always calculate net from gross if not explicitly found
  let finalNet = net;
  if (finalNet === null && gross !== null && taxRate !== null) {
    finalNet = Math.round((gross / (1 + taxRate / 100)) * 100) / 100;
  }

  return { name, vendor, gross, net: finalNet, taxRate, date, category, konto };
}
