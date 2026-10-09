/**
 * Reading total, net and tax from the recognized text of a receipt.
 *
 * Text recognition returns the lines of a till receipt in an order that does
 * not keep a label next to its value: "Total / Trinkgeld / Gesamt" can stand
 * in one block and the three amounts in another. Taking "the amount on the
 * line that says Total" therefore picked receipt numbers, tips and net
 * amounts as the total, and the tax rate computed from such a pair came out
 * as 526 or 844 percent.
 *
 * What a receipt does keep is its arithmetic. A German receipt prints, per
 * tax rate, a net amount and a tax amount that belong together: the tax is
 * the rate times the net, and the two add up to a gross amount that is
 * printed as well. This module looks for those groups first and only falls
 * back to labels when the receipt prints none. Whatever it cannot confirm
 * is reported as a check for a person, never silently stored as fact.
 */

export interface TaxGroup {
  /** Percent, one of the rates valid on the receipt date. */
  rate: number;
  net: number;
  tax: number;
  gross: number;
}

export type AmountCheck =
  /** No total could be read at all. */
  | 'total_missing'
  /** A total was taken from a label or by size, with no arithmetic on the receipt to confirm it. */
  | 'total_unconfirmed'
  /** Two readings of the total disagree (the receipt text and the model, or the label and the tax lines). */
  | 'total_conflict'
  /** No tax line was found; the rate is the default for this kind of receipt. */
  | 'tax_estimated';

export interface AmountReading {
  /** The amount of the bill, without a tip. */
  gross: number | null;
  net: number | null;
  /** The rate that carries the largest part of the bill, percent. Null when it is not printed and must be defaulted. */
  taxRate: number | null;
  /** The tax groups the receipt prints, largest first. Empty when it prints none. */
  taxGroups: TaxGroup[];
  /** A tip printed on the receipt, on top of the bill. */
  tip: number | null;
  checks: AmountCheck[];
}

const cents = (value: number) => Math.round(value * 100);
const euros = (value: number) => Math.round(value) / 100;

/** A receipt total above this is not believed without arithmetic to back it. */
const SANE_TOTAL_CENTS = 2_000_000;

/**
 * An amount with exactly two decimals. It may not be glued to a letter or a
 * longer number on either side: "A916752.8837" is a receipt number,
 * "02.05.2025" a date, "19,00%" a rate and "0,75L" a volume.
 */
