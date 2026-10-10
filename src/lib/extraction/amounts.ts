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
 *
 * That arithmetic is German. A receipt in another currency carries no German
 * value-added tax, so nothing German is worked out for it: its tax is what a
 * tax label on it names, and where it names none the bill is the net.
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
  /**
   * The rate that carries the largest part of the bill, percent. Null when it
   * is not printed and must be defaulted. 0, with the net equal to the total,
   * for a receipt in another currency that prints no tax: nothing is estimated
   * there.
   */
  taxRate: number | null;
  /** True when net and rate come from tax figures the receipt prints. */
  taxPrinted: boolean;
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
/** A line that names a discount ("Rabatt", "Sofortrabatt", "Discount: SPRING"), not one that only mentions the word ("rabattfähig"). */
const DISCOUNT_WORD = /(?:rabatte?|nachl(?:a|ä)sse?|discounts?|coupons?|gutscheine?)(?![\p{L}])/iu;
const TAX_WORD = /mwst|ust|vat|steuer|\btax\b/i;
const TOTAL_LABEL = /(?:^|[^\p{L}])(?:summe|gesamt(?:betrag|summe|preis)?|total|endbetrag|rechnungsbetrag|zu\s+zahlen|betrag|brutto|order\s+total|amount\s+due|balance\s+due|grand\s+total|final\s+cost)(?![\p{L}])/iu;
const NOT_A_TOTAL = /zwischensumme|sub\s*-?\s*total|item\s*\(?s?\)?\s*total|netto|steuer|mwst|ust\b|vat|(?:excl(?:uding|\.)?|before|without)\s+tax|gegeben|zur(?:ü|u)ck|r(?:ü|u)ckgeld|trinkgeld|\btip\b|rabatt|discount|shipping|versand/i;

/**
 * Net and tax amounts that belong together at one rate.
 *
 * Two amounts in the right proportion can meet by chance on a long receipt,
 * so a pair needs the printed total to vouch for it: either its own sum is
 * printed (alone, or with a printed tip on top), or the sum of ALL pairs
 * found is (a receipt that lists two groups at one rate and only their
 * common total).
 *
 * `notTax` are the amounts the receipt itself names as something else (a
 * tip, a discount); `tipCandidates` the amounts that can be a tip on top.
 */
