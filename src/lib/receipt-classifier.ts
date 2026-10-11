/**
 * Read and classify a receipt with a language model that is given the page
 * itself (the image, or the PDF pages) next to the recognized text.
 *
 * Text recognition returns labels and amounts in separate runs; the page
 * shows which amount stands next to "Total". What the model reads is a second
 * reading: the caller checks every figure against the receipt's arithmetic
 * and the recognized text (src/lib/receipt-reading.ts) and stores none of it
 * on the model's word alone. Without a page (file missing, over the limits)
 * the same call reads the text alone and says so (`sawPage`).
 *
 * Two ways to reach a model, tried in this order:
 *  1. Anthropic directly (`ANTHROPIC_API_KEY`), with the server-side web search
 *     tool, so the model can look the vendor up before it decides.
 *  2. The OpenRouter client the rest of the app uses (`OPENROUTER_API_KEY`),
 *     same prompt without the search.
 *
 * With neither key the call throws `ClassifierUnavailableError`. The caller
 * must make that visible on the receipt: for months production held only the
 * OpenRouter key while this module asked for the Anthropic one, the error was
 * swallowed, and every receipt was filed by pattern matching alone.
 *
 * Env vars:
 *   ANTHROPIC_API_KEY        direct access with web search (optional)
 *   ANTHROPIC_CLASSIFY_MODEL model for the direct path (default below)
 *   ANTHROPIC_ITEM_MODEL     model that names what was bought on an already stored receipt (default below)
 *   OPENROUTER_API_KEY, AI_CLASSIFY_MODEL, AI_MODEL: see src/lib/ai-client.ts
 */

import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { getAiClient, getClassifyModel } from '@/lib/ai-client';
import { cleanItem } from '@/lib/receipt-name';
import type { ReceiptPage } from '@/lib/receipt-page';
import { parseMealClassification, type MealClassification } from '@/lib/meals/classify';

/** A model identifier is used exactly as published: no date suffix. */
const DEFAULT_ANTHROPIC_MODEL = 'claude-sonnet-5-5';
/** Naming what was bought from a stored text is a small task: the small model. */
const DEFAULT_ANTHROPIC_ITEM_MODEL = 'claude-haiku-5-5';
/** How often a paused server-tool turn is resumed before the answer is taken as it is. */
const MAX_RESUMES = 3;
/** The recognized text sent to the model. A till receipt is far shorter; a long invoice keeps its head and its end. */
const TEXT_LIMIT = 6000;
/** How much of that is the end of the text, where a long invoice prints its totals. */
const TEXT_TAIL = 2000;
/** How long one answer may take. Beyond it the receipt is stored with its text reading and says it was not classified. */
const REQUEST_TIMEOUT_MS = 60_000;
/** One more attempt after a connection error or a server error, none after a timeout of the second. */
const MAX_RETRIES = 1;

/**
 * The part of a long text the model gets: the head (vendor, date, the amount
 * due many invoices open with) and the end (the totals block). Cut after the
 * head alone, a usage invoice of three pages reached the model without any
 * total, and it answered with a number from a line item.
 */
export function textForModel(fullText: string): string {
  if (fullText.length <= TEXT_LIMIT) return fullText;
  return `${fullText.slice(0, TEXT_LIMIT - TEXT_TAIL)}\n[...]\n${fullText.slice(-TEXT_TAIL)}`;
}

export class ClassifierUnavailableError extends Error {
  constructor() {
    super('No language model is configured for receipt classification (ANTHROPIC_API_KEY or OPENROUTER_API_KEY).');
    this.name = 'ClassifierUnavailableError';
  }
}

export type ClassifierProvider = 'anthropic_web_search' | 'openrouter';

/** Which provider a classification would use right now, or null when none is configured. */
export function classifierProvider(env: Record<string, string | undefined> = process.env): ClassifierProvider | null {
  if (env.ANTHROPIC_API_KEY) return 'anthropic_web_search';
  if (env.OPENROUTER_API_KEY) return 'openrouter';
  return null;
}