const AMOUNT = /(?<![\p{L}\p{N}.,:/#-])(\d{1,3}(?:[.,]\d{3})+[.,]\d{2}|\d{1,6}[.,]\d{2})(?![\p{L}\p{N}%]|[.,:/-]\d)/gu;

/** The same pattern without the global flag, for a yes or no on one line. */
const AMOUNT_TEST = new RegExp(AMOUNT.source, 'u');

function toCents(raw: string): number | null {
  const lastSeparator = Math.max(raw.lastIndexOf(','), raw.lastIndexOf('.'));
  const whole = raw.slice(0, lastSeparator).replace(/[.,]/g, '');
  const fraction = raw.slice(lastSeparator + 1);
  const value = Number(whole) * 100 + Number(fraction);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

/** Lines that carry identifiers, not money, even where a number in them has two decimals. */
const IDENTIFIER_LINE =
  /\b(?:rechnung(?:s?nr|snummer)?|beleg-?nr|bon-?nr|quittung|duplikat|seq\.?-?nr|transaktion|signatur|zertifikat|seriennummer|serial|terminal|tse|st\.?-?nr|steuer-?nr|steuernummer|ust\.?-?id|iban|bic|tel(?:efon)?|fax|kassen?-?id|order\s?id|invoice\s?#)\b/i;

/** Every money amount in the text, in cents, with the line it stands on. */
export function amountsInText(text: string): Array<{ cents: number; line: number }> {
  const out: Array<{ cents: number; line: number }> = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (IDENTIFIER_LINE.test(line) && !/(?:summe|total|gesamt|betrag|brutto|netto)/i.test(line)) continue;
    for (const match of line.matchAll(AMOUNT)) {
      const value = toCents(match[1]);
      if (value !== null) out.push({ cents: value, line: i });
    }
  }
  return out;
}

/** The value-added tax rates in force in Germany on a day (the reduced rates of the second half of 2020 included). */
export function ratesOn(isoDay: string | null): number[] {
  if (isoDay && isoDay >= '2020-07-01' && isoDay <= '2020-12-31') return [16, 5, 19, 7];
  return [19, 7];
}

/** True when `tax` is `rate` percent of `net`, to the cent or within the rounding of a few lines added up. */
function isTaxOf(netCents: number, taxCents: number, rate: number): boolean {
  const expected = (netCents * rate) / 100;
  return Math.abs(taxCents - expected) <= Math.max(2, netCents * 0.0015);
}

const TIP_WORD = /trinkgeld|\btip\b|gratuity|service\s*charge/i;
const TAX_WORD = /mwst|ust|vat|steuer|\btax\b/i;
const TOTAL_LABEL = /(?:^|[^\p{L}])(?:summe|gesamt(?:betrag|summe)?|total|endbetrag|rechnungsbetrag|zu\s+zahlen|betrag|brutto|order\s+total|amount\s+due|balance\s+due|grand\s+total)(?![\p{L}])/iu;
const NOT_A_TOTAL = /zwischensumme|sub\s*-?\s*total|item\s*\(?s?\)?\s*total|netto|steuer|mwst|ust\b|vat|gegeben|zur(?:ü|u)ck|r(?:ü|u)ckgeld|trinkgeld|\btip\b|rabatt|discount|shipping|versand/i;

/**
 * Net and tax amounts that belong together at one rate.
 *
 * Two amounts in the right proportion can meet by chance on a long receipt,
 * so a pair needs the printed total to vouch for it: either its own sum is
 * printed (alone, or with a printed tip on top), or the sum of ALL pairs
 * found is (a receipt that lists two groups at one rate and only their
 * common total).
 */
function taxGroupsIn(values: Set<number>, rates: number[], tips: { labelled: number[]; candidates: number[] }): TaxGroup[] {
  const printed = (sum: number) => values.has(sum) || tips.candidates.some((tip) => tip < sum && values.has(sum + tip));
  const sorted = [...values].sort((x, y) => y - x);
  const pairs: Array<{ rate: number; net: number; tax: number; confirmed: boolean }> = [];
  const used = new Set<number>();
  // Pairs the printed total vouches for are settled first, so that a chance
  // match (an item price that happens to be 7 percent of another) cannot take
  // an amount a real tax line needs. An amount the receipt labels as the tip
  // is never a tax amount, however well it fits a rate.
  for (const wantConfirmed of [true, false]) {
    for (const net of sorted) {
      if (used.has(net)) continue;
      let hit: { rate: number; tax: number } | null = null;
      for (const rate of rates) {
        const tax = sorted.find(
          (t) => t < net && !used.has(t) && !tips.labelled.includes(t) && isTaxOf(net, t, rate) && printed(net + t) === wantConfirmed,
        );
        if (tax !== undefined) {
          hit = { rate, tax };
          break;
        }
      }
      if (!hit) continue;
      pairs.push({ rate: hit.rate, net, tax: hit.tax, confirmed: wantConfirmed });
      used.add(net);
      used.add(hit.tax);
      // The gross of one group must not be read as the net of another.
      used.add(net + hit.tax);
    }
  }
  const total = (list: typeof pairs) => list.reduce((sum, p) => sum + p.net + p.tax, 0);
  const confirmed = pairs.filter((p) => p.confirmed);
  let chosen: typeof pairs = [];
  if (pairs.length > 0 && printed(total(pairs))) chosen = pairs;
  else if (confirmed.length > 0) chosen = printed(total(confirmed)) ? confirmed : [confirmed[0]];
  return chosen.map((p) => ({ rate: p.rate, net: euros(p.net), tax: euros(p.tax), gross: euros(p.net + p.tax) }));
}

/** A total printed together with the tax it contains: the net is not printed, the pair still proves the rate. */
function grossWithTax(values: Set<number>, rates: number[], candidates: number[]): TaxGroup | null {
  for (const gross of candidates) {
    for (const rate of rates) {
      for (const tax of values) {
        if (tax >= gross) continue;
        if (isTaxOf(gross - tax, tax, rate)) {
          return { rate, net: euros(gross - tax), tax: euros(tax), gross: euros(gross) };
        }
      }
    }
  }
  return null;
}

/** Amounts a label calls the total: on the label's own line, or on the next line when the label stands alone. */
function labelledTotals(text: string): number[] {
  const lines = text.split('\n');
  const out: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!TOTAL_LABEL.test(line) || NOT_A_TOTAL.test(line)) continue;
    const own = [...line.matchAll(AMOUNT)].map((m) => toCents(m[1])).filter((v): v is number => v !== null);
    if (own.length > 0) {
      out.push(own[own.length - 1]);
      continue;
    }
    const next = lines[i + 1] ?? '';
    if (NOT_A_TOTAL.test(next) || TOTAL_LABEL.test(next)) continue;
    const following = [...next.matchAll(AMOUNT)].map((m) => toCents(m[1])).filter((v): v is number => v !== null);
    if (following.length > 0) out.push(following[following.length - 1]);
  }
  return out;
}

const NET_LABEL = /(?:^|[^\p{L}])(?:sub\s*-?\s*total|zwischensumme|netto(?:betrag|umsatz)?|net(?:\s+amount)?|before\s+tax)(?![\p{L}])/iu;
const TAX_LABEL = /(?:^|[^\p{L}])(?:(?:sales\s+)?tax|vat|mwst\.?|ust\.?|mehrwertsteuer|umsatzsteuer|tva|iva|gst|hst)(?![\p{L}])/iu;

/** The amount a label on the same line names. Zero counts here: "Tax (0%): 0.00" is a statement. */
function statedAmount(text: string, label: RegExp, exclude?: RegExp): number | null {
  for (const line of text.split('\n')) {
    if (!label.test(line) || (exclude && exclude.test(line))) continue;
    const match = /(\d{1,3}(?:[.,]\d{3})+[.,]\d{2}|\d{1,6}[.,]\d{2})(?![\p{L}\p{N}%]|[.,:/-]\d)\s*(?:€|eur|usd|gbp|\$|£)?\s*$/iu.exec(line.trim());
    if (!match) continue;
    const raw = match[1];
    const lastSeparator = Math.max(raw.lastIndexOf(','), raw.lastIndexOf('.'));
    return Number(raw.slice(0, lastSeparator).replace(/[.,]/g, '')) * 100 + Number(raw.slice(lastSeparator + 1));
  }
  return null;
}

/**
 * Net and tax as the receipt states them next to their labels, when they add
 * up to the total. Any rate a real receipt can carry is accepted here, because
 * the three stated figures confirm each other.
 */
function statedNetAndTax(text: string, grossCents: number): { net: number; tax: number; rate: number } | null {
  const tax = statedAmount(text, TAX_LABEL, /sub\s*-?\s*total|zwischensumme|netto/i);
  const net = statedAmount(text, NET_LABEL);
  let n: number | null = null;
  let t: number | null = null;
  if (net !== null && tax !== null && Math.abs(net + tax - grossCents) <= 1) [n, t] = [net, tax];
  else if (tax !== null && net === null && tax < grossCents) [n, t] = [grossCents - tax, tax];
  else if (net !== null && tax === null && net <= grossCents) [n, t] = [net, grossCents - net];
  if (n === null || t === null || n <= 0) return null;
  const rate = Math.round((t / n) * 10000) / 100;
  // No receipt carries a rate above the highest standard rate in the European Union.
  if (rate < 0 || rate > 27.5) return null;
  // To a whole or half percent where the figures allow it (7.0, 8.25 stays 8.25).
  const rounded = Math.abs(rate - Math.round(rate)) < 0.06 ? Math.round(rate) : rate;
  return { net: n, tax: t, rate: rounded };
}

export interface AmountHints {
  /** ISO day of the receipt, to know which tax rates were in force. */
  date?: string | null;
  /** ISO 4217 code. The tax arithmetic is German; another currency is read by label only. */
  currency?: string;
  /** The total as a language model read it: a second opinion, never taken on its own word against the arithmetic. */
  modelGross?: number | null;
  /** Tax lines a language model read as printed. */
  modelTaxLines?: Array<{ rate: number; net: number; tax: number }> | null;
}

/**
 * Read the amounts of a receipt. Order of trust: the receipt's own tax
 * arithmetic, then a labelled total that a second reading agrees with, then a
 * labelled total alone (reported as unconfirmed), then nothing.
 */
export function readAmounts(text: string, hints: AmountHints = {}): AmountReading {
  const found = amountsInText(text);
  const values = new Set(found.map((a) => a.cents));
  const checks: AmountCheck[] = [];
  const german = !hints.currency || hints.currency === 'EUR';
  const rates = ratesOn(hints.date ? hints.date.slice(0, 10) : null);
  const model = hints.modelGross !== null && hints.modelGross !== undefined ? cents(hints.modelGross) : null;
  const labelled = labelledTotals(text).filter((v) => v <= SANE_TOTAL_CENTS);

  // A tip is an amount on a line that names it; with columns torn apart it is
  // any amount that, added to a printed sum, gives another printed sum.
  const lines = text.split('\n');
  const tipLine = (l: string) => TIP_WORD.test(l) && !/nicht\s+enthalten|not\s+included|\bis\s+not\b/i.test(l);
  const hasTipWord = lines.some(tipLine);
  // On the tip line itself, or on the line after it when the label stands alone
  // and is not part of a block of labels whose values follow in another order.
  const bareLabel = (l: string | undefined) => l !== undefined && !AMOUNT_TEST.test(l) && (TOTAL_LABEL.test(l) || NOT_A_TOTAL.test(l));
  const tipOnLine = found
    .filter(
      (a) =>
        tipLine(lines[a.line]) ||
        (a.line > 0 && tipLine(lines[a.line - 1]) && !AMOUNT_TEST.test(lines[a.line - 1]) && !bareLabel(lines[a.line - 2])),
    )
    .map((a) => a.cents);
  // Cash handed over minus the bill is the change, not a tip: with change on the
  // receipt only an amount the receipt itself labels as the tip is taken.
  const hasChange = /zur(?:ü|u)ck|r(?:ü|u)ckgeld|wechselgeld|\bchange\b/i.test(text);
  const tipCandidates = !hasTipWord ? [] : hasChange ? tipOnLine : [...new Set([...tipOnLine, ...values])];

  let groups: TaxGroup[] = [];
  if (german) {
    const modelGroups = (hints.modelTaxLines ?? [])
      .map((l) => ({ rate: l.rate, net: cents(l.net), tax: cents(l.tax) }))
      .filter((l) => rates.includes(l.rate) && l.net > 0 && l.tax > 0 && isTaxOf(l.net, l.tax, l.rate))
      .map((l) => ({ rate: l.rate, net: euros(l.net), tax: euros(l.tax), gross: euros(l.net + l.tax) }));
    groups = taxGroupsIn(values, rates, { labelled: tipOnLine, candidates: tipCandidates });
    if (groups.length === 0 && modelGroups.length > 0) groups = modelGroups;
  }

  let gross: number | null = null;
  let tip: number | null = null;
  let stated: { net: number; tax: number; rate: number } | null = null;

  if (groups.length > 0) {
    groups.sort((a, b) => b.gross - a.gross);
    const bill = groups.reduce((sum, g) => sum + cents(g.gross), 0);
    gross = euros(bill);
    const isTip = (t: number) => t < bill && values.has(bill + t);
    const tipCents = tipOnLine.find(isTip) ?? tipCandidates.find(isTip);
    if (tipCents !== undefined) tip = euros(tipCents);
    if (model !== null && model !== bill && !(tipCents !== undefined && model === bill + tipCents)) checks.push('total_conflict');
  } else {
    // Largest first: the total is the largest amount a printed tax amount fits.
    const withTax =
      german && TAX_WORD.test(text)
        ? grossWithTax(values, rates, [...values].filter((v) => v <= SANE_TOTAL_CENTS && !tipOnLine.includes(v)).sort((x, y) => y - x))
        : null;
    if (withTax) {
      groups = [withTax];
      gross = withTax.gross;
    } else if (labelled.length > 0 && model !== null && labelled.includes(model)) {
      gross = euros(model);
      stated = statedNetAndTax(text, model);
    } else if (labelled.length > 0 && statedNetAndTax(text, labelled[labelled.length - 1])) {
      // A receipt that states net, tax and total and whose three figures add up
      // has confirmed its own total, at whatever rate its country uses.
      gross = euros(labelled[labelled.length - 1]);
      stated = statedNetAndTax(text, labelled[labelled.length - 1]);
    } else if (labelled.length > 0) {
      // The last labelled total is the one after discounts and shipping.
      const pick = labelled[labelled.length - 1];
      gross = euros(pick);
      checks.push(model !== null && model !== pick ? 'total_conflict' : 'total_unconfirmed');
    } else if (model !== null && values.has(model) && model <= SANE_TOTAL_CENTS) {
      gross = euros(model);
      checks.push('total_unconfirmed');
    } else {
      checks.push('total_missing');
    }
    if (gross !== null && hasTipWord) {
      const bill = cents(gross);
      const tipCents = tipOnLine.find((t) => t < bill && values.has(bill + t));
      if (tipCents !== undefined) tip = euros(tipCents);
    }
  }

  if (groups.length === 0 && stated && gross !== null) {
    return { gross, net: euros(stated.net), taxRate: stated.rate, taxGroups: [], tip, checks };
  }
  const net = groups.length > 0 ? euros(groups.reduce((sum, g) => sum + cents(g.net), 0)) : null;
  const taxRate = groups.length > 0 ? groups[0].rate : null;
  if (gross !== null && groups.length === 0) checks.push('tax_estimated');
  return { gross, net, taxRate, taxGroups: groups, tip, checks };
}
