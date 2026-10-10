import type { OcrResult } from '@/lib/ocr-types';
import { CATEGORY_TO_KONTO } from '@/lib/receipts-constants';
import { defaultTaxRate } from '@/lib/meals/classify';
import { MEAL_CATEGORY } from '@/lib/receipts-constants';
import { readAmounts, type AmountCheck, type TaxGroup } from '@/lib/extraction/amounts';
import { readDate } from '@/lib/extraction/date';
import { mealEvidence, type MealEvidence } from '@/lib/extraction/meal-evidence';
import { readVendor, type VendorConfidence } from '@/lib/extraction/vendor';

export interface ExtractionResult {
  name: string; // descriptive summary, always generated
  vendor: string | null;
  gross: number | null; // total incl. tax
  net: number | null; // before tax
  taxRate: number | null; // percentage, e.g. 19 for 19%
  date: string | null; // ISO 8601
  category: string | null; // matches CATEGORY_OPTIONS (SKR03) from receipts-table.ts
  konto: string | null; // SKR03 account number (e.g. "4650")
  currency: string; // ISO 4217 code, e.g. "EUR", "USD", "GBP"; defaults to "EUR" when ambiguous
}

/** What the text reader adds to the fields: how it got them, for the checks that follow. */
export interface TextExtraction extends ExtractionResult {
  /** A tip printed on the receipt, on top of the bill. */
  tip: number | null;
  /** The tax groups the receipt prints, largest first. */
  taxGroups: TaxGroup[];
  /**
   * True when the tax rate is printed on the receipt. False when it is the
   * default for this kind of receipt (the check 'tax_estimated' says so), and
   * for a receipt in another currency that prints no tax: its rate is 0 and
   * nothing is estimated.
   */
  taxRatePrinted: boolean;
  /**
   * True when the text itself settles the currency: an ISO code, or one kind
   * of currency sign only. False for the euro assumed where it shows none, and
   * for a majority among mixed signs.
   */
  currencyShown: boolean;
  amountChecks: AmountCheck[];
  vendorConfidence: VendorConfidence;
  mealEvidence: MealEvidence;
}

// ── Currency Extraction ──────────────────────────────────────────────

const CURRENCY_CODE_PATTERN = /\b(USD|EUR|GBP)\b/;

// Explicit ISO codes win; otherwise pick the most frequent currency symbol in the
// document. Defaults to EUR when no signal is found, matching prior implicit behavior.
// `shown` says whether the text settles it (a code, or one kind of sign only):
// only then is the currency offered over what a stored receipt holds.
function extractCurrency(text: string): { currency: string; shown: boolean } {
  const codeMatch = text.match(CURRENCY_CODE_PATTERN);
  if (codeMatch) return { currency: codeMatch[1], shown: true };

  const dollarCount = (text.match(/\$/g) ?? []).length;
  const euroCount = (text.match(/€/g) ?? []).length;
  const poundCount = (text.match(/£/g) ?? []).length;
  const kinds = [dollarCount, euroCount, poundCount].filter((count) => count > 0).length;

  if (kinds === 0) return { currency: 'EUR', shown: false };
  if (dollarCount >= euroCount && dollarCount >= poundCount) return { currency: 'USD', shown: kinds === 1 };
  if (poundCount >= euroCount) return { currency: 'GBP', shown: kinds === 1 };
  return { currency: 'EUR', shown: kinds === 1 };
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
  currency: string,
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
    parts.push(`${gross.toFixed(2)} ${currency}`);
  }

  if (date) {
    const d = new Date(date);
    if (!isNaN(d.getTime())) {
      parts.push(d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' }));
    }
  }

  if (parts.length > 0) {
    return parts.join(', ');
  }

  // Nothing could be read: the caller names the row after its file.
  return '';
}

// ── Category Inference ───────────────────────────────────────────────

