/**
 * The place of a meal (business name and postal address) read from a
 * receipt's recognized text, without a model: a German street line and a
 * postal code with town are looked for near the top of the receipt, where a
 * till receipt prints them.
 *
 * It answers only when BOTH a street with a house number and a postal code
 * with a town were found. Anything less returns null: half an address is not
 * offered, and nothing is ever invented.
 */

const HEADER_LINES = 30;

const STREET_WORD = String.raw`(?:stra(?:ß|ss)e|str\.?|weg|platz|allee|damm|ufer|gasse|ring|chaussee|markt|steig|promenade|hof|graben|wall|brücke|bruecke|berg|zeile|pfad|kai)`;
/** "Musterstraße 12", "Am Testplatz 3a", "Beispielweg 4-6". */
const STREET_LINE = new RegExp(
  String.raw`((?:[A-Za-zÄÖÜäöüß][A-Za-zÄÖÜäöüß.\-' ]{0,40}?)?${STREET_WORD}\.?\s*\d{1,4}(?:\s?[a-zA-Z])?(?:\s?[-/]\s?\d{1,4})?)(?![\d,.:])`,
  'i',
);
/** A street introduced by a preposition and without a street word: "Am Beispielufer 2", "Unter den Musterlinden 5". */
const PREPOSITION_STREET = /^((?:Am|An der|An den|Auf dem|Auf der|Im|In der|In den|Unter den|Zum|Zur)\s+[A-Za-zÄÖÜäöüß.\- ]{2,40}\s\d{1,4}(?:\s?[a-zA-Z])?)$/;
/** "12345 Musterstadt", "D-12345 Beispiel am Main". The town is letters only, so receipt numbers and times do not match. */
const POSTAL_LINE = /(?:^|[\s,;|])(?:D[- ]?)?(\d{5})\s+([A-ZÄÖÜ][A-Za-zÄÖÜäöüß.\-]+(?:[ -](?:am|an der|im|in|bei|ob der|vor der|a\.|i\.|b\.)?\s?[A-ZÄÖÜ]?[A-Za-zÄÖÜäöüß.\-]+){0,3})\s*$/;

function tidy(text: string): string {
  return text.replace(/\s+/g, ' ').replace(/\s+([,.])/g, '$1').trim();
}

export interface ReceiptPlace {
  name: string | null;
  street: string;
  postalCode: string;
  town: string;
}

/** The parts of the place, or null when no complete address was found. */
export function parsePlaceFromReceiptText(fullText: string, vendor: string | null): ReceiptPlace | null {
  const lines = fullText
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, HEADER_LINES);

  for (let i = 0; i < lines.length; i++) {
    const postal = POSTAL_LINE.exec(lines[i]);
    if (!postal) continue;
    // The street is on the same line before the postal code, or on the line above.
    const before = lines[i].slice(0, postal.index).replace(/[,;|]\s*$/, '').trim();
    const candidates = [before, i > 0 ? lines[i - 1] : ''];
    for (const candidate of candidates) {
      if (!candidate) continue;
      const street = STREET_LINE.exec(candidate)?.[1] ?? PREPOSITION_STREET.exec(candidate)?.[1];
      if (!street) continue;
      const streetLineIndex = candidate === before ? i : i - 1;
      const above = streetLineIndex > 0 ? lines[streetLineIndex - 1] : null;
      // The printed name: the given vendor, else the line above the street when it reads like a name.
      const name = vendor?.trim() || (above && /[A-Za-zÄÖÜäöüß]{3,}/.test(above) && !/\d{3,}/.test(above) ? above : null);
      return { name: name ? tidy(name) : null, street: tidy(street), postalCode: postal[1], town: tidy(postal[2]) };
    }
  }
  return null;
}

/** Name and address as the one line the place field holds, or null without a complete address. */
export function placeFromReceiptText(fullText: string | null | undefined, vendor: string | null): string | null {
  if (!fullText || !fullText.trim()) return null;
  const place = parsePlaceFromReceiptText(fullText, vendor);
  if (!place) return null;
  const address = `${place.street}, ${place.postalCode} ${place.town}`;
  return (place.name ? `${place.name}, ${address}` : address).slice(0, 300);
}