export interface ClassifyInput {
  vendor: string | null;
  gross: number | null;
  date: string | null;
  fullText: string;
  categoryNames: string[];
  categoryToKonto: Record<string, string>;
  zuordnungOptions: string[];
  userRules?: string;
  /** The page itself, when the stored file could be fetched and is within the limits. */
  page?: ReceiptPage | null;
}

/** What one call used, for the log and the evaluation. Never anything of the document. */
export interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
  /** In US dollars, as the provider bills it; null where it does not say. */
  cost: number | null;
}

export interface ReceiptClassification {
  /** What was bought, in a few words, for the receipt's name. Never checked against the text: it states no fact the books use. */
  item: string | null;
  category: string | null;
  konto: string | null;
  zuordnung: string | null;
  taxRate: number | null;
  confidence: number;
  reasoning: string;
  /** The business that issued the receipt, as the model reads it. A second opinion, checked by the caller. */
  vendor: string | null;
  /** The total to pay as printed. A second opinion, checked by the caller against the tax lines. */
  gross: number | null;
  /** The net amount as printed, null when the receipt prints none. */
  net: number | null;
  /** The invoice date as an ISO 8601 instant (midnight UTC of the printed day). Checked by the caller against the dates in the text. */
  date: string | null;
  /** ISO 4217 code of the currency the total is in. */
  currency: string | null;
  /** True when the model says the document states no total to pay at all. */
  noTotal: boolean;
  /** What could be read about a meal (only meaningful for category Bewirtung). */
  meal: MealClassification;
}

type ParseInput = Pick<ClassifyInput, 'categoryNames' | 'categoryToKonto' | 'zuordnungOptions'>;

function amount(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > 1_000_000) return null;
  return Math.round(value * 100) / 100;
}

/** A day as the model was asked to give it, YYYY-MM-DD, as the instant the text reader uses. Null for anything else. */
function invoiceDay(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  if (year < 1990 || year > 2100 || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return date.toISOString();
}

function currencyCode(value: unknown): string | null {
  return typeof value === 'string' && /^[A-Za-z]{3}$/.test(value.trim()) ? value.trim().toUpperCase() : null;
}

function vendorName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const cleaned = value.replace(/\s+/g, ' ').trim();
  return cleaned.length >= 2 && cleaned.length <= 120 ? cleaned : null;
}

/**
 * Parse the model's final text into a classification. Exported so the parser
 * can be tested on its own against recorded answers; every field is validated
 * and anything malformed degrades to null instead of reaching a cell.
 */
export function parseClassificationResponse(text: string, input: ParseInput): ReceiptClassification {
  const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  // The model sometimes wraps the object in a sentence; take the outermost braces.
  const first = cleaned.indexOf('{');
  const last = cleaned.lastIndexOf('}');
  const candidate = first >= 0 && last > first ? cleaned.slice(first, last + 1) : cleaned;
  try {
    const parsed = JSON.parse(candidate);
    const category = input.categoryNames.includes(parsed.category) ? (parsed.category as string) : null;
    const gross = amount(parsed.gross);
    return {
      item: cleanItem(parsed.item),
      category,
      // The account follows the category; a number the model made up never reaches a cell.
      konto: category ? (input.categoryToKonto[category] ?? null) : null,
      zuordnung: input.zuordnungOptions.includes(parsed.zuordnung) ? parsed.zuordnung : null,
      taxRate: typeof parsed.taxRate === 'number' && Number.isFinite(parsed.taxRate) ? parsed.taxRate : null,
      confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0.5,
      reasoning: typeof parsed.reasoning === 'string' ? parsed.reasoning : '',
      vendor: vendorName(parsed.vendor),
      gross,
      net: amount(parsed.net),
      date: invoiceDay(parsed.date),
      currency: currencyCode(parsed.currency),
      // Only an explicit "no total" counts, and never next to a total.
      noTotal: parsed.totalStated === false && gross === null,
      meal: parseMealClassification(parsed),
    };
  } catch {
    console.error('[receipt-classifier] the answer was not the expected object');
    return {
      item: null, category: null, konto: null, zuordnung: null, taxRate: null, confidence: 0,
      reasoning: 'Failed to parse classification response',
      vendor: null, gross: null, net: null, date: null, currency: null, noTotal: false,
      meal: parseMealClassification(null),
    };
  }
}

