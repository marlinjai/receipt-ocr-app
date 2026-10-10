/**
 * Reading the name of the business from the head of a receipt.
 *
 * The first printed line is often not the name: a logo comes out as a slogan
 * ("Since 2016") or as fragments, a cropped scan starts in the middle of the
 * item list ("+ mit Haferdrink"), and a name set in three short lines
 * ("Indisches / Restaurant / Chandni") was stored as its first word. This
 * reader skips what cannot be a name, joins a name broken across lines, and
 * says how sure it is, so a guess is shown for checking instead of passing as
 * fact.
 */

export type VendorConfidence =
  /** A name with a legal form, or one the receipt repeats or its web address confirms. */
  | 'confirmed'
  /** A plausible head line, nothing on the receipt to back it. */
  | 'likely'
  /** Nothing in the head looks like a business name. */
  | 'none';

export interface VendorReading {
  vendor: string | null;
  confidence: VendorConfidence;
}

const HEAD_LINES = 12;

/** Where the head of a receipt ends: the first line that belongs to the purchase itself. */
const BODY_START =
  /^(?:\*?\s*(?:rechnung|quittung|beleg|bon|invoice|receipt|order|bestellung)\b|tisch\b|table\b|\d+\s*x\b|\d{1,2}[.:]\d{2}[.:]\d{2}|\d{1,2}\.\d{1,2}\.\d{2,4})/i;

const LEGAL_FORM = /\b(?:gmbh(?:\s*&\s*co\.?\s*kg)?|ug(?:\s*\(haftungsbeschr(?:ä|ae)nkt\))?|ag|kg|ohg|gbr|e\.\s?k\.|e\.\s?v\.|ltd\.?|limited|inc\.?|llc|uc|s\.?a\.?r\.?l\.?|b\.?v\.?)(?=$|[\s,.])/i;
const OWNER_MARK = /\b(?:inh(?:aber(?:in)?)?\.?|gesch(?:ä|ae)ftsf(?:ü|ue)hrer(?:in)?)(?=$|[\s:.,])/i;

const STREET = /(?:stra(?:ß|ss)e|str\.?|allee|platz|weg|gasse|ufer|damm|chaussee|ring|markt|street|road|avenue|square)\b.*\d|\b\d{1,4}[a-z]?\s*,?\s*\d{5}\b/i;
const POSTCODE_TOWN = /\b\d{5}\s+\p{L}/u;

const NEVER_A_NAME: RegExp[] = [
  /^(?:since|seit|est\.?|established|gegr(?:ü|ue)ndet)\s*\.?\s*\d{4}\b/i, // slogan
  /^[+\-*•·]/, // an extra or a bullet from the item list
  /^\d/, // a count, a price, a house number
  /^(?:laufkunde|kunde|customer|gast|duplikat|kopie|\d+\.\s*kopie|original|details|to|from|items?)$/i,
  /^(?:\*+\s*)?(?:rechnung|quittung|kassenbon|bon|beleg|bewirtungsbeleg|invoice|receipt|tax\s+invoice|kundenbeleg|h(?:ä|ae)ndlerbeleg)(?:\s*\*+)?$/i,
  /^(?:tel|telefon|fon|fax|mobil|e-?mail)\s*[.:]/i, // a contact line, not "Telekom"
  /^(?:www\.|https?:)/i,
  /^(?:ust|st|steuer)[\s.-]*(?:id|nr|nummer)/i,
  /\d[.,]\d{2}(?!\d)/, // a line with a price on it
  /^(?:total|summe|gesamt|netto|brutto|mwst|subtotal|date|datum)\b/i,
  /@/, // an e-mail address
  /^[\p{P}\p{S}\s\d]+$/u, // no letters at all
];

function clean(line: string): string {
  return line.replace(/\s+/g, ' ').replace(/^[\s*|]+|[\s*|]+$/g, '').trim();
}

function words(line: string): string[] {
  return line.split(/\s+/).filter(Boolean);
}

