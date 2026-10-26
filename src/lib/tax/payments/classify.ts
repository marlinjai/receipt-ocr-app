import { createHash } from 'node:crypto';
import { ANSWERABLE_CATEGORIES, isSpendingCategory, SPENDING_CATEGORY_LABELS, type SpendingCategory } from '@/lib/spending/categories';
import type { CounterpartyTreatmentAnswer } from '@/lib/spending/rules';
import { receiptCandidates, type LoopContext, type LoopPayment } from '@/lib/spending/loop';
import { isTreatment, VERDICT_CONFIDENCES, type VerdictConfidence } from './verdicts';

/**
 * Deciding counterparties without a person (plan
 * docs/plans/2026-10-25-auto-classify-payments.md, decision 3). Pure: what is
 * known about a counterparty, the verdict the company's own data gives, the
 * request to a language model and the strict reading of its answer.
 */

/** What is known about one counterparty, from this company's payments and the receipts linked to them. */
export interface CounterpartyEvidence {
  key: string;
  label: string;
  paymentCount: number;
  outCents: number;
  inCents: number;
  /** Up to three different payment texts, as booked. */
  samples: string[];
  /** How many of its payments are linked to a receipt. */
  linkedPayments: number;
  /**
   * How many of its unlinked payments a receipt of the company fits by vendor,
   * amount and day without anyone having linked them (`pairReceipts`). Counted
   * as evidence like a link; nothing is linked by it.
   */
  matchedPayments: number;
  /** The receipts its payments are linked to or matched with, by how they are allocated, and their categories. */
  receipts: { business: number; private: number; mixed: number; categories: string[] };
  /** How many of its payments of money in are linked to one of the company's own invoices. */
  invoicePayments: number;
  /**
   * The years of its payments whose return is filed, and how many of its
   * payments lie in a year still open. A filed return already says what was
   * business: a payment of a filed year was claimed when a business or split
   * receipt is linked or matched to it, and not claimed otherwise.
   */
  filedYears: number[];
  openYearPayments: number;
}

export interface DecidedVerdict {
  treatment: CounterpartyTreatmentAnswer | null;
  category: SpendingCategory | null;
  confidence: VerdictConfidence;
  reason: string;
}

/**
 * The evidence a verdict rests on, as a short hash: the receipts linked to
 * the counterparty. A verdict is made again only when this changes (a receipt
 * linked or unlinked, its allocation changed), never on every run, and never
 * merely because another payment of the same counterparty arrived.
 */