/**
 * What the model may say about the assignment. A receipt almost never shows
 * who bears its cost, and the prompt once offered the three options with no
 * word on what they mean and no way to leave the field open: the model then
 * filed software subscriptions addressed to a person as "Privat", 65 of 221
 * business invoices in one import. An empty assignment is an open check that
 * someone answers; a wrong "Privat" silently leaves the receipt out of the
 * books. So the model answers only what the document itself shows.
 */
const ASSIGNMENT_RULE =
  'Answer only what the document itself shows. "Geschäftlich" (business) when it is addressed to a company, shows the buyer\'s VAT identification number, or applies reverse charge. "Universität" when it is addressed to a university or names an enrolment or a course of study. Otherwise null: a self-employed person is invoiced under their own name, so a personal addressee, a home address, or the kind of product (music, video, cloud storage, a phone plan) says nothing about who bears the cost. Never answer "Privat" unless a user classification rule below says so.';

/**
 * What was bought, for the receipt's name. A marketplace or a billing platform
 * as the vendor says nothing about the purchase, and one vendor sells several
 * things; the list of line items made names long and different every time, so
 * the model is held to a few words.
 */
export const ITEM_RULE =
  'what was bought, in two to four words, in German, for a list of receipts: the product or the plan by its own name where it has one ("ChatGPT Plus", "Creative Cloud Foto-Abo", "Notion Plus"), otherwise the kind of thing ("SSD-Gehäuse", "Domainverlängerung", "Mobilfunkvertrag", "Deutschlandticket"). With several different line items, the main one and how many more follow ("USB-Stick + 2"). Never the vendor\'s name alone, never an amount, a date, a quantity, an order or invoice number, a period ("Januar 2024") or the name of a person. Null for a meal in a restaurant and when the document does not show what was bought.';

/** What the model is told about what it is looking at. */
function sourceParagraph(page: ReceiptPage | null | undefined): string {
  const ocrCaveat =
    'It can contain misread characters, lines out of order, and a second printed form on the same page (a German hospitality form, "Bewirtungsbeleg" or "Angaben zum Nachweis der Höhe und der betrieblichen Veranlassung von Bewirtungsaufwendungen", is printed on or stapled to many restaurant receipts).';
  if (!page) return `The text below comes from optical character recognition of a photographed or scanned receipt. ${ocrCaveat}`;
  const cut =
    page.pagesTotal !== undefined && page.pagesSent !== undefined && page.pagesSent < page.pagesTotal
      ? ` Only the first and the last pages are attached (${page.pagesSent} of ${page.pagesTotal}).`
      : '';
  return `You are given the document itself (${page.mediaType === 'application/pdf' ? 'its pages as a PDF' : 'an image of it'}) and, below, the text that optical character recognition read from it.${cut} Read amounts, dates and names from the document itself: only there can you see which value stands next to which label. The recognized text returns labels and values in separate runs. ${ocrCaveat} Give every amount and date exactly as printed: your answer is checked against the recognized text, and a figure that is not printed is discarded.`;
}