/** A short token with letters and digits mixed is a misread logo ("Xx40"), not a name. */
function looksGarbled(line: string): boolean {
  const w = words(line);
  if (w.length !== 1) return false;
  return /\d/.test(w[0]) && /\p{L}/u.test(w[0]) && w[0].length <= 6;
}

function canBeName(line: string): boolean {
  if (line.length < 3 || line.length > 60) return false;
  if (looksGarbled(line)) return false;
  if (STREET.test(line) || POSTCODE_TOWN.test(line)) return false;
  return !NEVER_A_NAME.some((p) => p.test(line));
}

const normalized = (s: string) => s.toLocaleLowerCase('de-DE').replace(/[^\p{L}\p{N}]+/gu, '');

/** True when the receipt prints the name a second time or carries it in a web or mail address. */
function backedByText(name: string, lines: string[], ownIndex: number, fullText: string): boolean {
  const key = normalized(name);
  if (key.length < 4) return false;
  if (lines.some((l, i) => i !== ownIndex && normalized(l).includes(key))) return true;
  const addresses = fullText.match(/(?:www\.|https?:\/\/|@)[\w.-]+/gi) ?? [];
  return addresses.some((a) => normalized(a).includes(key) || key.includes(normalized(a.replace(/^(?:www\.|https?:\/\/|@)/i, '').split('.')[0])));
}

/** Read the business name from the recognized text. Never invents one. */
export function readVendor(fullText: string): VendorReading {
  const all = fullText.split('\n').map(clean);
  const end = all.findIndex((l, i) => i > 0 && BODY_START.test(l));
  const head = all.slice(0, Math.min(end === -1 ? HEAD_LINES : end, HEAD_LINES)).filter((l) => l.length > 0);

  // 1. A line that names the legal form or the owner is the business itself.
  for (let i = 0; i < head.length; i++) {
    const line = head[i];
    const owner = OWNER_MARK.exec(line);
    if (owner && owner.index > 2) {
      const name = clean(line.slice(0, owner.index));
      if (canBeName(name)) return { vendor: name, confidence: 'confirmed' };
    }
    if (LEGAL_FORM.test(line) && canBeName(line)) {
      // Prefer the trading name printed above a company line when there is one ("the breakfast story" above "... UG").
      const above = head.slice(0, i).filter(canBeName);
      const trading = above.find((l) => !/^\d/.test(l));
      return { vendor: trading ?? line, confidence: 'confirmed' };
    }
  }

  // 2. The first line that can be a name; a name broken across several short lines is joined.
  const start = head.findIndex(canBeName);
  if (start === -1) return { vendor: null, confidence: 'none' };
  const parts = [head[start]];
  if (words(head[start]).length === 1) {
    for (let i = start + 1; i < head.length && parts.length < 3; i++) {
      const next = head[i];
      if (!canBeName(next) || words(next).length !== 1) break;
      // The same name set a second time in capitals ends the first setting.
      if (parts.some((p) => normalized(p) === normalized(next))) break;
      parts.push(next);
    }
  }
  const name = parts.join(' ');
  const index = all.indexOf(head[start]);
  const confirmed = parts.length > 1 || backedByText(name, all, index, fullText);
  return { vendor: name, confidence: confirmed ? 'confirmed' : 'likely' };
}

/**
 * Decide between the text reading and a language model's reading.
 *
 * The model reads context a pattern cannot (a name inside a slogan, a logo
 * split into fragments), but it can also bring a name from elsewhere. Its
 * answer is taken when the receipt text contains it, or when the text reading
 * found nothing better than a guess.
 */
export function chooseVendor(reading: VendorReading, modelVendor: string | null | undefined, fullText: string): VendorReading {
  const model = modelVendor ? clean(modelVendor) : '';
  if (!model || !canBeName(model)) return reading;
  const text = normalized(fullText);
  const tokens = model.split(/\s+/).map(normalized).filter((t) => t.length >= 3);
  const inText = tokens.length > 0 && tokens.filter((t) => text.includes(t)).length >= Math.ceil(tokens.length / 2);
  if (inText) return { vendor: model, confidence: 'confirmed' };
  if (reading.confidence === 'none') return { vendor: model, confidence: 'likely' };
  return reading;
}