const VENDOR_CATEGORY_MAP: Record<string, string> = {
  // Bewirtung (4650)
  mcdonald: 'Bewirtung', 'burger king': 'Bewirtung', wendy: 'Bewirtung', subway: 'Bewirtung',
  starbucks: 'Bewirtung', dunkin: 'Bewirtung', chipotle: 'Bewirtung', domino: 'Bewirtung',
  'pizza hut': 'Bewirtung', 'taco bell': 'Bewirtung', chick: 'Bewirtung', panera: 'Bewirtung',
  nordsee: 'Bewirtung', vapiano: 'Bewirtung', 'dean & david': 'Bewirtung',
  backwerk: 'Bewirtung', 'back factory': 'Bewirtung',
  // Supermarkets and grocers are deliberately NOT here. Groceries are not a
  // business meal, and filing them under Bewirtung put them into the
  // business-meal register. They fall through to "Sonstige Ausgaben".
  'whole foods': 'Sonstige Ausgaben', trader: 'Sonstige Ausgaben', kroger: 'Sonstige Ausgaben',
  safeway: 'Sonstige Ausgaben', walmart: 'Sonstige Ausgaben', aldi: 'Sonstige Ausgaben',
  lidl: 'Sonstige Ausgaben', rewe: 'Sonstige Ausgaben', edeka: 'Sonstige Ausgaben',
  costco: 'Sonstige Ausgaben', penny: 'Sonstige Ausgaben', netto: 'Sonstige Ausgaben',
  kaufland: 'Sonstige Ausgaben',
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
  elevenlabs: 'Software & Lizenzen', resend: 'Software & Lizenzen',
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
  { pattern: /\b(?:restaurant|ristorante|trattoria|osteria|pizzeria|bistro|brasserie|gasthaus|gasthof|wirtshaus|biergarten|cafe|café|coffee|bakery|pizza|pasta|burger|sushi|grill|diner|meal|breakfast|lunch|dinner|gastronomie|bewirtung|catering|imbiss|bäckerei)\b/i, category: 'Bewirtung' },
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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function inferCategory(vendor: string | null, fullText: string, evidence: MealEvidence): string | null {
  // Pass 1: Known vendor lookup. Whole words only: "total" inside "Totally
  // Vegan" or "bp" inside any longer word must not decide the category.
  if (vendor) {
    const lower = vendor.toLowerCase();
    for (const [key, category] of Object.entries(VENDOR_CATEGORY_MAP)) {
      if (new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(key)}(?![\\p{L}\\p{N}])`, 'u').test(lower)) return category;
    }
  }

  // Pass 1b: a table, a waiter, a tip line, the printed hospitality form. A
  // receipt that carries them is a restaurant receipt whatever keyword
  // follows ("Server: ..." is the waiter, not a machine).
  if (evidence.strong) return MEAL_CATEGORY;

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

// The rate to assume when the receipt shows none: date-aware for meals
// (restaurant food is 19 percent until the end of 2025 and 7 percent from
// 2026), 7 percent for books, 19 percent otherwise. See src/lib/meals/classify.ts.
// These are German rates. A receipt in another currency never reaches the
// default: readAmounts gives it the tax its label names, or rate 0.

export function extractReceiptFields(ocrData: OcrResult): TextExtraction {
  const text = ocrData.fullText;
  const reading = readVendor(text);
  const vendor = reading.vendor;
  const date = readDate(text);
  const { currency, shown: currencyShown } = extractCurrency(text);
  const amounts = readAmounts(text, { date, currency });
  const evidence = mealEvidence(text);
  const category = inferCategory(vendor, text, evidence);
  const name = extractName(vendor, ocrData, amounts.gross, date, currency);
  const konto = category ? CATEGORY_TO_KONTO[category] ?? null : null;

  // The printed rate, or the default for this kind of receipt on this date.
  const taxRate = amounts.taxRate ?? defaultTaxRate(category, date, null);
  let net = amounts.net;
  if (net === null && amounts.gross !== null) {
    net = Math.round((amounts.gross / (1 + taxRate / 100)) * 100) / 100;
  }

  return {
    name,
    vendor,
    gross: amounts.gross,
    net,
    taxRate,
    date,
    category,
    konto,
    currency,
    tip: amounts.tip,
    taxGroups: amounts.taxGroups,
    taxRatePrinted: amounts.taxPrinted,
    currencyShown,
    amountChecks: amounts.checks,
    vendorConfidence: reading.confidence,
    mealEvidence: evidence,
  };
}