/** The instructions, identical for both providers apart from the sentence about searching and the one about the page. */
export function classificationPrompt(input: ClassifyInput, options: { webSearch: boolean }): string {
  const search = options.webSearch
    ? 'You have access to web_search. Search for the vendor to understand what they sell before classifying, unless the receipt text already makes it plain.'
    : 'You cannot look anything up. Decide from the receipt alone and lower "confidence" when the kind of business is not clear from it.';
  return `You are a receipt classification assistant for German business expense tracking (SKR03).

${search}

${sourceParagraph(input.page)}

Classify the receipt and read these facts from it:

1. **item**: ${ITEM_RULE}
2. **vendor**: the name of the business that issued the receipt, as a customer would call it ("Trattoria Beispiel", "Musterbräu Berlin"). Never a slogan ("Since 2016"), never a product or an extra ("+ mit Haferdrink"), never a bare description ("Indisches"), never a receipt heading ("Rechnung", "Bewirtungsbeleg"). Null when the text does not name it.
3. **gross**: the total the customer had to pay, as a number, exactly as printed (the line labelled Summe, Gesamt, Total, Betrag, zu zahlen, or the sum of the tax lines). Where several totals are printed (a subtotal, "Total" and "Grand Total", a total per section), give the final one, with tax, shipping and duties. Never a receipt number, table number, transaction number, card number or telephone number. An invoice settled from a credit or balance still has its total: give the line "Total", never an amount due of 0. Null when the document does not show a total.
4. **totalStated**: false when the document states no total to pay at all: an application, a contract or an offer that names only a monthly rate or an instalment, a delivery note without prices. Then "gross" is null: a monthly rate is not a total. Otherwise true.
5. **net**: the amount before tax as a number, exactly as printed. Null when the document prints none. Never compute it.
6. **currency**: the ISO 4217 code of the currency the total is in ("EUR", "USD", "GBP").
7. **date**: the invoice date (the day the document was issued; for a till receipt the day of the purchase) as YYYY-MM-DD. Never the due date, a renewal or expiry date, a delivery date or the start or end of the period billed. Null when the document prints no such date.
8. **category**: one of: ${input.categoryNames.join(', ')}
9. **konto**: the SKR03 account number (mapped from category):
${input.categoryNames.map((c) => `   ${c} → ${input.categoryToKonto[c]}`).join('\n')}
10. **zuordnung** (who bears the cost): one of ${input.zuordnungOptions.join(', ')}, or null. ${ASSIGNMENT_RULE}
11. **taxRate**: the German value-added tax rate printed on the receipt. If the receipt shows several rates, give the one with the largest amount here and list all of them in taxLines. Only if none is printed, infer it: 19 standard; 7 for books and public transport; for restaurant and catering FOOD 19 until 31 December 2025 and 7 from 1 January 2026 (drinks always 19); takeaway food 7.
12. **taxLines**: every tax line printed on the receipt as { "rate": percent, "net": amount, "tax": amount }, exactly as printed. Empty array if the receipt prints none. Never compute or guess a line.

A meal or drinks in a restaurant, cafe, bar, pub, brewery tap room, snack bar or from a caterer is "Bewirtung", whatever else the vendor's name suggests. Words such as "Tisch", "Bedienung", "Es bediente Sie", "Kellner", "Trinkgeld", "Speisen", "Getränke" and a printed hospitality form are strong signs of it. Supermarket and grocery receipts are NOT "Bewirtung", whoever the vendor is.

Only when the category is "Bewirtung", also give:
13. **mealType**: "business_meal_external" for a restaurant, cafe, bar or catering meal; "travel_meal" when it is clearly food bought on a trip for one person (station kiosk, motorway services, in-flight); "not_a_meal" if it is not a meal after all. Use null when unsure. You cannot know the guests: never infer them.
14. **consumption**: "dine_in" or "takeaway" if the receipt says so (for example "Im Haus", "Außer Haus", "To go"), else null.
15. **tip**: a tip printed or handwritten on the receipt as a number, else null. Never estimate one.
16. **place**: the restaurant's name and postal address as one line, as printed, else null.

${input.userRules || ''}

Respond with ONLY a JSON object (no markdown, no explanation):
{ "item": "...", "vendor": "...", "gross": 0.00, "totalStated": true, "net": null, "currency": "EUR", "date": "YYYY-MM-DD", "category": "...", "konto": "...", "zuordnung": null, "taxRate": 19, "taxLines": [], "mealType": null, "consumption": null, "tip": null, "place": null, "confidence": 0.0-1.0, "reasoning": "..." }`;
}

