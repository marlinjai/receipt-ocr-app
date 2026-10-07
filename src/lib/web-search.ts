/**
 * Classify a receipt using Anthropic's API with native web_search tool.
 * The model automatically searches the web for vendor info before classifying.
 *
 * Env vars:
 *   ANTHROPIC_API_KEY — Anthropic API key (required)
 *   ANTHROPIC_CLASSIFY_MODEL — model for classification (default: claude-sonnet-4-6-20250610)
 */

import Anthropic from '@anthropic-ai/sdk';
import { parseMealClassification, type MealClassification } from '@/lib/meals/classify';

const DEFAULT_MODEL = 'claude-sonnet-4-6-20250610';

function getClassifyModel(): string {
  return process.env.ANTHROPIC_CLASSIFY_MODEL || DEFAULT_MODEL;
}

interface ClassifyInput {
  vendor: string | null;
  gross: number | null;
  date: string | null;
  fullText: string;
  categoryNames: string[];
  categoryToKonto: Record<string, string>;
  zuordnungOptions: string[];
  userRules?: string;
}

export interface WebSearchClassificationResult {
  name: string | null;
  category: string | null;
  konto: string | null;
  zuordnung: string | null;
  taxRate: number | null;
  confidence: number;
  reasoning: string;
  /** What could be read about a meal (only meaningful for category Bewirtung). */
  meal: MealClassification;
}

type ParseInput = Pick<ClassifyInput, 'categoryNames' | 'categoryToKonto' | 'zuordnungOptions'>;

/**
 * Parse the model's final text into a classification. Exported so the parser
 * can be tested on its own against recorded answers; every field is validated
 * and anything malformed degrades to null instead of reaching a cell.
 */
export function parseClassificationResponse(text: string, input: ParseInput): WebSearchClassificationResult {
  const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  // The model sometimes wraps the object in a sentence; take the outermost braces.
  const first = cleaned.indexOf('{');
  const last = cleaned.lastIndexOf('}');
  const candidate = first >= 0 && last > first ? cleaned.slice(first, last + 1) : cleaned;
  try {
    const parsed = JSON.parse(candidate);
    return {
      name: typeof parsed.name === 'string' && parsed.name ? parsed.name : null,
      category: input.categoryNames.includes(parsed.category) ? parsed.category : null,
      konto: parsed.konto || (parsed.category ? input.categoryToKonto[parsed.category] : null),
      zuordnung: input.zuordnungOptions.includes(parsed.zuordnung) ? parsed.zuordnung : null,
      taxRate: typeof parsed.taxRate === 'number' ? parsed.taxRate : null,
      confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0.5,
      reasoning: parsed.reasoning || '',
      meal: parseMealClassification(parsed),
    };
  } catch {
    console.error('[classifyWithWebSearch] Failed to parse response:', cleaned.slice(0, 500));
    return {
      name: null, category: null, konto: null, zuordnung: null, taxRate: null, confidence: 0,
      reasoning: 'Failed to parse classification response',
      meal: parseMealClassification(null),
    };
  }
}

export async function classifyWithWebSearch(
  input: ClassifyInput,
): Promise<WebSearchClassificationResult> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY is not configured');
  }

  const client = new Anthropic({ apiKey });

  const systemPrompt = `You are a receipt classification assistant for German business expense tracking (SKR03).

You have access to web_search. You MUST search for the vendor to understand what they sell before classifying. This is mandatory.

After searching, classify the receipt and generate a descriptive name.

1. **Name** — a human-readable summary of what was purchased. Format: "Item/Service description – Vendor – €Amount – DD.MM.YYYY". Lead with the ITEM, not the vendor. Example: "Aquarium Heater 200W – Brightener GmbH – €34.99 – 08.04.2026". If multiple items, pick the most important one or summarize briefly.
2. **Category** — one of: ${input.categoryNames.join(', ')}
3. **Konto** — the SKR03 account number (mapped from category):
${input.categoryNames.map((c) => `   ${c} → ${input.categoryToKonto[c]}`).join('\n')}
4. **Zuordnung** (assignment context) — one of: ${input.zuordnungOptions.join(', ')}
5. **Tax rate**: the German value-added tax rate printed on the receipt. If the receipt shows several rates, give the one with the largest amount here and list all of them in taxLines. Only if none is printed, infer it: 19 standard; 7 for books and public transport; for restaurant and catering FOOD 19 until 31 December 2025 and 7 from 1 January 2026 (drinks always 19); takeaway food 7.
6. **Tax lines**: every tax line printed on the receipt as { "rate": percent, "net": amount, "tax": amount }, exactly as printed. Empty array if the receipt prints none. Never compute or guess a line.

Supermarket and grocery receipts are NOT "Bewirtung", whoever the vendor is. "Bewirtung" is a meal in a restaurant, cafe, bar or from a caterer.

Only when the category is "Bewirtung", also give:
7. **mealType**: "business_meal_external" for a restaurant, cafe, bar or catering meal; "travel_meal" when it is clearly food bought on a trip for one person (station kiosk, motorway services, in-flight); "not_a_meal" if it is not a meal after all. Use null when unsure. You cannot know the guests: never infer them.
8. **consumption**: "dine_in" or "takeaway" if the receipt says so (for example "Im Haus", "Außer Haus", "To go"), else null.
9. **tip**: a tip printed or handwritten on the receipt as a number, else null. Never estimate one.
10. **place**: the restaurant's name and postal address as one line, as printed, else null.

${input.userRules || ''}

After your web search, respond with ONLY a JSON object (no markdown, no explanation):
{ "name": "...", "category": "...", "konto": "...", "zuordnung": "...", "taxRate": 19, "taxLines": [], "mealType": null, "consumption": null, "tip": null, "place": null, "confidence": 0.0-1.0, "reasoning": "..." }`;

  const userContent = [
    input.vendor && `Vendor: ${input.vendor}`,
    input.gross && `Amount: ${input.gross}`,
    input.date && `Date: ${input.date}`,
    `\nOCR Text (first 2000 chars):\n${input.fullText.slice(0, 2000)}`,
  ]
    .filter(Boolean)
    .join('\n');

  const response = await client.messages.create({
    model: getClassifyModel(),
    max_tokens: 1024,
    system: systemPrompt,
    tools: [
      {
        type: 'web_search_20250305',
        name: 'web_search',
        max_uses: 3,
      },
    ],
    messages: [{ role: 'user', content: userContent }],
  });

  // Extract the final text block from the response (after tool use/results)
  const textBlock = response.content.findLast((block) => block.type === 'text');
  const text = textBlock && 'text' in textBlock ? textBlock.text : '';
  return parseClassificationResponse(text, input);
}
