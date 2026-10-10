/**
 * Classify a receipt from its recognized text with a language model.
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
 *   OPENROUTER_API_KEY, AI_CLASSIFY_MODEL, AI_MODEL: see src/lib/ai-client.ts
 */

import Anthropic from '@anthropic-ai/sdk';
import { getAiClient, getClassifyModel } from '@/lib/ai-client';
import { parseMealClassification, type MealClassification } from '@/lib/meals/classify';

/** A model identifier is used exactly as published: no date suffix. */
const DEFAULT_ANTHROPIC_MODEL = 'claude-sonnet-5-5';
/** How often a paused server-tool turn is resumed before the answer is taken as it is. */
const MAX_RESUMES = 3;
/** The recognized text sent to the model. A till receipt is far shorter; a long invoice keeps its head and its end. */
const TEXT_LIMIT = 6000;
/** How much of that is the end of the text, where a long invoice prints its totals. */
const TEXT_TAIL = 2000;

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
}

export interface ReceiptClassification {
  name: string | null;
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
  /** What could be read about a meal (only meaningful for category Bewirtung). */
  meal: MealClassification;
}

type ParseInput = Pick<ClassifyInput, 'categoryNames' | 'categoryToKonto' | 'zuordnungOptions'>;

function amount(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > 1_000_000) return null;
  return Math.round(value * 100) / 100;
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
    return {
      name: typeof parsed.name === 'string' && parsed.name ? parsed.name : null,
      category,
      // The account follows the category; a number the model made up never reaches a cell.
      konto: category ? (input.categoryToKonto[category] ?? null) : null,
      zuordnung: input.zuordnungOptions.includes(parsed.zuordnung) ? parsed.zuordnung : null,
      taxRate: typeof parsed.taxRate === 'number' && Number.isFinite(parsed.taxRate) ? parsed.taxRate : null,
      confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0.5,
      reasoning: typeof parsed.reasoning === 'string' ? parsed.reasoning : '',
      vendor: vendorName(parsed.vendor),
      gross: amount(parsed.gross),
      meal: parseMealClassification(parsed),
    };
  } catch {
    console.error('[receipt-classifier] the answer was not the expected object');
    return {
      name: null, category: null, konto: null, zuordnung: null, taxRate: null, confidence: 0,
      reasoning: 'Failed to parse classification response',
      vendor: null, gross: null,
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

/** The instructions, identical for both providers apart from the sentence about searching. */
export function classificationPrompt(input: ClassifyInput, options: { webSearch: boolean }): string {
  const search = options.webSearch
    ? 'You have access to web_search. Search for the vendor to understand what they sell before classifying, unless the receipt text already makes it plain.'
    : 'You cannot look anything up. Decide from the receipt text alone and lower "confidence" when the kind of business is not clear from it.';
  return `You are a receipt classification assistant for German business expense tracking (SKR03).

${search}

The text below comes from optical character recognition of a photographed or scanned receipt. It can contain misread characters, lines out of order, and a second printed form on the same page (a German hospitality form, "Bewirtungsbeleg" or "Angaben zum Nachweis der Höhe und der betrieblichen Veranlassung von Bewirtungsaufwendungen", is printed on or stapled to many restaurant receipts).

Classify the receipt and read these facts from it:

1. **name**: a human-readable summary of what was purchased. Format: "Item/Service description, Vendor, €Amount, DD.MM.YYYY". Lead with the ITEM, not the vendor. If there are several items, name the most important one or summarize briefly.
2. **vendor**: the name of the business that issued the receipt, as a customer would call it ("Trattoria Beispiel", "Musterbräu Berlin"). Never a slogan ("Since 2016"), never a product or an extra ("+ mit Haferdrink"), never a bare description ("Indisches"), never a receipt heading ("Rechnung", "Bewirtungsbeleg"). Null when the text does not name it.
3. **gross**: the total the customer had to pay, as a number, exactly as printed (the line labelled Summe, Gesamt, Total, Betrag, zu zahlen, or the sum of the tax lines). Never a receipt number, table number, transaction number, card number or telephone number. An invoice settled from a credit or balance still has its total: give the line "Total", never an amount due of 0. Null when the text does not show a total.
4. **category**: one of: ${input.categoryNames.join(', ')}
5. **konto**: the SKR03 account number (mapped from category):
${input.categoryNames.map((c) => `   ${c} → ${input.categoryToKonto[c]}`).join('\n')}
6. **zuordnung** (who bears the cost): one of ${input.zuordnungOptions.join(', ')}, or null. ${ASSIGNMENT_RULE}
7. **taxRate**: the German value-added tax rate printed on the receipt. If the receipt shows several rates, give the one with the largest amount here and list all of them in taxLines. Only if none is printed, infer it: 19 standard; 7 for books and public transport; for restaurant and catering FOOD 19 until 31 December 2025 and 7 from 1 January 2026 (drinks always 19); takeaway food 7.
8. **taxLines**: every tax line printed on the receipt as { "rate": percent, "net": amount, "tax": amount }, exactly as printed. Empty array if the receipt prints none. Never compute or guess a line.

A meal or drinks in a restaurant, cafe, bar, pub, brewery tap room, snack bar or from a caterer is "Bewirtung", whatever else the vendor's name suggests. Words such as "Tisch", "Bedienung", "Es bediente Sie", "Kellner", "Trinkgeld", "Speisen", "Getränke" and a printed hospitality form are strong signs of it. Supermarket and grocery receipts are NOT "Bewirtung", whoever the vendor is.

Only when the category is "Bewirtung", also give:
9. **mealType**: "business_meal_external" for a restaurant, cafe, bar or catering meal; "travel_meal" when it is clearly food bought on a trip for one person (station kiosk, motorway services, in-flight); "not_a_meal" if it is not a meal after all. Use null when unsure. You cannot know the guests: never infer them.
10. **consumption**: "dine_in" or "takeaway" if the receipt says so (for example "Im Haus", "Außer Haus", "To go"), else null.
11. **tip**: a tip printed or handwritten on the receipt as a number, else null. Never estimate one.
12. **place**: the restaurant's name and postal address as one line, as printed, else null.

${input.userRules || ''}

Respond with ONLY a JSON object (no markdown, no explanation):
{ "name": "...", "vendor": "...", "gross": 0.00, "category": "...", "konto": "...", "zuordnung": null, "taxRate": 19, "taxLines": [], "mealType": null, "consumption": null, "tip": null, "place": null, "confidence": 0.0-1.0, "reasoning": "..." }`;
}

function userContent(input: ClassifyInput): string {
  return [
    input.vendor && `First reading of the vendor (may be wrong): ${input.vendor}`,
    input.gross !== null && `First reading of the total (may be wrong): ${input.gross}`,
    input.date && `Date: ${input.date}`,
    `\nReceipt text:\n${textForModel(input.fullText)}`,
  ]
    .filter(Boolean)
    .join('\n');
}

async function classifyWithAnthropic(apiKey: string, input: ClassifyInput): Promise<string> {
  const client = new Anthropic({ apiKey });
  const messages: Anthropic.MessageParam[] = [{ role: 'user', content: userContent(input) }];
  let text = '';
  for (let attempt = 0; attempt <= MAX_RESUMES; attempt++) {
    const response = await client.messages.create({
      model: process.env.ANTHROPIC_CLASSIFY_MODEL || DEFAULT_ANTHROPIC_MODEL,
      max_tokens: 16000,
      output_config: { effort: 'low' },
      system: classificationPrompt(input, { webSearch: true }),
      tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: 3 }],
      messages,
    });
    if (response.stop_reason === 'refusal') throw new Error('The model declined to classify this receipt.');
    const textBlock = response.content.findLast((block) => block.type === 'text');
    if (textBlock && textBlock.type === 'text') text = textBlock.text;
    // A long-running server-tool turn pauses; sending the content back resumes it.
    if (response.stop_reason !== 'pause_turn') break;
    messages.push({ role: 'assistant', content: response.content });
  }
  return text;
}

async function classifyWithOpenRouter(input: ClassifyInput): Promise<string> {
  const response = await getAiClient().chat.completions.create({
    model: getClassifyModel(),
    max_tokens: 4000,
    messages: [
      { role: 'system', content: classificationPrompt(input, { webSearch: false }) },
      { role: 'user', content: userContent(input) },
    ],
  });
  return response.choices[0]?.message?.content ?? '';
}

/** Classify one receipt. Throws when no provider is configured or the call fails; never returns a guess for a failure. */
export async function classifyReceiptText(input: ClassifyInput): Promise<ReceiptClassification & { provider: ClassifierProvider }> {
  const provider = classifierProvider();
  if (!provider) throw new ClassifierUnavailableError();
  const text =
    provider === 'anthropic_web_search'
      ? await classifyWithAnthropic(process.env.ANTHROPIC_API_KEY!, input)
      : await classifyWithOpenRouter(input);
  return { ...parseClassificationResponse(text, input), provider };
}
