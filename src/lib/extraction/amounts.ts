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

/** What the total rests on, strongest first. Said with every reading, so that a wrong total can be traced to its rule. */
export type TotalBasis =
  /** Net and tax amounts that belong together at a printed rate and add up to a printed sum. */
  | 'tax_groups'
  /** A printed sum together with the tax it contains. */
  | 'gross_with_tax'
  /** The total, net and tax a model read from the page, all printed and adding up. */
  | 'page_proof'
  /** A labelled amount a second reading agrees with. */
  | 'label_agreed'
  /** A labelled amount that the net and tax stated next to their labels add up to. */
  | 'label_stated'
  /** A labelled amount that is the stated subtotal less the stated discounts. */
  | 'label_discount'
  /** The total a model read from the page, printed in the text, with nothing else to prove it. */
  | 'page_reading'
  /** A labelled amount with nothing to confirm it. */
  | 'label_alone'
  /** The total of a model, printed in the text, where no label names any. */
  | 'model_alone'
  | 'none';

export interface AmountReading {
  /** The amount of the bill, without a tip. */
  gross: number | null;
  /** What `gross` rests on. */
  basis: TotalBasis;
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
function taxGroupsIn(
  values: Set<number>,
  rates: number[],
  named: { notTax: number[]; tipCandidates: number[]; admits: (tax: number, rate: number) => boolean },
): TaxGroup[] {
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
          (t) =>
            t < net &&
            !used.has(t) &&
            !named.notTax.includes(t) &&
            named.admits(t, rate) &&
            isTaxOf(net, t, rate) &&
            printed(net + t) === wantConfirmed,
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
function grossWithTax(
  values: Set<number>,
  rates: number[],
  candidates: number[],
  discounts: number[],
  admits: (tax: number, rate: number) => boolean,
): TaxGroup | null {
  for (const gross of candidates) {
    for (const rate of rates) {
      for (const tax of values) {
        if (tax >= gross || discounts.includes(tax) || !admits(tax, rate)) continue;
        if (isTaxOf(gross - tax, tax, rate)) {
          return { rate, net: euros(gross - tax), tax: euros(tax), gross: euros(gross) };
        }
      }
    }
  }
  return null;
}

/** A label for what is left to pay. It is the total, unless a credit or an earlier balance stands between the two. */
const DUE_LABEL = /(?:amount|balance)\s+due|f(?:ä|ae)lliger\s+betrag|offener\s+betrag|zu\s+zahlender\s+betrag/iu;
/** The line many invoices open with: "US$19.22 due October 29, 2025", "178,50 € fällig am 18. Januar 2025". */
const DUE_HEADLINE =
  /^\s*(?:US\$|[$€£]|EUR|USD|GBP)?\s*(\d{1,3}(?:[.,]\d{3})+[.,]\d{2}|\d{1,6}[.,]\d{2})\s*(?:€|EUR|USD|GBP)?\s+(?:due|f(?:ä|ae)llig)(?![\p{L}])/iu;
/** A credit, or a balance carried over, set against the invoice: the amount due is then not the invoice total. */
const BALANCE_APPLIED =
  /applied\s+balance|balance\s+applied|credit\s+applied|applied\s+credit|guthaben\s+verrechnet|verrechnetes\s+guthaben|kontostand\s+(?:vom|alt|vor)|(?:alter|bisheriger)\s+kontostand/i;
/**
 * A label that names the total of this invoice as such ("Rechnungsbetrag
 * gesamt"). A mobile bill prints it above the amount to pay with an earlier
 * balance and above a list of account movements whose "Summe Brutto" is an
 * earlier invoice: the invoice total stands over a later labelled amount.
 */
const INVOICE_TOTAL_LABEL = /rechnungsbetrag\s+gesamt|gesamtrechnungsbetrag|rechnungsgesamtsumme|gesamtbetrag\s+(?:der|dieser)\s+rechnung|invoice\s+total(?![\p{L}])/iu;
/** Any label of the totals block, standing alone on its line. */
const BLOCK_LABEL = /balance|guthaben|credit/i;

interface LabelledTotal {
  cents: number;
  /** Named as what is left to pay, not as the total. */
  due: boolean;
  /** Named as the total of this invoice itself (see INVOICE_TOTAL_LABEL). */
  invoice?: boolean;
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
      out.push({ cents: own[own.length - 1], due, invoice: INVOICE_TOTAL_LABEL.test(line) });
      continue;
    }
    const next = lines[i + 1] ?? '';
    if (NOT_A_TOTAL.test(next) || TOTAL_LABEL.test(next) || bareLabel(lines[i - 1])) continue;
    const following = amountsOn(next);
    if (following.length > 0) out.push({ cents: following[following.length - 1], due, invoice: INVOICE_TOTAL_LABEL.test(line) });
  }
  return out;
}