function userText(input: ClassifyInput): string {
  return [
    input.vendor && `First reading of the vendor (may be wrong): ${input.vendor}`,
    input.gross !== null && `First reading of the total (may be wrong): ${input.gross}`,
    input.date && `First reading of the date (may be wrong): ${input.date.slice(0, 10)}`,
    `\n${input.page ? 'Recognized text' : 'Receipt text'}:\n${textForModel(input.fullText)}`,
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * True when the provider refused the request itself (a file it cannot open,
 * a page too large for it) and not the caller: the same receipt is then worth
 * one more call with its text alone. A missing key, an empty balance, a rate
 * limit and a timeout fail the same way without the page, so they are not.
 */
function rejectedTheRequest(err: unknown): boolean {
  const status = (err as { status?: unknown } | null)?.status;
  return typeof status === 'number' && status >= 400 && status < 500 && ![401, 402, 403, 408, 429].includes(status);
}

interface ModelAnswer {
  text: string;
  usage: ModelUsage;
}

async function askAnthropic(apiKey: string, input: ClassifyInput): Promise<ModelAnswer> {
  const client = new Anthropic({ apiKey, maxRetries: MAX_RETRIES });
  const page = input.page;
  const pageBlock: Anthropic.ContentBlockParam[] = !page
    ? []
    : page.mediaType === 'application/pdf'
      ? [{ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: page.base64 } }]
      : [{ type: 'image', source: { type: 'base64', media_type: page.mediaType, data: page.base64 } }];
  const messages: Anthropic.MessageParam[] = [{ role: 'user', content: [...pageBlock, { type: 'text', text: userText(input) }] }];
  const usage: ModelUsage = { inputTokens: 0, outputTokens: 0, cost: null };
  let text = '';
  for (let attempt = 0; attempt <= MAX_RESUMES; attempt++) {
    const response = await client.messages.create(
      {
        model: process.env.ANTHROPIC_CLASSIFY_MODEL || DEFAULT_ANTHROPIC_MODEL,
        max_tokens: 16000,
        output_config: { effort: 'low' },
        system: classificationPrompt(input, { webSearch: true }),
        tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: 3 }],
        messages,
      },
      // A turn that searches takes longer than one that only reads.
      { timeout: 2 * REQUEST_TIMEOUT_MS },
    );
    usage.inputTokens += response.usage.input_tokens;
    usage.outputTokens += response.usage.output_tokens;
    if (response.stop_reason === 'refusal') throw new Error('The model declined to classify this receipt.');
    const textBlock = response.content.findLast((block) => block.type === 'text');
    if (textBlock && textBlock.type === 'text') text = textBlock.text;
    // A long-running server-tool turn pauses; sending the content back resumes it.
    if (response.stop_reason !== 'pause_turn') break;
    messages.push({ role: 'assistant', content: response.content });
  }
  return { text, usage };
}

/** What OpenRouter takes beyond the chat completion parameters of the client library. */
type OpenRouterRequest = OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming & {
  plugins?: Array<{ id: 'file-parser'; pdf: { engine: 'native' } }>;
  reasoning?: { effort: 'low' | 'medium' | 'high' };
  usage?: { include: boolean };
};

async function askOpenRouter(input: ClassifyInput): Promise<ModelAnswer> {
  const page = input.page;
  const pagePart: OpenAI.Chat.Completions.ChatCompletionContentPart[] = !page
    ? []
    : page.mediaType === 'application/pdf'
      ? [{ type: 'file', file: { filename: 'receipt.pdf', file_data: `data:application/pdf;base64,${page.base64}` } }]
      : [{ type: 'image_url', image_url: { url: `data:${page.mediaType};base64,${page.base64}` } }];
  const request: OpenRouterRequest = {
    model: getClassifyModel(),
    max_tokens: 8000,
    // Reading one receipt is not a hard problem; the answer is checked anyway.
    reasoning: { effort: 'low' },
    usage: { include: true },
    messages: [
      { role: 'system', content: classificationPrompt(input, { webSearch: false }) },
      { role: 'user', content: [...pagePart, { type: 'text', text: userText(input) }] },
    ],
    // The model gets the PDF pages themselves. Without this OpenRouter may hand
    // it a text extract instead, which is the torn text all over again.
    ...(page?.mediaType === 'application/pdf' ? { plugins: [{ id: 'file-parser' as const, pdf: { engine: 'native' as const } }] } : {}),
  };
  const response = await getAiClient().chat.completions.create(request, { timeout: REQUEST_TIMEOUT_MS, maxRetries: MAX_RETRIES });
  const choice = response.choices[0];
  if (choice?.finish_reason === 'content_filter' || choice?.message?.refusal) throw new Error('The model declined to classify this receipt.');
  const billed = (response.usage as { cost?: unknown } | undefined)?.cost;
  return {
    text: choice?.message?.content ?? '',
    usage: {
      inputTokens: response.usage?.prompt_tokens ?? 0,
      outputTokens: response.usage?.completion_tokens ?? 0,
      cost: typeof billed === 'number' ? billed : null,
    },
  };
}

