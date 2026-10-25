import { createHash } from 'node:crypto';
import { ANSWERABLE_CATEGORIES, isSpendingCategory, SPENDING_CATEGORY_LABELS, type SpendingCategory } from '@/lib/spending/categories';
import type { CounterpartyTreatmentAnswer } from '@/lib/spending/rules';
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
  /** The receipts its payments are linked to, by how they are allocated, and their categories. */
  receipts: { business: number; private: number; mixed: number; categories: string[] };
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
export function evidenceFingerprint(evidence: Pick<CounterpartyEvidence, 'receipts' | 'linkedPayments' | 'inCents'>): string {
  const { business, private: priv, mixed, categories } = evidence.receipts;
  // Money coming in changes what the app may decide alone (`capModelVerdict`): its first arrival is new evidence.
  const text = [business, priv, mixed, [...new Set(categories)].sort().join(','), evidence.linkedPayments, evidence.inCents > 0 ? 'in' : ''].join('|');
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

/**
 * The verdict the company's own data gives, without a model: every linked
 * receipt business makes the counterparty business, every one private makes
 * it private. Mixed receipts, or receipts of both kinds, say nothing certain.
 * It is certain only when at least half of the counterparty's payments are
 * linked: one business receipt among hundreds of unlinked purchases at a
 * marketplace is a hint, not a verdict for all of them, and stays a proposal.
 */
export function evidenceVerdict(evidence: CounterpartyEvidence): DecidedVerdict | null {
  const verdict = receiptVerdict(evidence);
  if (!verdict) return null;
  return evidence.linkedPayments * 2 >= evidence.paymentCount ? verdict : { ...verdict, confidence: 'likely' };
}

function receiptVerdict(evidence: CounterpartyEvidence): DecidedVerdict | null {
  const { business, private: priv, mixed } = evidence.receipts;
  if (mixed > 0) return null;
  if (business > 0 && priv === 0) {
    return { treatment: 'business', category: null, confidence: 'certain', reason: business === 1 ? 'Der zugeordnete Beleg ist betrieblich.' : `Alle ${business} zugeordneten Belege sind betrieblich.` };
  }
  if (priv > 0 && business === 0) {
    return { treatment: 'private', category: null, confidence: 'certain', reason: priv === 1 ? 'Der zugeordnete Beleg ist privat.' : `Alle ${priv} zugeordneten Belege sind privat.` };
  }
  return null;
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

A transfer to or from a private person is "private" with category "transfers", at most "likely" unless the texts make the purpose clear. Linked receipts are strong evidence: receipts that are all business mean business. ${options.webSearch ? 'You have web search. Use it only for counterparties marked mayLookUp true, and only when the name alone does not tell you what the business is. Never search for a counterparty marked mayLookUp false.' : 'You have no web search; judge from the name and texts.'}

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
