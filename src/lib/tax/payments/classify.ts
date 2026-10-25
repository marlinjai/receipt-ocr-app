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
  /** Every payment of it is on an account said to be private as a whole. */
  onPrivateAccount: boolean;
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
export function evidenceFingerprint(evidence: Pick<CounterpartyEvidence, 'receipts' | 'onPrivateAccount'>): string {
  const { business, private: priv, mixed, categories } = evidence.receipts;
  const text = [business, priv, mixed, [...new Set(categories)].sort().join(','), evidence.onPrivateAccount ? 'p' : ''].join('|');
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

/**
 * The verdict the company's own data gives, without a model: every linked
 * receipt business makes the counterparty business, every one private makes
 * it private. Mixed receipts, or receipts of both kinds, say nothing certain.
 */
export function evidenceVerdict(evidence: CounterpartyEvidence): DecidedVerdict | null {
  const { business, private: priv, mixed } = evidence.receipts;
  if (mixed > 0) return null;
  if (business > 0 && priv === 0) {
    return { treatment: 'business', category: null, confidence: 'certain', reason: `Alle ${business} zugeordneten Belege sind betrieblich.` };
  }
  if (priv > 0 && business === 0) {
    return { treatment: 'private', category: null, confidence: 'certain', reason: `Alle ${priv} zugeordneten Belege sind privat.` };
  }
  return null;
}

const LEGAL_FORMS = /\b(gmbh|ag|ug|kg|ohg|gbr|ev|e v|se|inc|ltd|llc|limited|corp|corporation|co|bv|nv|sarl|sas|srl|spa|ab|as|oy|plc|pty)\b/;

/**
 * Whether the model may look the counterparty up on the web: only a name
 * that reads as a business (a legal form, a domain, a word with digits), never
 * one that may be a private person, whose name is not sent to a search.
 */
export function mayLookUp(label: string): boolean {
  const name = label.toLowerCase();
  return LEGAL_FORMS.test(name.replace(/\./g, ' ')) || /\.[a-z]{2,}\b/.test(name) || /\d/.test(name);
}

/** The counterparty as the model sees it: no account number, nothing but what is listed here. */
export interface ModelCounterparty {
  key: string;
  name: string;
  payments: number;
  paidEuro: string;
  receivedEuro: string;
  texts: string[];
  privateAccount: boolean;
  linkedReceipts: string;
  mayLookUp: boolean;
}

const euroText = (cents: number) => (cents / 100).toFixed(2);

export function toModelCounterparty(evidence: CounterpartyEvidence): ModelCounterparty {
  const { business, private: priv, mixed, categories } = evidence.receipts;
  const linked = business + priv + mixed;
  return {
    key: evidence.key,
    name: evidence.label,
    payments: evidence.paymentCount,
    paidEuro: euroText(evidence.outCents),
    receivedEuro: euroText(evidence.inCents),
    texts: evidence.samples.slice(0, 3).map((t) => t.slice(0, 140)),
    privateAccount: evidence.onPrivateAccount,
    linkedReceipts: linked === 0 ? 'none' : `${business} business, ${priv} private, ${mixed} mixed; categories: ${[...new Set(categories)].join(', ') || 'none'}`,
    mayLookUp: mayLookUp(evidence.label),
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
  const text = raw.replace(/\s+/g, ' ').replace(/\s*[–—]\s*/g, ', ').trim();
  return text.length > 200 ? `${text.slice(0, 199).trimEnd()}…` : text;
}

/**
 * The model's answer read strictly: only known treatments, categories and
 * confidences, only the keys that were asked, each once. Anything else is
 * dropped, so a counterparty with a garbled answer simply stays undecided and
 * is asked again on a later run. A missing reason makes the verdict at most
 * unsure: nothing is applied without saying why.
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

/** What one run of deciding counterparties did, as `classify-service.ts` reports it. */
export interface ClassifyRunCounts {
  pending: number;
  byEvidence: number;
  byModel: number;
  applied: number;
  unavailable: boolean;
  failedBatches: number;
}

const counted = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** What a run did, in German, for the page that started it; empty when there was nothing to decide. */
export function classifySummary(run: ClassifyRunCounts | null): string {
  if (run === null) return 'Die Gegenseiten konnten nicht eingeordnet werden; bitte gleich noch einmal versuchen.';
  const decided = run.byEvidence + run.byModel;
  const sentences: string[] = [];
  if (decided > 0) {
    sentences.push(`Die App hat ${counted(decided, 'Gegenseite', 'Gegenseiten')} eingeordnet, ${run.applied === decided ? 'alle sicher' : `davon ${run.applied} sicher; die übrigen sind Vorschläge`}.`);
  }
  if (run.unavailable && run.pending > run.byEvidence) {
    sentences.push('Ohne Sprachmodell auf dem Server ordnet die App nur ein, was zugeordnete Belege eindeutig sagen.');
  }
  if (run.failedBatches > 0) sentences.push('Ein Teil konnte gerade nicht eingeordnet werden; beim nächsten Prüfen wird es wieder versucht.');
  const left = run.pending - decided;
  if (!run.unavailable && run.failedBatches === 0 && left > 0) sentences.push(`${counted(left, 'weitere folgt', 'weitere folgen')} beim nächsten Prüfen.`);
  return sentences.join(' ');
}