export function evidenceFingerprint(
  evidence: Pick<CounterpartyEvidence, 'receipts' | 'linkedPayments' | 'inCents'> & Partial<Pick<CounterpartyEvidence, 'matchedPayments' | 'invoicePayments' | 'filedYears' | 'openYearPayments'>>,
): string {
  const { business, private: priv, mixed, categories } = evidence.receipts;
  // Money coming in changes what the app may decide alone (`capModelVerdict`): its first arrival is new evidence.
  const parts: Array<string | number> = [business, priv, mixed, [...new Set(categories)].sort().join(','), evidence.linkedPayments, evidence.inCents > 0 ? 'in' : ''];
  // The evidence added later (plan 2026-10-25-filed-year-decides-counterparties) only joins the text when present,
  // so a counterparty without any of it keeps the fingerprint it was decided on and is not asked about again.
  const matched = evidence.matchedPayments ?? 0;
  const invoices = evidence.invoicePayments ?? 0;
  const filed = evidence.filedYears ?? [];
  if (matched > 0 || invoices > 0 || filed.length > 0) parts.push(matched, invoices, [...filed].sort().join(','), (evidence.openYearPayments ?? 0) > 0 ? 'open' : '');
  const text = parts.join('|');
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

const dayNumber = (day: string | null) => (day === null ? NaN : Math.round(Date.parse(`${day}T00:00:00Z`) / 86_400_000));

/**
 * Which unlinked payment an unlinked receipt pays, where nobody linked them:
 * the receipts the missing-receipt loop would propose for it (`receiptCandidates`:
 * the vendor named, the exact amount, the receipt dated from 60 days before to
 * 5 days after), paired one to one, the closest days first. A monthly bill of
 * the same amount thus pairs each payment with its own month's invoice. Where
 * two pairs are equally close and share a payment or a receipt, neither is
 * taken: a guess is no evidence. Used only as evidence for the counterparty's
 * verdict; nothing is linked by it. Pure.
 */
export function pairReceipts(payments: readonly LoopPayment[], ctx: Pick<LoopContext, 'receipts' | 'vendorAliases'>): Map<string, string> {
  const pairs: Array<{ paymentId: string; rowId: string; gap: number }> = [];
  for (const payment of payments) {
    if (payment.linkCount > 0 || payment.amountCents >= 0) continue;
    for (const c of receiptCandidates(payment, ctx)) pairs.push({ paymentId: payment.id, rowId: c.rowId, gap: Math.abs(dayNumber(payment.bookingDay) - dayNumber(c.day)) });
  }
  pairs.sort((a, b) => a.gap - b.gap || (a.paymentId < b.paymentId ? -1 : a.paymentId > b.paymentId ? 1 : a.rowId < b.rowId ? -1 : 1));
  const byPayment = new Map<string, string>();
  const taken = new Set<string>();
  for (let i = 0; i < pairs.length; ) {
    let j = i;
    while (j < pairs.length && pairs[j].gap === pairs[i].gap) j += 1;
    const open = pairs.slice(i, j).filter((p) => !byPayment.has(p.paymentId) && !taken.has(p.rowId));
    for (const pair of open) {
      const rivals = open.filter((p) => p !== pair && (p.paymentId === pair.paymentId || p.rowId === pair.rowId));
      if (rivals.length > 0 || byPayment.has(pair.paymentId) || taken.has(pair.rowId)) continue;
      byPayment.set(pair.paymentId, pair.rowId);
      taken.add(pair.rowId);
    }
    i = j;
  }
  return byPayment;
}

/**
 * The verdict the company's own data gives, without a model. First hit wins:
 *
 * 1. money in linked to the company's own invoices, and no money out: business;
 * 2. the receipts linked or matched to its payments: all business is business,
 *    all private is private, split or of both kinds is "Teils, teils". Certain
 *    only when at least half of its payments are paid by a receipt: one
 *    business receipt among hundreds of other purchases at a marketplace is a
 *    hint, not a verdict for all of them, and stays a proposal;
 * 3. all its payments lie in years whose return is filed, none of them was
 *    claimed (no business or split receipt) and no money came in: private,
 *    because the filed return did not count it. A transfer to an own account
 *    looks the same here; the run keeps the model's "own account" proposal for
 *    such a counterparty instead (`classifyCounterparties`).
 */
export function evidenceVerdict(evidence: CounterpartyEvidence): DecidedVerdict | null {
  const fromInvoices = invoiceVerdict(evidence);
  if (fromInvoices) return fromInvoices;
  const verdict = receiptVerdict(evidence);
  if (verdict) return (evidence.linkedPayments + evidence.matchedPayments) * 2 >= evidence.paymentCount ? verdict : { ...verdict, confidence: 'likely' };
  return filedVerdict(evidence);
}

function invoiceVerdict(evidence: CounterpartyEvidence): DecidedVerdict | null {
  if (evidence.invoicePayments === 0 || evidence.outCents > 0) return null;
  const reason = evidence.invoicePayments === 1 ? 'Der Eingang bezahlt eine eigene Rechnung.' : `Die ${evidence.invoicePayments} Eingänge bezahlen eigene Rechnungen.`;
  return { treatment: 'business', category: null, confidence: 'certain', reason };
}

function receiptVerdict(evidence: CounterpartyEvidence): DecidedVerdict | null {
  const { business, private: priv, mixed } = evidence.receipts;
  const total = business + priv + mixed;
  if (total === 0) return null;
  if (mixed > 0 || (business > 0 && priv > 0)) {
    return { treatment: 'mixed', category: null, confidence: 'certain', reason: total === 1 ? 'Der Beleg ist zwischen Betrieb und privat geteilt.' : `Die ${total} Belege sind zwischen Betrieb und privat geteilt.` };
  }
  if (business > 0) {
    return { treatment: 'business', category: null, confidence: 'certain', reason: business === 1 ? 'Der zugeordnete Beleg ist betrieblich.' : `Alle ${business} zugeordneten Belege sind betrieblich.` };
  }
  return { treatment: 'private', category: null, confidence: 'certain', reason: priv === 1 ? 'Der zugeordnete Beleg ist privat.' : `Alle ${priv} zugeordneten Belege sind privat.` };
}

function filedVerdict(evidence: CounterpartyEvidence): DecidedVerdict | null {
  if (evidence.filedYears.length === 0 || evidence.openYearPayments > 0 || evidence.inCents > 0) return null;
  if (evidence.receipts.business > 0 || evidence.receipts.mixed > 0) return null;
  const years = [...evidence.filedYears].sort((a, b) => a - b);
  const named = years.length === 1 ? `Erklärung ${years[0]}` : `Erklärungen ${years.slice(0, -1).join(', ')} und ${years[years.length - 1]}`;
  return { treatment: 'private', category: null, confidence: 'certain', reason: `In der abgegebenen ${named} nicht als Betriebsausgabe abgesetzt.` };
}

// Legal forms that are not also short words of a person's name ("as", "ab", "co" are left out on purpose).
const LEGAL_FORMS = /\b(gmbh|ag|ug|kg|ohg|gbr|ev|e v|se|inc|ltd|llc|limited|corp|corporation|bv|nv|sarl|sas|srl|spa|oy|plc|pty)\b/;

/**
 * Whether the model may look the counterparty up on the web: only a name
 * that reads as a business (a legal form, a domain, a word with digits), never
 * one that may be a private person, whose name is not sent to a search.
 */
export function mayLookUp(label: string): boolean {
  const name = label.toLowerCase();
  // An e-mail address names a person as often as a business: never looked up.
  if (name.includes('@')) return false;
  return LEGAL_FORMS.test(name.replace(/\./g, ' ')) || /[a-z0-9-]\.(com|de|io|net|org|ai|app|co|eu|dev)\b/.test(name) || /\b\d{2,}\b/.test(name);
}

/**
 * A payment text as it may be sent: account numbers (an IBAN), card numbers
 * and other runs of digits (mandates, customer numbers) masked, at most 140
 * characters. The vendor's words are what the model needs, never the numbers.
 */
export function maskText(text: string): string {
  return text
    .replace(/[^\s@]+@[^\s@]+\.[a-z]{2,}/gi, '[E-Mail]')
    .replace(/\b[A-Z]{2}\d{2}(?:\s?[A-Z0-9]{4}){2,7}(?:\s?[A-Z0-9]{1,4})?\b/gi, '[Konto]')
    .replace(/\d[\d\s./-]{5,}\d/g, '[Nummer]')
    .slice(0, 140);
}

/** The counterparty as the model sees it: no account number, nothing but what is listed here. */
export interface ModelCounterparty {
  /** Opaque and local to one request ("c1", "c2"): the stored key is derived from the name and never leaves. */
  key: string;
  name: string;
  payments: number;
  paidEuro: string;
  receivedEuro: string;
  texts: string[];
  linkedReceipts: string;
  /** What the filed returns say about it: the person's own decision for those years. */
  filedReturns: string;
  mayLookUp: boolean;
}

const euroText = (cents: number) => (cents / 100).toFixed(2);

/**
 * The counterparty as sent. A name that may be looked up goes to a call with
 * web search, and its payment texts stay home: they can name other people,
 * and only the business's name is what a search needs.
 */
export function toModelCounterparty(evidence: CounterpartyEvidence, requestKey: string): ModelCounterparty {
  const { business, private: priv, mixed, categories } = evidence.receipts;
  const linked = business + priv + mixed;
  const lookUp = mayLookUp(evidence.label);
  return {
    key: requestKey,
    name: maskText(evidence.label),
    payments: evidence.paymentCount,
    paidEuro: euroText(evidence.outCents),
    receivedEuro: euroText(evidence.inCents),
    texts: lookUp ? [] : evidence.samples.slice(0, 3).map(maskText),
    linkedReceipts: linked === 0 ? 'none' : `${business} business, ${priv} private, ${mixed} mixed; categories: ${[...new Set(categories)].join(', ') || 'none'}`,
    filedReturns:
      evidence.filedYears.length === 0
        ? 'none'
        : `${evidence.filedYears.join(', ')} filed; ${business + mixed > 0 ? 'claimed there with its receipts' : 'not claimed as a business expense there'}; ${evidence.openYearPayments} payments in open years`,
    mayLookUp: lookUp,
  };
}

export function classificationPrompt(options: { webSearch: boolean }): string {
  const categories = ANSWERABLE_CATEGORIES.map((c) => `- ${c}: ${SPENDING_CATEGORY_LABELS[c]}`).join('\n');
  return `You classify the counterparties of bank, card, PayPal and Klarna payments for a self-employed person in Germany (a sole proprietor who files an income-surplus statement). Until the end of 2026 business and private money run over the same accounts, so each counterparty must be judged on its own.

For every counterparty decide:
- treatment: "business" (an operating expense or business income: software, hosting, AI tools, business services, clients), "private" (living costs: groceries, restaurants, clothing, leisure, private subscriptions, private persons), "own_account" (money moved between the person's own accounts or savings), or "mixed" (used for both, typically marketplaces like Amazon, phone and internet, a car).
- category: one of
${categories}
- confidence: "certain" only when the name or texts leave no reasonable doubt (a well-known software or AI vendor is business; a supermarket or a restaurant chain is private); "likely" when it is the probable answer but someone could reasonably answer otherwise; "unsure" when you cannot tell, for example a person's name or an unknown shop.
- reason: one short German sentence a non-expert understands, without dashes, naming what the counterparty is (for example "Supermarktkette, Einkauf für den Haushalt").

A transfer to or from a private person is "private" with category "transfers", at most "likely" unless the texts make the purpose clear. Linked receipts are strong evidence: receipts that are all business mean business. "filedReturns" tells what the person already declared in a filed tax return: a counterparty not claimed there was private in those years, which is strong evidence for the open years too unless the name says otherwise. ${options.webSearch ? 'You have web search. Use it only for counterparties marked mayLookUp true, and only when the name alone does not tell you what the business is. Never search for a counterparty marked mayLookUp false.' : 'You have no web search; judge from the name and texts.'}

Answer with JSON only, no prose: {"verdicts":[{"key":"...","treatment":"...","category":"...","confidence":"...","reason":"..."}]} with exactly one entry per counterparty, using the given key.`;
}

export function classificationRequest(counterparties: readonly ModelCounterparty[]): string {
  return `Counterparties:\n${JSON.stringify(counterparties, null, 1)}`;
}

/** A reason as stored and shown: one line, no long dashes, at most 200 characters. */
export function cleanReason(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  const text = raw.replace(/\s+/g, ' ').replace(/\s*[\u2013\u2014]\s*/g, ', ').trim();
  return text.length > 200 ? `${text.slice(0, 199).trimEnd()}…` : text;
}

/**
 * The model's answer read strictly: only known treatments, categories and
 * confidences, only the keys that were asked, each once. Anything else is
 * dropped. The caller decides what a missing entry means (`classify-service`:
 * an answer with no readable entry at all is a failed call, asked again; a
 * single entry missing is stored as unanswered). A missing reason makes the
 * verdict at most unsure: nothing is applied without saying why.
 */
export function parseModelVerdicts(text: string, askedKeys: readonly string[]): Map<string, DecidedVerdict> {
  const out = new Map<string, DecidedVerdict>();
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first < 0 || last <= first) return out;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(first, last + 1));
  } catch {
    return out;
  }
  const list = (parsed as { verdicts?: unknown })?.verdicts;
  if (!Array.isArray(list)) return out;
  const asked = new Set(askedKeys);
  for (const raw of list) {
    const entry = (raw ?? {}) as Record<string, unknown>;
    const key = typeof entry.key === 'string' ? entry.key : '';
    if (!asked.has(key) || out.has(key)) continue;
    if (!isTreatment(entry.treatment)) continue;
    if (!(VERDICT_CONFIDENCES as readonly string[]).includes(entry.confidence as string)) continue;
    const reason = cleanReason(entry.reason);
    const category = isSpendingCategory(entry.category) && entry.category !== 'unclear' ? entry.category : null;
    out.set(key, {
      treatment: entry.treatment,
      category,
      confidence: reason ? (entry.confidence as VerdictConfidence) : 'unsure',
      reason: reason || 'Ohne Begründung geantwortet.',
    });
  }
  return out;
}

/**
 * What of a model's verdict may count by itself. The model never makes a
 * counterparty an own account (own names and the funding rule decide that,
 * and an own account takes its money out of every figure), and a counterparty
 * that paid money IN is never made private or anything but business by the
 * model (a client's payment would stop asking for its invoice). Such a verdict
 * is kept as a proposal: at most likely.
 */
export function capModelVerdict(verdict: DecidedVerdict, evidence: Pick<CounterpartyEvidence, 'inCents'>): DecidedVerdict {
  if (verdict.confidence !== 'certain') return verdict;
  if (verdict.treatment === 'own_account' || (evidence.inCents > 0 && verdict.treatment !== 'business')) return { ...verdict, confidence: 'likely' };
  return verdict;
}
