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
/** A town line with the postcode at its end ("BERLIN, BERLIN, 13156"). */
const TOWN_POSTCODE = /^\p{L}[\p{L}\s.,-]*[\s,]\d{5}$/u;

function isAddressLine(line: string): boolean {
  return STREET.test(line) || POSTCODE_TOWN.test(line) || TOWN_POSTCODE.test(line);
}

const NEVER_A_NAME: RegExp[] = [
  /^(?:since|seit|est\.?|established|gegr(?:ü|ue)ndet)\s*\.?\s*\d{4}\b/i, // slogan
  /^[+\-*•·]/, // an extra or a bullet from the item list
  /^\d/, // a count, a price, a house number
  /^(?:laufkunde|kunde|customer|gast|duplikat|kopie|\d+\.\s*kopie|original|details|to|from|items?)$/i,
  /^(?:\*+\s*)?(?:rechnung|quittung|kassenbon|bon|beleg|bewirtungsbeleg|invoice|receipt|tax\s+invoice|kundenbeleg|h(?:ä|ae)ndlerbeleg)(?:\s*\*+)?$/i,
  /^(?:tel|telefon|fon|fax|mobil|e-?mail)\s*[.:]/i, // a contact line, not "Telekom"
  /^(?:(?:web(?:site)?|internet|url)\s*:|www\.|https?:)/i, // a web address, labelled or not
  /^(?:ust|st|steuer)[\s.-]*(?:id|nr|nummer)/i,
  /^(?:vat|tax|gst)[\s.-]*(?:id|no|nr|number|reg)/i,
  /\d[.,]\d{2}(?!\d)/, // a line with a price on it
  /^(?:total|summe|gesamt|netto|brutto|mwst|subtotal|date|datum)\b/i,
  /@/, // an e-mail address
  /^(?:thanks?|thank\s+you|many\s+thanks|vielen\s+dank|danke)\b/i, // a greeting set as a headline ("THANKS FOR / YOUR RIDE!")
  /^(?:germany|deutschland|austria|(?:ö|oe)sterreich|switzerland|schweiz|suisse|united\s+states|usa|united\s+kingdom|ireland|netherlands|niederlande|france|frankreich|luxembourg|luxemburg|czech\s+republic|poland|polen|spain|spanien|italy|italien|sweden|schweden|singapore|india|china)$/i, // a country line of an address
  /^your\s+(?:ride|trip|order|purchase|booking|receipt|invoice)\b/i,
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
  if (isAddressLine(line)) return false;
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

/** The start of a block that names the customer, not the issuer. */
const BILL_TO_MARK = /^(?:rechnung\s+an|rechnungsempf(?:ä|ae)nger|rechnungsadresse|invoice\s+to|bill(?:ed)?[\s-]+to|billing\s+address|sold\s+to|ship(?:ped)?\s+to|lieferung\s+an|lieferadresse|kunde|customer)\b/i;
const BILL_TO_LINES = 4;

/** Web and mail addresses on the receipt that do not sit in a bill-to block: only those can name the issuer. */
function issuerAddresses(lines: string[]): string[] {
  const addresses: string[] = [];
  let skip = 0;
  for (const line of lines) {
    if (BILL_TO_MARK.test(line)) skip = BILL_TO_LINES + 1;
    else if (skip > 0 && (line === '' || BODY_START.test(line))) skip = 0;
    if (skip > 0) {
      skip--;
      continue;
    }
    addresses.push(...(line.match(/(?:www\.|https?:\/\/|@)[\w.-]+/gi) ?? []));
  }
  return addresses;
}

/** Second-level labels that belong to the country suffix ("co" in acme.co.uk). */
const COMPOUND_SUFFIX_LABELS = new Set(['co', 'com', 'org', 'net', 'gov', 'edu', 'ac', 'ltd', 'plc']);

/** The label that names the owner of an address: "miles-mobility" in hello@miles-mobility.com, "acme" in acme.co.uk. */
function registrableLabel(address: string): string {
  const labels = address.replace(/^(?:www\.|https?:\/\/|@)/i, '').split('.').filter(Boolean);
  if (labels.length > 2 && labels[labels.length - 1].length === 2 && COMPOUND_SUFFIX_LABELS.has(labels[labels.length - 2].toLowerCase())) {
    return normalized(labels[labels.length - 3]);
  }
  return normalized(labels.length > 1 ? labels[labels.length - 2] : (labels[0] ?? ''));
}

/** True when an issuer's web or mail address carries the name ("MILES Mobility GmbH" and miles-mobility.com). */
function backedByAddress(name: string, addresses: string[]): boolean {
  const key = vendorKey(name);
  if (key.length < 4) return false;
  return addresses.some((a) => {
    const domain = registrableLabel(a);
    // A short domain must match the name exactly; only a longer one may match as part of it.
    return domain === key || (domain.length >= 5 && (domain.includes(key) || key.includes(domain)));
  });
}

/**
 * A company line anywhere on the receipt, with its legal form, that the
 * receipt's own web or mail address confirms. Some invoices open with a
 * greeting and the customer's address, and print the issuer only below the
 * heading ("THANKS FOR / YOUR RIDE!", then the customer, then "Invoice", then
 * "MILES Mobility GmbH" and miles-mobility.com). The address is required so a
 * company in the bill-to block does not pass for the issuer.
 */
function issuerOutsideHead(lines: string[], addresses: string[]): string | null {
  for (const line of lines) {
    if (!LEGAL_FORM.test(line)) continue;
    const name = companyName(line);
    if (canBeName(name) && backedByAddress(name, addresses)) return name;
  }
  return null;
}

/**
 * The company out of a line that carries more than its name: a copyright
 * notice ("Copyright © 2024 Apple Distribution International Ltd.") or a
 * sentence that ends in it ("Leistungen der Telekom Deutschland GmbH",
 * "Umsatzsteuer erklärt durch Amazon Services Europe S.a.r.L.").
 */
function companyName(line: string): string {
  let name = line.replace(/^(?:copyright\s*)?(?:©|\(c\))?\s*(?:\d{4}(?:\s*[-–]\s*\d{4})?\s*)?(?=\p{L})/iu, '');
  const lead = /^.*\s(?:der|des|durch|bei|via|by|through)\s+(?=\p{Lu})/u.exec(name);
  if (lead) name = name.slice(lead[0].length);
  // A former or second name after the company ("Link, LLC f/k/a Lemon Squeezy") is not part of it.
  name = name.replace(/\s+(?:f\/k\/a|formerly|vormals)\s.*$/i, '');
  return clean(name);
}

/** True when an address line follows the given line, allowing one filler line between ("n/a"). */
function addressFollows(head: string[], index: number): boolean {
  return head.slice(index + 1, index + 3).some(isAddressLine);
}

/** A vendor name without its legal form, in lower case, letters and digits only. */
function vendorKey(name: string): string {
  return name
    .replace(new RegExp(LEGAL_FORM.source, 'gi'), ' ')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

/**
 * True when two names are the same vendor written differently: with or
 * without the legal form ("A2 Hosting" and "A2 Hosting LLC"), in another case
 * or with other punctuation. A reading that only differs this way is no reason
 * to rename a vendor that is already stored: the rows of one vendor would fall
 * into two groups.
 */
export function sameVendor(a: string, b: string): boolean {
  const keyA = vendorKey(a);
  return keyA !== '' && keyA === vendorKey(b);
}

/** Read the business name from the recognized text. Never invents one. */
export function readVendor(fullText: string): VendorReading {
  const all = fullText.split('\n').map(clean);
  const end = all.findIndex((l, i) => i > 0 && BODY_START.test(l));
  const head = all.slice(0, Math.min(end === -1 ? HEAD_LINES : end, HEAD_LINES)).filter((l) => l.length > 0);

  const addresses = issuerAddresses(all);
  // A company in the head that is followed by an address and that no issuer address names is the customer's block,
  // when the receipt confirms another company further down.
  const customerBlock = (name: string, index: number) => {
    if (!addressFollows(head, index) || backedByAddress(name, addresses)) return null;
    const issuer = issuerOutsideHead(all, addresses);
    return issuer && !sameVendor(issuer, name) ? issuer : null;
  };

  // 1. A line that names the legal form or the owner is the business itself.
  for (let i = 0; i < head.length; i++) {
    const line = head[i];
    const owner = OWNER_MARK.exec(line);
    if (owner && owner.index > 2) {
      const name = clean(line.slice(0, owner.index));
      if (canBeName(name)) return { vendor: name, confidence: 'confirmed' };
    }
    if (LEGAL_FORM.test(line) && canBeName(line)) {
      const issuer = customerBlock(line, i);
      if (issuer) return { vendor: issuer, confidence: 'confirmed' };
      // Prefer the trading name printed above a company line when there is one ("the breakfast story" above "... UG").
      // Only within the company's own block: above an address line sits someone else's block, often the customer's
      // name under a greeting ("THANKS FOR / YOUR RIDE! / <customer> / <street> / <town>").
      let from = i;
      while (from > 0 && !isAddressLine(head[from - 1])) from--;
      const trading = head.slice(from, i).find((l) => canBeName(l) && !/^\d/.test(l));
      if (trading) return { vendor: trading, confidence: 'confirmed' };
      return { vendor: line, confidence: 'confirmed' };
    }
  }

  // 2. The first line that can be a name; a name broken across several short lines is joined.
  const start = head.findIndex(canBeName);
  if (start === -1) {
    const issuer = issuerOutsideHead(all, addresses);
    return issuer ? { vendor: issuer, confidence: 'confirmed' } : { vendor: null, confidence: 'none' };
  }
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
  // A confirmed issuer below the heading wins over a head line nothing backs, and over one that is the customer:
  // a name followed by an address and printed twice (on the address block and in the greeting) counts as backed,
  // but no web or mail address on the receipt names it.
  const issuer = issuerOutsideHead(all, addresses);
  if (issuer && (!confirmed || (addressFollows(head, start + parts.length - 1) && !backedByAddress(name, addresses)))) {
    return { vendor: issuer, confidence: 'confirmed' };
  }
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
  // An issuer the receipt's own address names is not replaced by a name from the receipt text, which may be the customer's.
  if (reading.vendor && reading.confidence === 'confirmed' && backedByAddress(reading.vendor, issuerAddresses(fullText.split('\n').map(clean)))) {
    return reading;
  }
  const text = normalized(fullText);
  const tokens = model.split(/\s+/).map(normalized).filter((t) => t.length >= 3);
  const inText = tokens.length > 0 && tokens.filter((t) => text.includes(t)).length >= Math.ceil(tokens.length / 2);
  if (inText) return { vendor: model, confidence: 'confirmed' };
  if (reading.confidence === 'none') return { vendor: model, confidence: 'likely' };
  return reading;
}