/** Amounts the receipt prints as taken off: a minus in front ("-€1.96", "- 5,00") or behind ("5,00-"). */
const DEDUCTION =
  /(?<![\p{L}\p{N}.,])[-\u2212]\s*(?:US\$|[$€£]|EUR|USD|GBP)?\s*(\d{1,3}(?:[.,]\d{3})+[.,]\d{2}|\d{1,6}[.,]\d{2})(?![\p{N}%])|(?<![\p{L}\p{N}.,:/#-])(\d{1,3}(?:[.,]\d{3})+[.,]\d{2}|\d{1,6}[.,]\d{2})\s*(?:€|EUR)?\s*[-\u2212](?=\s|$)/gmu;

/**
 * A line whose minus is no deduction from the bill: a payment made against it
 * ("Zahlungen -3,99 €"), or a net figure set off by a dash ("Gesamtsumme
 * (zzgl. USt.) - 3,35 €"). Taken as deductions, they turned a mail-scanning
 * invoice of 3.99 into its tax of 0.64.
 */
const NOT_A_DEDUCTION =
  /(?<![\p{L}])(?:zahlungen?|bezahlt|payments?|paid)(?![\p{L}])|(?<![\p{L}])(?:zzgl|exkl|excl|excluding|ohne)\.?\s*(?:ust|mwst|vat|tax)|(?<![\p{L}-])netto(?![\p{L}-])|(?:before|without)\s+tax/iu;
/** A deduction the receipt names as one: a discount, a coupon, a promotion. It stays a deduction whatever else its line says. */
const NAMED_DEDUCTION = /(?<![\p{L}])(?:aktion|promo|bonus)/iu;
const isNamedDeduction = (line: string) => DISCOUNT_WORD.test(line) || NAMED_DEDUCTION.test(line);

function deductionsIn(text: string): Array<{ cents: number; line: number }> {
  const out: Array<{ cents: number; line: number }> = [];
  const lines = text.split('\n');
  lines.forEach((line, i) => {
    // On the line itself, or on a label that stands alone above a bare amount.
    const above = lines[i - 1];
    const labelAbove = above !== undefined && !AMOUNT_TEST.test(above) && BARE_AMOUNT_LINE.test(line.trim()) ? above : null;
    if (!isNamedDeduction(line) && !(labelAbove !== null && isNamedDeduction(labelAbove))) {
      if (NOT_A_DEDUCTION.test(line)) return;
      if (labelAbove !== null && NOT_A_DEDUCTION.test(labelAbove)) return;
    }
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
/**
 * A tax word that names no amount: a tax number, a VAT identification number
 * ("DE VAT DE123456789"), a code with its value ("VAT-Code: XX-0000", not the
 * column heading "VAT Code"), or the heading "Tax invoice".
 */
const TAX_IDENTIFIER =
  /(?:tax|vat|gst|hst|iva|tva|ust|mwst|steuer)[\s.:-]*(?:id|no\b|nr\b|number|nummer|reg|invoice|receipt|code\s*:\s*[a-z0-9]|#|[a-z]{2}\s?\d{6,})|st\.-?\s?nr/i;
/** A tax label that does not name the tax amount: a net figure, or a tax word that names no amount. */
const NOT_A_TAX_AMOUNT = new RegExp(`sub\\s*-?\\s*total|zwischensumme|netto|${TAX_IDENTIFIER.source}`, 'i');
/**
 * The German words for the value-added tax itself ("Mehrwertsteuer",
 * "Umsatzsteuer", "MwSt.-Betrag", "Steuer", "Steuersatz"). Not another tax
 * that ends in the same word ("Grundsteuer", "Kfz-Steuer"), and not
 * "Steuerberatung".
 */
const GERMAN_TAX_WORD = /mwst|(?:(?<![\p{L}-])|mehrwert|umsatz)steuer(?:betrag|satz|anteil)?(?![\p{L}])/iu;
/** A sentence about tax with neither an amount nor a rate in it is this long at most to count as a label. */
const TAX_LABEL_MAX = 60;

/**
 * A line that names a tax: a tax label, or a German word for the tax, that is
 * not a tax number, a VAT identification number or a code. A sentence about
 * tax without an amount or a rate in it ("Tax will vary based on your
 * jurisdiction and is calculated at checkout") names none; a long till line
 * with its figures does.
 */
function namesATax(line: string): boolean {
  const trimmed = line.trim();
  if (TAX_IDENTIFIER.test(trimmed)) return false;
  if (trimmed.length > TAX_LABEL_MAX && !AMOUNT_TEST.test(trimmed) && !/\d\s?%/.test(trimmed)) return false;
  return TAX_LABEL.test(trimmed) || GERMAN_TAX_WORD.test(trimmed);
}

/**
 * Words by which a whole document states that it carries no German
 * value-added tax: a small business, reverse charge. "steuerfrei" is not
 * among them: it marks one line (a deposit, a voucher) of a receipt that can
 * carry tax on the others.
 */
const NO_TAX_STATED =
  /keine\s+(?:umsatz|mehrwert)steuer|(?:§|paragraph)\s*19\s*(?:abs\.?\s*\d\s*)?ustg|reverse\s*-?\s*charge|steuerschuldnerschaft\s+des\s+leistungsempf/iu;

const LINE_END_AMOUNT = /(\d{1,3}(?:[.,]\d{3})+[.,]\d{2}|\d{1,6}[.,]\d{2})(?![\p{L}\p{N}%]|[.,:/-]\d)\s*(?:€|eur|usd|gbp|\$|£)?\s*$/iu;
/** A line that is one amount and nothing else ("$360.00", "-90,00 €"): the value of a label that stands alone above it. */
const BARE_AMOUNT_LINE = /^[-\u2212+]?\s*(?:€|eur|usd|gbp|us\$|\$|£)?\s*[-\u2212]?\s*(?:\d{1,3}(?:[.,]\d{3})+[.,]\d{2}|\d{1,6}[.,]\d{2})\s*(?:€|eur|usd|gbp|\$|£)?$/iu;

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

/**
 * True when the text prints this amount anywhere, in either notation, also
 * where `amountsInText` does not count it as money: glued to a currency code
 * ("EUR63,98") or on a line that carries a booking number.
 */
function printedAnywhere(text: string, amountCents: number): boolean {
  const whole = String(Math.floor(amountCents / 100));
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, '[.,\u00a0 ]?');
  const fraction = String(amountCents % 100).padStart(2, '0');
  return new RegExp(`(?<![\\d.,])${grouped}[.,]${fraction}(?!\\d)`).test(text);
}

export interface AmountHints {
  /** ISO day of the receipt, to know which tax rates were in force. */
  date?: string | null;
  /** ISO 4217 code. The tax arithmetic is German; another currency is read by label only. */
  currency?: string;
  /** The total as a language model read it: a second opinion, never taken on its own word against the arithmetic. */
  modelGross?: number | null;
  /** Tax lines a language model read as printed. They count only where their figures stand in the text. */
  modelTaxLines?: Array<{ rate: number; net: number; tax: number }> | null;
  /** The net amount as the model read it. */
  modelNet?: number | null;
  /**
   * True when the model was given the page itself, not only the recognized
   * text. It can then tell which amount stands next to "Total", so its total
   * is taken over a label reading that nothing proves, and it can complete a
   * proof from printed figures. It still never outranks the arithmetic.
   */
  modelSawPage?: boolean;
  /** True when the model saw the page and says the document states no total (an application that names a monthly rate only). */
  modelNoTotal?: boolean;
}

/**
 * Read the amounts of a receipt. Order of trust: the receipt's own tax
 * arithmetic, then a labelled total that a second reading or the receipt's
 * discount arithmetic agrees with, then the total of a model that saw the
 * page where it stands in the text (reported as a conflict when a label names
 * another amount), then a labelled total alone (reported as unconfirmed), then
 * nothing.
 */
export function readAmounts(text: string, hints: AmountHints = {}): AmountReading {
  const found = amountsInText(text);
  const values = new Set(found.map((a) => a.cents));
  const checks: AmountCheck[] = [];
  const german = !hints.currency || hints.currency === 'EUR';
  const rates = ratesOn(hints.date ? hints.date.slice(0, 10) : null);
  const model = hints.modelGross !== null && hints.modelGross !== undefined ? cents(hints.modelGross) : null;
  const sawPage = hints.modelSawPage === true;
  // "No total" is only believed from a model that saw the page, and only where it names none itself.
  const noTotal = sawPage && hints.modelNoTotal === true && model === null;
  // The amount due is the total, except where a credit or an earlier balance
  // was set against the invoice: then the line that says "Total" is.
  const named = labelledTotals(text).filter((t) => t.cents <= SANE_TOTAL_CENTS);
  const settled = BALANCE_APPLIED.test(text) && named.some((t) => !t.due);
  // The total the invoice names as its own is taken as the last labelled one, so it stands over later labels.
  const kept = named.filter((t) => !settled || !t.due);
  // The first such label is the invoice's own: a later one belongs to an earlier invoice listed under account movements.
  const invoiceTotal = kept.find((t) => t.invoice);
  const labelled = (invoiceTotal ? [...kept.filter((t) => t !== invoiceTotal), invoiceTotal] : kept).map((t) => t.cents);

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

  // A tax is a figure the receipt names as one. Two amounts in the ratio of a
  // rate are no tax by themselves: two usage lines of 18.76 and 1.30 on an
  // invoice without tax fit 7 percent, and a page of cent amounts holds a
  // pair for every rate. So a pair counts only where its tax amount stands on
  // a line that names a tax, or where the receipt carries a tax label at all:
  // a receipt whose labels the text recognition tore from their amounts still
  // prints one somewhere ("MwSt", "Estimated VAT:"). On a euro receipt a
  // printed rate in force does the same ("A 19%"). A tax number or a VAT
  // identification number is no tax label, and a receipt that states it
  // carries no tax has none to pair.
  const taxNamedAmounts = namedAmounts(text, TAX_LABEL, NOT_A_TAX_AMOUNT);
  // On the label's own line ("MwSt 0,32" inside a line of net, tax and gross), or the value below a label that stands alone.
  const taxAmountsNamed = new Set([...taxNamedAmounts, ...found.filter((a) => namesATax(lines[a.line])).map((a) => a.cents)]);
  // The receipt says it carries no tax: a tax line at 0 percent ("Tax (0%)"),
  // tax amounts that are all 0.00, or the words of a small-business or
  // reverse-charge invoice. Never where a tax above 0 is printed: a tax line
  // with a rate or an amount above 0, or on a euro receipt any rate in force
  // ("A 19%" on a till row next to a bottle deposit at 0 percent).
  const taxLines = lines.filter(namesATax);
  // A tax line at 0 percent next to a taxed part: a mobile bill's fee at 0
  // percent, its net printed with four decimals that the reader counts as no
  // money. The total the invoice names as its own then stands above the taxed
  // part the arithmetic proves.
  const zeroRatedPart = taxLines.some((l) => /(?<![\p{N}.,])0\s?%/u.test(l));
  // The part above the taxed one must be printed: as money, or as a net with four decimals ("4,5000 €").
  const fourDecimals = [...text.matchAll(/(?<![\p{N}.,])(\d{1,6})[.,](\d{4})(?![\p{N}])/gu)].map((m) => Math.round(Number(`${m[1]}.${m[2]}`) * 100));
  const gapPrinted = (gap: number) => gap > 0 && (values.has(gap) || fourDecimals.includes(gap));
  const printedRates = ratesPrinted(text);
  const positiveTaxPrinted =
    taxNamedAmounts.some((amount) => amount > 0) ||
    taxLines.some((l) => ratesPrinted(l).length > 0) ||
    (german && printedRates.some((rate) => rates.includes(rate)));
  const zeroRateLine = taxLines.some((l) => /(?<![\p{N}.,])0(?:[.,]0+)?\s?%/u.test(l));
  const onlyZeroAmounts = taxNamedAmounts.length > 0 && taxNamedAmounts.every((amount) => amount === 0);
  const zeroTaxStated = !positiveTaxPrinted && (zeroRateLine || onlyZeroAmounts || NO_TAX_STATED.test(text));
  const taxLabelled = !zeroTaxStated && taxLines.length > 0;
  const admits = (tax: number, rate?: number) =>
    taxAmountsNamed.has(tax) || taxLabelled || (german && !zeroTaxStated && rate !== undefined && printedRates.includes(rate));

  let groups: TaxGroup[] = [];
  if (german) {
    const modelGroups = (hints.modelTaxLines ?? [])
      .map((l) => ({ rate: l.rate, net: cents(l.net), tax: cents(l.tax) }))
      .filter((l) => rates.includes(l.rate) && l.net > 0 && l.tax > 0 && isTaxOf(l.net, l.tax, l.rate))
      // Printed figures only: a line the model worked out, or read from a page the text does not show, proves nothing.
      .filter((l) => values.has(l.net) && values.has(l.tax))
      .map((l) => ({ rate: l.rate, net: euros(l.net), tax: euros(l.tax), gross: euros(l.net + l.tax) }));
    groups = taxGroupsIn(values, rates, { notTax: [...tipOnLine, ...discounts], tipCandidates, admits });
    if (groups.length === 0 && modelGroups.length > 0) groups = modelGroups;
  } else {
    // Another currency: no German rate is assumed for it. A rate the receipt
    // prints itself counts ("VAT - Germany (19% on $20.00)" on a dollar
    // invoice), and so does a German rate on a receipt that names a tax
    // without its rate, but only where net, tax and their sum are all printed:
    // the receipt then states the tax, nothing is worked out for it.
    const candidates = [...new Set([...ratesPrinted(text), ...(taxLabelled ? rates : [])])];
    groups = taxGroupsIn(values, candidates, { notTax: [...tipOnLine, ...discounts], tipCandidates, admits });
  }
  // Groups whose tax no line names, adding up to less than the total a label
  // names, are amounts of a usage table that happen to fit a rate (0.75 and
  // 0.15 on an invoice of 5.00): they are not the bill, and the label reading
  // below decides.
  const billOfGroups = groups.reduce((sum, g) => sum + cents(g.gross), 0);
  const vouched = (g: TaxGroup) => taxAmountsNamed.has(cents(g.tax)) || (german && printedRates.includes(g.rate));
  if (groups.length > 0 && !groups.some(vouched) && labelled.length > 0 && !labelled.includes(billOfGroups) && billOfGroups < Math.max(...labelled)) {
    groups = [];
  }

  // The total of a model that saw the page, where the recognized text prints that amount.
  const pageTotal = sawPage && model !== null && values.has(model) && model <= SANE_TOTAL_CENTS ? model : null;
  // Its net, where net and the tax that leaves are printed too: three printed
  // figures that add up, paired by the page instead of by a label.
  const pageNet =
    hints.modelNet !== null && hints.modelNet !== undefined
      ? cents(hints.modelNet)
      : (hints.modelTaxLines ?? []).length > 0
        ? (hints.modelTaxLines ?? []).reduce((sum, l) => sum + cents(l.net), 0)
        : null;
  const pageSplit = (totalCents: number) => {
    if (!sawPage || pageNet === null || pageNet <= 0 || pageNet >= totalCents) return null;
    const tax = totalCents - pageNet;
    const rate = rateOf(pageNet, tax);
    if (rate === null || !values.has(pageNet)) return null;
    // The tax amount is printed, or the receipt prints "Subtotal" and "Total"
    // only and the difference is exactly a rate in force or one it prints.
    if (!values.has(tax) && ![...rates, ...ratesPrinted(text)].includes(rate)) return null;
    return { net: pageNet, tax, rate };
  };
  const pageProof = pageTotal !== null ? pageSplit(pageTotal) : null;

  let gross: number | null = null;
  let basis: TotalBasis = 'none';
  let tip: number | null = null;
  let stated: { net: number; tax: number; rate: number } | null = null;

  if (groups.length > 0) {
    groups.sort((a, b) => b.gross - a.gross);
    const bill = groups.reduce((sum, g) => sum + cents(g.gross), 0);
    const taxSum = groups.reduce((sum, g) => sum + cents(g.tax), 0);
    gross = euros(bill);
    basis = 'tax_groups';
    const isTip = (t: number) => t < bill && values.has(bill + t);
    const tipCents = tipOnLine.find(isTip) ?? tipCandidates.find(isTip);
    if (tipCents !== undefined) tip = euros(tipCents);
    // The tax groups can cover a part of the bill only. A labelled total above
    // them that the receipt bears out is the total: one that, less the tax,
    // is printed as well (duties and fees without tax next to taxed services).
    // The total a model read from the page counts like a labelled one here: the
    // page pairs the amount with its label, the printed figure proves it.
    const totals = pageTotal !== null ? [...labelled, pageTotal] : labelled;
    // Or the total the invoice names as its own, above the taxed part, on an
    // invoice that prints a part at 0 percent (see zeroRatedPart).
    const invoiceAbove = invoiceTotal !== undefined && invoiceTotal.cents > bill && zeroRatedPart && gapPrinted(invoiceTotal.cents - bill) ? [invoiceTotal.cents] : [];
    const withUntaxed = Math.max(0, ...totals.filter((total) => total > bill && values.has(total - taxSum)), ...invoiceAbove);
    // And a total below them, where the difference is printed as an amount
    // taken off (a promotion after the tax lines): one a label calls the
    // total, or, with the labels torn from their amounts, one printed below
    // an amount that carries its minus sign and stands below the bill.
    const minus = deductionsIn(text);
    const deductions = [...minus.map((d) => d.cents), ...discounts];
    // Whatever its wording, an amount taken off that leaves exactly the tax is
    // the net set off by a dash ("Nettobetrag - 3,35 €"), never a deduction.
    const afterDeduction =
      labelled.findLast((total) => total < bill && total !== taxSum && deductions.includes(bill - total)) ??
      minus
        .filter(
          (d) =>
            d.cents < bill &&
            bill - d.cents !== taxSum &&
            found.some((a) => a.cents === bill && a.line < d.line) &&
            found.some((a) => a.cents === bill - d.cents && a.line > d.line),
        )
        .map((d) => bill - d.cents)[0];
    // A total above the tax groups that a label in the text AND the page
    // reading both name: the groups then cover a part of the bill only (one
    // taxed item on a slip of tax-free postage). Two independent readings
    // agree, so it is taken, and because the tax arithmetic alone does not
    // bear it out, a person looks.
    // Or the page names a printed total that is the taxed bill plus one other
    // printed amount (tax-free postage next to a taxed box): three printed
    // figures that add up, paired by the page. Not on a receipt that names a
    // tip: there the amount on top is the tip, which is handled below.
    // Never against a bill that a label further down calls the total itself:
    // the amount above it is then a figure before a discount, and the proven
    // total stands.
    const billIsLaterTotal = pageTotal !== null && labelled.lastIndexOf(bill) > labelled.lastIndexOf(pageTotal);
    const above =
      withUntaxed === 0 && afterDeduction === undefined && pageTotal !== null && pageTotal > bill && !billIsLaterTotal && !(tipCents !== undefined && pageTotal === bill + tipCents);
    const agreedAbove = above && pageTotal !== null && (labelled.includes(pageTotal) || (!hasTipWord && values.has(pageTotal - bill)));
    if (agreedAbove && pageTotal !== null) {
      checks.push('total_conflict');
      return { gross: euros(pageTotal), basis: labelled.includes(pageTotal) ? 'label_agreed' : 'page_reading', net: euros(pageTotal - taxSum), taxRate: groups[0].rate, taxPrinted: true, taxGroups: groups, tip, checks };
    }
    const paid = withUntaxed > 0 ? withUntaxed : (afterDeduction ?? bill);
    if (noTotal || (model !== null && model !== paid && !(tipCents !== undefined && model === paid + tipCents))) checks.push('total_conflict');
    if (paid !== bill) {
      // The rate is printed; the net is the total less the tax where the tax
      // still stands, and left to the rate where a deduction changed it.
      const net = withUntaxed > 0 ? euros(paid - taxSum) : null;
      return { gross: euros(paid), basis, net, taxRate: groups[0].rate, taxPrinted: true, taxGroups: withUntaxed > 0 ? groups : [], tip, checks };
    }
  } else {
    // Largest first: the total is the largest amount a printed tax amount fits.
    const withTax =
      german && !zeroTaxStated
        ? grossWithTax(
            values,
            rates,
            // The total the invoice names as its own is tried first: the largest amount can be the sum to pay with an earlier balance.
            unnamed
              .filter((v) => v <= SANE_TOTAL_CENTS && !tipOnLine.includes(v))
              .sort((x, y) => (y === invoiceTotal?.cents ? 1 : 0) - (x === invoiceTotal?.cents ? 1 : 0) || y - x),
            discounts,
            admits,
          )
        : null;
    if (withTax && invoiceTotal !== undefined && invoiceTotal.cents > cents(withTax.gross) && zeroRatedPart && gapPrinted(invoiceTotal.cents - cents(withTax.gross))) {
      if (noTotal || (pageTotal !== null && pageTotal !== invoiceTotal.cents)) checks.push('total_conflict');
      const tax = cents(withTax.tax);
      return { gross: euros(invoiceTotal.cents), basis: 'gross_with_tax', net: euros(invoiceTotal.cents - tax), taxRate: withTax.rate, taxPrinted: true, taxGroups: [withTax], tip, checks };
    } else if (withTax) {
      groups = [withTax];
      gross = withTax.gross;
      basis = 'gross_with_tax';
      // The page reading names another total, or none: the printed pair stands and a person looks.
      if (noTotal || (pageTotal !== null && pageTotal !== cents(withTax.gross))) checks.push('total_conflict');
    } else if (pageProof && pageTotal !== null) {
      gross = euros(pageTotal);
      basis = 'page_proof';
      stated = pageProof;
    } else if (labelled.length > 0 && model !== null && model !== labelled[labelled.length - 1] && labelled.includes(model) && readStated(labelled[labelled.length - 1])) {
      // The second reading names a labelled amount, but not the last one, and
      // the last one is borne out by the net and tax stated next to their
      // labels: the receipt's arithmetic stands, and a person looks.
      gross = euros(labelled[labelled.length - 1]);
      basis = 'label_stated';
      stated = readStated(labelled[labelled.length - 1]);
      checks.push('total_conflict');
    } else if (labelled.length > 0 && model !== null && labelled.includes(model)) {
      // The second reading agrees with a labelled amount. Where a larger one
      // is labelled further down, a model that read the text alone agreed with
      // a column heading or a part ("Total" above the line items): the last
      // labelled total stands. A model that saw the page saw which of the two
      // is the total (an invoice that prints its total above a usage table
      // with a "Total" of its own): its reading stands. Either way two
      // readings name different amounts, and a person looks.
      const last = labelled[labelled.length - 1];
      const part = labelled.slice(labelled.lastIndexOf(model) + 1).some((later) => later > model);
      const taken = part && !sawPage ? last : model;
      gross = euros(taken);
      basis = 'label_agreed';
      stated = readStated(taken);
      if (part) checks.push('total_conflict');
    } else if (labelled.length > 0 && readStated(labelled[labelled.length - 1])) {
      // A receipt that states net, tax and total and whose three figures add up
      // has confirmed its own total, at whatever rate its country uses.
      gross = euros(labelled[labelled.length - 1]);
      basis = 'label_stated';
      stated = readStated(labelled[labelled.length - 1]);
      if (noTotal || (sawPage && model !== null)) checks.push('total_conflict');
    } else if (labelled.length > 0) {
      // The last labelled total is the one after discounts and shipping.
      const pick = labelled[labelled.length - 1];
      if (discountConfirms(text, pick)) {
        // Subtotal less discount is this total: the receipt has confirmed it itself.
        gross = euros(pick);
        basis = 'label_discount';
        if (noTotal || (model !== null && model !== pick)) checks.push('total_conflict');
      } else if (noTotal) {
        // The page states no total and nothing proves the labelled amount (a
        // monthly rate, a deposit): no total is stored rather than a guess.
        checks.push('total_missing');
      } else if (pageTotal !== null) {
        // Nothing proves either reading. The model saw which amount stands next
        // to the label; the text reader only saw the label torn from it.
        gross = euros(pageTotal);
        basis = 'page_reading';
        checks.push('total_conflict');
      } else {
        gross = euros(pick);
        basis = 'label_alone';
        checks.push(model !== null && model !== pick ? 'total_conflict' : 'total_unconfirmed');
      }
    } else if (model !== null && values.has(model) && model <= SANE_TOTAL_CENTS) {
      gross = euros(model);
      basis = 'model_alone';
      checks.push('total_unconfirmed');
    } else if (sawPage && model !== null && model <= SANE_TOTAL_CENTS && printedAnywhere(text, model)) {
      // Nothing in the text names or proves a total, and the amount the page
      // reading names is printed, though not where the text reader counts
      // money (a booking page). Taken, and put up for a look.
      gross = euros(model);
      basis = 'model_alone';
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

  // The total is settled, but the text names no net and tax for it (their
  // labels are torn off, or the receipt is in another currency and the text
  // reader assumes no rate for it). Where the page gave the net, and net and
  // the tax that leaves are both printed, they are the receipt's own figures:
  // a rate the document prints is stored whatever the currency.
  if (groups.length === 0 && !stated && gross !== null) stated = pageSplit(cents(gross));
  if (groups.length === 0 && stated && gross !== null) {
    return { gross, basis, net: euros(stated.net), taxRate: stated.rate, taxPrinted: true, taxGroups: [], tip, checks };
  }
  if (!german && groups.length === 0) {
    // Another currency. The tax a label names is kept also where it could not
    // confirm the total (a total only the second reading gave, figures that do
    // not add up): the doubt about the total is in the checks.
    const named = gross !== null ? labelledTax(text, cents(gross)) : null;
    if (named) return { gross, basis, net: euros(named.net), taxRate: named.rate, taxPrinted: true, taxGroups: [], tip, checks };
    // No tax amount on the receipt: no German rate is assumed for it (a
    // dollar invoice was given 19 percent). The bill is the net, the rate 0,
    // and nothing here is an estimate that would need a look.
    return { gross, basis, net: gross, taxRate: 0, taxPrinted: false, taxGroups: [], tip, checks };
  }
  const net = groups.length > 0 ? euros(groups.reduce((sum, g) => sum + cents(g.net), 0)) : null;
  const taxRate = groups.length > 0 ? groups[0].rate : null;
  if (gross !== null && groups.length === 0) checks.push('tax_estimated');
  return { gross, basis, net, taxRate, taxPrinted: groups.length > 0, taxGroups: groups, tip, checks };
}