export interface ReceiptReadingAnswer extends ReceiptClassification {
  provider: ClassifierProvider;
  /** True when the model was given the page; false when it read the recognized text alone. */
  sawPage: boolean;
  usage: ModelUsage;
}

/**
 * Read and classify one receipt. Throws when no provider is configured or the
 * call fails; never returns a guess for a failure. A page the provider cannot
 * take costs one more call with the text alone, and the answer says so.
 */
export async function classifyReceiptText(input: ClassifyInput): Promise<ReceiptReadingAnswer> {
  const provider = classifierProvider();
  if (!provider) throw new ClassifierUnavailableError();
  const ask = (asked: ClassifyInput) => (provider === 'anthropic_web_search' ? askAnthropic(process.env.ANTHROPIC_API_KEY!, asked) : askOpenRouter(asked));
  let sawPage = Boolean(input.page);
  let answer: ModelAnswer;
  try {
    answer = await ask(input);
  } catch (err) {
    if (!input.page || !rejectedTheRequest(err)) throw err;
    console.error('[receipt-classifier] the provider did not take the page; reading the text alone', { provider, status: (err as { status?: number }).status });
    sawPage = false;
    answer = await ask({ ...input, page: null });
  }
  console.info('[receipt-classifier] read', { provider, sawPage, inputTokens: answer.usage.inputTokens, outputTokens: answer.usage.outputTokens });
  return { ...parseClassificationResponse(answer.text, input), provider, sawPage, usage: answer.usage };
}

/** What the item-only reading is given: the stored text and what the row already holds. */
export interface ItemInput {
  vendor: string | null;
  fullText: string;
}

export function itemPrompt(): string {
  return `You are given the text of one receipt or invoice, as optical character recognition read it. Answer with **item**: ${ITEM_RULE}

Respond with ONLY a JSON object (no markdown, no explanation):
{ "item": "..." }`;
}

/** Parse the answer of the item-only reading. Anything malformed is null: an item is never guessed from a broken answer. */
export function parseItemResponse(text: string): string | null {
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first < 0 || last <= first) return null;
  try {
    return cleanItem((JSON.parse(text.slice(first, last + 1)) as { item?: unknown }).item);
  } catch {
    return null;
  }
}

/**
 * Read only what was bought, from the stored text of a receipt that was read
 * before the item existed. No page, no search and nothing else is asked: the
 * vendor, the total and the date of a stored receipt may have been corrected
 * by a person and are not this call's business. Throws when no provider is
 * configured or the call fails.
 */
export async function readReceiptItem(input: ItemInput): Promise<string | null> {
  const provider = classifierProvider();
  if (!provider) throw new ClassifierUnavailableError();
  const user = [input.vendor && `Vendor: ${input.vendor}`, `\nReceipt text:\n${textForModel(input.fullText)}`].filter(Boolean).join('\n');
  if (provider === 'anthropic_web_search') {
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY!, maxRetries: MAX_RETRIES });
    const response = await client.messages.create(
      { model: process.env.ANTHROPIC_ITEM_MODEL || DEFAULT_ANTHROPIC_ITEM_MODEL, max_tokens: 200, system: itemPrompt(), messages: [{ role: 'user', content: user }] },
      { timeout: REQUEST_TIMEOUT_MS },
    );
    if (response.stop_reason === 'refusal') throw new Error('The model declined to read this receipt.');
    const block = response.content.findLast((b) => b.type === 'text');
    return parseItemResponse(block && block.type === 'text' ? block.text : '');
  }
  const response = await getAiClient().chat.completions.create(
    { model: getClassifyModel(), max_tokens: 200, messages: [{ role: 'system', content: itemPrompt() }, { role: 'user', content: user }] },
    { timeout: REQUEST_TIMEOUT_MS, maxRetries: MAX_RETRIES },
  );
  const choice = response.choices[0];
  if (choice?.finish_reason === 'content_filter' || choice?.message?.refusal) throw new Error('The model declined to read this receipt.');
  return parseItemResponse(choice?.message?.content ?? '');
}