function taxGroupsIn(values: Set<number>, rates: number[], named: { notTax: number[]; tipCandidates: number[] }): TaxGroup[] {
  const printed = (sum: number) => values.has(sum) || named.tipCandidates.some((tip) => tip < sum && values.has(sum + tip));
  const sorted = [...values].sort((x, y) => y - x);
  const pairs: Array<{ rate: number; net: number; tax: number; confirmed: boolean }> = [];
  const used = new Set<number>();
  // Pairs the printed total vouches for are settled first, so that a chance
  // match (an item price that happens to be 7 percent of another) cannot take
  // an amount a real tax line needs. An amount the receipt labels as the tip
  // or as a discount is never a tax amount, however well it fits a rate: a
  // coupon of 5,00 on a bill of 31,32 is 19 percent of what is left, and the
  // bill before the coupon is printed right above it.
  for (const wantConfirmed of [true, false]) {
    for (const net of sorted) {
      if (used.has(net)) continue;
      let hit: { rate: number; tax: number } | null = null;
      for (const rate of rates) {
        const tax = sorted.find(
          (t) => t < net && !used.has(t) && !named.notTax.includes(t) && isTaxOf(net, t, rate) && printed(net + t) === wantConfirmed,
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

/**
 * A total printed together with the tax it contains: the net is not printed, the pair still proves the rate.
 * A discount is never that tax (`discounts`): the bill before it would come out as the total.
 */
function grossWithTax(values: Set<number>, rates: number[], candidates: number[], discounts: number[]): TaxGroup | null {
  for (const gross of candidates) {
    for (const rate of rates) {
      for (const tax of values) {
        if (tax >= gross || discounts.includes(tax)) continue;
        if (isTaxOf(gross - tax, tax, rate)) {
          return { rate, net: euros(gross - tax), tax: euros(tax), gross: euros(gross) };
        }
      }
    }
  }
  return null;
}

/** A label for what is left to pay. It is the total, unless a credit or an earlier balance stands between the two. */
const DUE_LABEL = /(?:amount|balance)\s+due|f(?:ä|ae)lliger\s+betrag|offener\s+betrag/iu;
/** The line many invoices open with: "US$19.22 due October 29, 2025", "178,50 € fällig am 18. Januar 2025". */
const DUE_HEADLINE =
  /^\s*(?:US\$|[$€£]|EUR|USD|GBP)?\s*(\d{1,3}(?:[.,]\d{3})+[.,]\d{2}|\d{1,6}[.,]\d{2})\s*(?:€|EUR|USD|GBP)?\s+(?:due|f(?:ä|ae)llig)(?![\p{L}])/iu;
/** A credit, or a balance carried over, set against the invoice: the amount due is then not the invoice total. */
const BALANCE_APPLIED = /applied\s+balance|balance\s+applied|credit\s+applied|applied\s+credit|guthaben\s+verrechnet|verrechnetes\s+guthaben/i;
/** Any label of the totals block, standing alone on its line. */
const BLOCK_LABEL = /balance|guthaben|credit/i;

interface LabelledTotal {
  cents: number;
  /** Named as what is left to pay, not as the total. */
  due: boolean;
}

/**
 * Amounts a label calls the total: on the label's own line, or on the next
 * line when the label stands alone. A label inside a block of labels
 * ("Total / Amount due" above their values) names nothing by its position:
 * the line below the block is the value of the block's first label.
 */
function labelledTotals(text: string): LabelledTotal[] {
  const lines = text.split('\n');
  const out: LabelledTotal[] = [];
  const amountsOn = (line: string) => [...line.matchAll(AMOUNT)].map((m) => toCents(m[1])).filter((v): v is number => v !== null);
  const bareLabel = (line: string | undefined) =>
    line !== undefined && !AMOUNT_TEST.test(line) && (TOTAL_LABEL.test(line) || NOT_A_TOTAL.test(line) || TAX_LABEL.test(line) || BLOCK_LABEL.test(line));
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const headline = DUE_HEADLINE.exec(line);
    if (headline) {
      const value = toCents(headline[1]);
      if (value !== null) out.push({ cents: value, due: true });
      continue;
    }
    if (!TOTAL_LABEL.test(line) || NOT_A_TOTAL.test(line)) continue;
    const due = DUE_LABEL.test(line);
    const own = amountsOn(line);
    if (own.length > 0) {
      out.push({ cents: own[own.length - 1], due });
      continue;
    }
    const next = lines[i + 1] ?? '';
    if (NOT_A_TOTAL.test(next) || TOTAL_LABEL.test(next) || bareLabel(lines[i - 1])) continue;
    const following = amountsOn(next);
    if (following.length > 0) out.push({ cents: following[following.length - 1], due });
  }
  return out;
}

/** Amounts the receipt prints as taken off: a minus in front ("-€1.96", "- 5,00") or behind ("5,00-"). */
const DEDUCTION =
  /(?<![\p{L}\p{N}.,])[-\u2212]\s*(?:US\$|[$€£]|EUR|USD|GBP)?\s*(\d{1,3}(?:[.,]\d{3})+[.,]\d{2}|\d{1,6}[.,]\d{2})(?![\p{N}%])|(?<![\p{L}\p{N}.,:/#-])(\d{1,3}(?:[.,]\d{3})+[.,]\d{2}|\d{1,6}[.,]\d{2})\s*(?:€|EUR)?\s*[-\u2212](?=\s|$)/gmu;

function deductionsIn(text: string): Array<{ cents: number; line: number }> {
  const out: Array<{ cents: number; line: number }> = [];
  text.split('\n').forEach((line, i) => {
    for (const match of line.matchAll(DEDUCTION)) {
      const value = toCents(match[1] ?? match[2]);
      if (value !== null) out.push({ cents: value, line: i });
    }
  });
  return out;
}

/** The percentages a receipt prints that can be a tax rate ("19%", "25 %", "8.25%"). */
function ratesPrinted(text: string): number[] {
  const out = new Set<number>();
  for (const match of text.matchAll(/(?<![\p{N}.,])(\d{1,2}(?:[.,]\d{1,2})?)\s?%/gu)) {
    const rate = Number(match[1].replace(',', '.'));
    if (rate > 0 && rate <= 27.5) out.add(rate);
  }
  return [...out];
}

const NET_LABEL = /(?:^|[^\p{L}])(?:sub\s*-?\s*total|zwischensumme|netto(?:betrag|umsatz)?|net(?:\s+amount)?|before\s+tax)(?![\p{L}])/iu;
const TAX_LABEL = /(?:^|[^\p{L}])(?:(?:sales\s+)?tax|vat|mwst\.?|ust\.?|mehrwertsteuer|umsatzsteuer|tva|iva|gst|hst)(?![\p{L}])/iu;

const SUBTOTAL_LABEL = /(?:^|[^\p{L}])(?:sub\s*-?\s*total|zwischensumme)(?![\p{L}])/iu;
/** A tax label that does not name the tax amount: a net figure, a tax number, the heading "Tax invoice". */
const NOT_A_TAX_AMOUNT = /sub\s*-?\s*total|zwischensumme|netto|(?:tax|vat|gst|hst|iva|tva|ust|mwst)[\s.-]*(?:id|no\b|nr\b|number|nummer|reg|invoice|receipt|#)/i;

const LINE_END_AMOUNT = /(\d{1,3}(?:[.,]\d{3})+[.,]\d{2}|\d{1,6}[.,]\d{2})(?![\p{L}\p{N}%]|[.,:/-]\d)\s*(?:€|eur|usd|gbp|\$|£)?\s*$/iu;
/** A line that is one amount and nothing else ("$360.00", "-90,00 €"): the value of a label that stands alone above it. */
const BARE_AMOUNT_LINE = /^[-\u2212+]?\s*(?:€|eur|usd|gbp|\$|£)?\s*[-\u2212]?\s*(?:\d{1,3}(?:[.,]\d{3})+[.,]\d{2}|\d{1,6}[.,]\d{2})\s*(?:€|eur|usd|gbp|\$|£)?$/iu;

/** The minus many tills print behind a deduction ("5,00-"). */
const TRAILING_MINUS = /\s*[-\u2212]$/;

/** The amount a line ends with, in cents. Zero counts here: "Tax (0%): 0.00" is a statement. */
function lineEndAmount(line: string): number | null {
  const match = LINE_END_AMOUNT.exec(line.trim());
  if (!match) return null;
  const raw = match[1];
  const lastSeparator = Math.max(raw.lastIndexOf(','), raw.lastIndexOf('.'));
  return Number(raw.slice(0, lastSeparator).replace(/[.,]/g, '')) * 100 + Number(raw.slice(lastSeparator + 1));
}

/** The amount a label on the same line names. */
function statedAmount(text: string, label: RegExp, exclude?: RegExp): number | null {
  for (const line of text.split('\n')) {
    if (!label.test(line) || (exclude && exclude.test(line))) continue;
    const amount = lineEndAmount(line);
    if (amount !== null) return amount;
  }
  return null;
}

/**
 * Every amount the lines matching `label` name, in the order of the receipt:
 * at the end of the label's own line, or on the line below when the label
 * stands alone and that line is nothing but an amount (an invoice that sets
 * every label above its value).
 */
function namedAmounts(text: string, label: RegExp, exclude?: RegExp): number[] {
  const lines = text.split('\n');
  const out: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!label.test(line) || (exclude && exclude.test(line))) continue;
    const own = line.trim().replace(TRAILING_MINUS, '');
    const below = (lines[i + 1] ?? '').trim().replace(TRAILING_MINUS, '');
    const amount = lineEndAmount(own) ?? (!AMOUNT_TEST.test(line) && BARE_AMOUNT_LINE.test(below) ? lineEndAmount(below) : null);
    if (amount !== null) out.push(amount);
  }
  return out;
}

/**
 * The rate `tax` is of `net`, percent: to a whole percent where the figures
 * allow it (7.0, 8.25 stays 8.25). Null for a rate no receipt carries.
 */
function rateOf(netCents: number, taxCents: number): number | null {
  if (netCents <= 0) return null;
  const rate = Math.round((taxCents / netCents) * 10000) / 100;
  // No receipt carries a rate above the highest standard rate in the European Union.
  if (rate < 0 || rate > 27.5) return null;
  return Math.abs(rate - Math.round(rate)) < 0.06 ? Math.round(rate) : rate;
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
  if (n === null || t === null) return null;
  const rate = rateOf(n, t);
  return rate === null ? null : { net: n, tax: t, rate };
}

/** Every discount the receipt names, added up. */
function discountsNamed(text: string): number {
  return namedAmounts(text, DISCOUNT_WORD).reduce((sum, discount) => sum + discount, 0);
}

/**
 * The tax of a receipt in another currency: the amount a tax label on it
 * names, and the net that leaves. Nothing is worked out from a rate, and a
 * subtotal alone states no tax (a discount, shipping or a tip can stand
 * between it and the total). Null when the receipt names no tax amount.
 *
 * `addsUp` says whether the receipt's figures bear this total out: it names
 * no subtotal to check against, or its subtotal, less any discount, plus the
 * tax is the total. A total that includes a tip does not add up.
 */
function labelledTax(text: string, grossCents: number): { net: number; tax: number; rate: number; addsUp: boolean } | null {
  for (const tax of namedAmounts(text, TAX_LABEL, NOT_A_TAX_AMOUNT)) {
    // "Total before tax: 100.00" carries the word too: an amount that is no tax of this total is passed over.
    const rate = tax < grossCents ? rateOf(grossCents - tax, tax) : null;
    if (rate === null) continue;
    const subtotal = namedAmounts(text, NET_LABEL)[0];
    const addsUp = subtotal === undefined || Math.abs(subtotal - discountsNamed(text) + tax - grossCents) <= 1;
    return { net: grossCents - tax, tax, rate, addsUp };
  }
  return null;
}

/**
 * True when the receipt's own discount arithmetic gives this total: the
 * subtotal it states, less every discount it states. Three labelled figures
 * that add up are the receipt's proof of its total, in any currency.
 */
function discountConfirms(text: string, totalCents: number): boolean {
  const subtotal = namedAmounts(text, SUBTOTAL_LABEL)[0];
  const off = discountsNamed(text);
  return subtotal !== undefined && off > 0 && Math.abs(subtotal - off - totalCents) <= 1;
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
 * arithmetic, then a labelled total that a second reading or the receipt's
 * discount arithmetic agrees with, then a labelled total alone (reported as
 * unconfirmed), then nothing.
 */
export function readAmounts(text: string, hints: AmountHints = {}): AmountReading {
  const found = amountsInText(text);
  const values = new Set(found.map((a) => a.cents));
  const checks: AmountCheck[] = [];
  const german = !hints.currency || hints.currency === 'EUR';
  const rates = ratesOn(hints.date ? hints.date.slice(0, 10) : null);
  const model = hints.modelGross !== null && hints.modelGross !== undefined ? cents(hints.modelGross) : null;
  // The amount due is the total, except where a credit or an earlier balance
  // was set against the invoice: then the line that says "Total" is.
  const named = labelledTotals(text).filter((t) => t.cents <= SANE_TOTAL_CENTS);
  const settled = BALANCE_APPLIED.test(text) && named.some((t) => !t.due);
  const labelled = named.filter((t) => !settled || !t.due).map((t) => t.cents);

  // A tip is an amount on a line that names it; with columns torn apart it is
  // any amount that, added to a printed sum, gives another printed sum.
  const lines = text.split('\n');
  const tipLine = (l: string) => TIP_WORD.test(l) && !/nicht\s+enthalten|not\s+included|\bis\s+not\b/i.test(l);
  const hasTipWord = lines.some(tipLine);
  // On the tip line itself, or on the line after it when the label stands alone
  // and is not part of a block of labels whose values follow in another order.
  const bareLabel = (l: string | undefined) => l !== undefined && !AMOUNT_TEST.test(l) && (TOTAL_LABEL.test(l) || NOT_A_TOTAL.test(l));
  const namedOn = (isLabel: (l: string) => boolean) =>
    found
      .filter(
        (a) =>
          isLabel(lines[a.line]) ||
          (a.line > 0 && isLabel(lines[a.line - 1]) && !AMOUNT_TEST.test(lines[a.line - 1]) && !bareLabel(lines[a.line - 2])),
      )
      .map((a) => a.cents);
  const tipOnLine = namedOn(tipLine);
  // A discount is named the same way. Subtracted from the bill it leaves a
  // printed sum, exactly as a tip added to it gives one, and it can be 19
  // percent of what is left: without its label it would pass for either.
  const discounts = namedOn((l) => DISCOUNT_WORD.test(l));
  // Cash handed over minus the bill is the change, not a tip: with change on the
  // receipt only an amount the receipt itself labels as the tip is taken.
  const hasChange = /zur(?:ü|u)ck|r(?:ü|u)ckgeld|wechselgeld|\bchange\b/i.test(text);
  const unnamed = [...values].filter((v) => !discounts.includes(v));
  const tipCandidates = !hasTipWord ? [] : hasChange ? tipOnLine : [...new Set([...tipOnLine, ...unnamed])];
  // Net and tax by their labels, where they bear a total out. German figures
  // must add up to it; in another currency the tax a label names must fit it.
  const readStated = (grossCents: number) => {
    if (german) return statedNetAndTax(text, grossCents);
    const named = labelledTax(text, grossCents);
    return named?.addsUp ? named : null;
  };

  let groups: TaxGroup[] = [];
  if (german) {
    const modelGroups = (hints.modelTaxLines ?? [])
      .map((l) => ({ rate: l.rate, net: cents(l.net), tax: cents(l.tax) }))
      .filter((l) => rates.includes(l.rate) && l.net > 0 && l.tax > 0 && isTaxOf(l.net, l.tax, l.rate))
      .map((l) => ({ rate: l.rate, net: euros(l.net), tax: euros(l.tax), gross: euros(l.net + l.tax) }));
    groups = taxGroupsIn(values, rates, { notTax: [...tipOnLine, ...discounts], tipCandidates });
    if (groups.length === 0 && modelGroups.length > 0) groups = modelGroups;
  } else {
    // Another currency: no German rate is assumed for it. A rate the receipt
    // prints itself counts ("VAT - Germany (19% on $20.00)" on a dollar
    // invoice), and so does a German rate on a receipt that names a tax
    // without its rate, but only where net, tax and their sum are all printed:
    // the receipt then states the tax, nothing is worked out for it.
    const candidates = [...new Set([...ratesPrinted(text), ...(TAX_WORD.test(text) ? rates : [])])];
    groups = taxGroupsIn(values, candidates, { notTax: [...tipOnLine, ...discounts], tipCandidates });
  }

  let gross: number | null = null;
  let tip: number | null = null;
  let stated: { net: number; tax: number; rate: number } | null = null;

  if (groups.length > 0) {
    groups.sort((a, b) => b.gross - a.gross);
    const bill = groups.reduce((sum, g) => sum + cents(g.gross), 0);
    const taxSum = groups.reduce((sum, g) => sum + cents(g.tax), 0);
    gross = euros(bill);
    const isTip = (t: number) => t < bill && values.has(bill + t);
    const tipCents = tipOnLine.find(isTip) ?? tipCandidates.find(isTip);
    if (tipCents !== undefined) tip = euros(tipCents);
    // The tax groups can cover a part of the bill only. A labelled total above
    // them that the receipt bears out is the total: one that, less the tax,
    // is printed as well (duties and fees without tax next to taxed services).
    const withUntaxed = Math.max(0, ...labelled.filter((total) => total > bill && values.has(total - taxSum)));
    // And a total below them, where the difference is printed as an amount
    // taken off (a promotion after the tax lines): one a label calls the
    // total, or, with the labels torn from their amounts, one printed below
    // an amount that carries its minus sign and stands below the bill.
    const minus = deductionsIn(text);
    const deductions = [...minus.map((d) => d.cents), ...discounts];
    const afterDeduction =
      labelled.findLast((total) => total < bill && deductions.includes(bill - total)) ??
      minus
        .filter((d) => d.cents < bill && found.some((a) => a.cents === bill && a.line < d.line) && found.some((a) => a.cents === bill - d.cents && a.line > d.line))
        .map((d) => bill - d.cents)[0];
    const paid = withUntaxed > 0 ? withUntaxed : (afterDeduction ?? bill);
    if (model !== null && model !== paid && !(tipCents !== undefined && model === paid + tipCents)) checks.push('total_conflict');
    if (paid !== bill) {
      // The rate is printed; the net is the total less the tax where the tax
      // still stands, and left to the rate where a deduction changed it.
      const net = withUntaxed > 0 ? euros(paid - taxSum) : null;
      return { gross: euros(paid), net, taxRate: groups[0].rate, taxPrinted: true, taxGroups: withUntaxed > 0 ? groups : [], tip, checks };
    }
  } else {
    // Largest first: the total is the largest amount a printed tax amount fits.
    const withTax =
      german && TAX_WORD.test(text)
        ? grossWithTax(values, rates, unnamed.filter((v) => v <= SANE_TOTAL_CENTS && !tipOnLine.includes(v)).sort((x, y) => y - x), discounts)
        : null;
    if (withTax) {
      groups = [withTax];
      gross = withTax.gross;
    } else if (labelled.length > 0 && model !== null && labelled.includes(model)) {
      // The second reading agrees with a labelled amount. Where a larger one
      // is labelled further down, it agreed with a column heading or a part
      // ("Total" above the line items): the last labelled total stands.
      const last = labelled[labelled.length - 1];
      const part = labelled.slice(labelled.lastIndexOf(model) + 1).some((later) => later > model);
      gross = euros(part ? last : model);
      stated = readStated(part ? last : model);
      if (part) checks.push('total_conflict');
    } else if (labelled.length > 0 && readStated(labelled[labelled.length - 1])) {
      // A receipt that states net, tax and total and whose three figures add up
      // has confirmed its own total, at whatever rate its country uses.
      gross = euros(labelled[labelled.length - 1]);
      stated = readStated(labelled[labelled.length - 1]);
    } else if (labelled.length > 0) {
      // The last labelled total is the one after discounts and shipping.
      const pick = labelled[labelled.length - 1];
      gross = euros(pick);
      if (model !== null && model !== pick) checks.push('total_conflict');
      // Subtotal less discount is this total: the receipt has confirmed it itself.
      else if (!discountConfirms(text, pick)) checks.push('total_unconfirmed');
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
    return { gross, net: euros(stated.net), taxRate: stated.rate, taxPrinted: true, taxGroups: [], tip, checks };
  }
  if (!german && groups.length === 0) {
    // Another currency. The tax a label names is kept also where it could not
    // confirm the total (a total only the second reading gave, figures that do
    // not add up): the doubt about the total is in the checks.
    const named = gross !== null ? labelledTax(text, cents(gross)) : null;
    if (named) return { gross, net: euros(named.net), taxRate: named.rate, taxPrinted: true, taxGroups: [], tip, checks };
    // No tax amount on the receipt: no German rate is assumed for it (a
    // dollar invoice was given 19 percent). The bill is the net, the rate 0,
    // and nothing here is an estimate that would need a look.
    return { gross, net: gross, taxRate: 0, taxPrinted: false, taxGroups: [], tip, checks };
  }
  const net = groups.length > 0 ? euros(groups.reduce((sum, g) => sum + cents(g.net), 0)) : null;
  const taxRate = groups.length > 0 ? groups[0].rate : null;
  if (gross !== null && groups.length === 0) checks.push('tax_estimated');
  return { gross, net, taxRate, taxPrinted: groups.length > 0, taxGroups: groups, tip, checks };
}
