import 'server-only';
import Anthropic from '@anthropic-ai/sdk';
import type OpenAI from 'openai';
import { getAiClient, getChatModel } from '@/lib/ai-client';
import { classifierProvider } from '@/lib/receipt-classifier';
import { classificationPrompt, classificationRequest, parseModelVerdicts, type DecidedVerdict, type ModelCounterparty } from './classify';

/**
 * The language model that decides counterparties (plan
 * docs/plans/2026-10-25-auto-classify-payments.md, decision 3), behind a port
 * so the tests never call a model. Two ways to reach one, in this order, the
 * same as the receipt reader (`src/lib/receipt-classifier.ts`):
 *
 *  1. Anthropic directly (`ANTHROPIC_API_KEY`), with web search for names that
 *     read as a business;
 *  2. OpenRouter (`OPENROUTER_API_KEY`), same prompt without the search.
 *
 * Env vars:
 *   ANTHROPIC_COUNTERPARTY_MODEL  model for the direct path (default below)
 *   OPENROUTER_API_KEY, AI_MODEL: see src/lib/ai-client.ts
 */

export interface CounterpartyClassifierPort {
  /** The model that answers, stored with each verdict. */
  readonly model: string;
  /** Verdicts for the counterparties asked, by key; a counterparty without a readable answer is missing. Throws when the call fails. */
  classify(counterparties: readonly ModelCounterparty[]): Promise<Map<string, DecidedVerdict>>;
}

const DEFAULT_ANTHROPIC_MODEL = 'claude-opus-5-5';
/** One batch of 20 answers in well under a minute; a turn that searches takes longer. */
const REQUEST_TIMEOUT_MS = 120_000;
const MAX_RETRIES = 1;
/** How often a paused server-tool turn is resumed before the answer is taken as it is. */
const MAX_RESUMES = 3;

/**
 * One call for a group of counterparties. The web search tool is given only
 * when every counterparty of the group may be looked up (`mayLookUp`): a name
 * that may be a private person never reaches a search, whatever the model
 * would do with the instruction.
 */
export async function askAnthropic(client: Pick<Anthropic, 'messages'>, model: string, counterparties: readonly ModelCounterparty[]): Promise<string> {
  const webSearch = counterparties.every((c) => c.mayLookUp);
  const messages: Anthropic.MessageParam[] = [{ role: 'user', content: classificationRequest(counterparties) }];
  let usage = { input: 0, output: 0 };
  for (let attempt = 0; attempt <= MAX_RESUMES; attempt++) {
    const response = await client.messages.create(
      {
        model,
        max_tokens: 16000,
        // Telling a supermarket from a software vendor is not a hard problem.
        output_config: { effort: 'low' },
        system: classificationPrompt({ webSearch }),
        ...(webSearch ? { tools: [{ type: 'web_search_20260209' as const, name: 'web_search' as const, max_uses: 5 }] } : {}),
        messages,
      },
      { timeout: REQUEST_TIMEOUT_MS },
    );
    usage = { input: usage.input + response.usage.input_tokens, output: usage.output + response.usage.output_tokens };
    if (response.stop_reason === 'refusal') throw new Error('The model declined to classify these counterparties.');
    if (response.stop_reason === 'max_tokens') throw new Error('The answer was cut off.');
    // A long-running server-tool turn pauses; sending the content back resumes it.
    if (response.stop_reason === 'pause_turn') {
      messages.push({ role: 'assistant', content: response.content });
      continue;
    }
    // What a batch cost, for the log: counts only, never a name.
    console.info('[payments] classified counterparties', { model, counterparties: counterparties.length, webSearch, inputTokens: usage.input, outputTokens: usage.output });
    const textBlock = response.content.findLast((block) => block.type === 'text');
    return textBlock && textBlock.type === 'text' ? textBlock.text : '';
  }
  throw new Error('The model did not finish its answer.');
}

/** Ask about a batch: the names that may be looked up in one call with web search, the others in one without. */
export async function classifyWithAnthropic(client: Pick<Anthropic, 'messages'>, model: string, counterparties: readonly ModelCounterparty[]): Promise<Map<string, DecidedVerdict>> {
  const out = new Map<string, DecidedVerdict>();
  const groups = [counterparties.filter((c) => c.mayLookUp), counterparties.filter((c) => !c.mayLookUp)].filter((g) => g.length > 0);
  for (const group of groups) {
    for (const [key, verdict] of parseModelVerdicts(await askAnthropic(client, model, group), group.map((c) => c.key))) out.set(key, verdict);
  }
  return out;
}

async function askOpenRouter(counterparties: readonly ModelCounterparty[]): Promise<string> {
  const request: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming & { reasoning?: { effort: 'low' } } = {
    model: getChatModel(),
    max_tokens: 8000,
    reasoning: { effort: 'low' },
    messages: [
      { role: 'system', content: classificationPrompt({ webSearch: false }) },
      { role: 'user', content: classificationRequest(counterparties) },
    ],
  };
  const response = await getAiClient().chat.completions.create(request, { timeout: REQUEST_TIMEOUT_MS, maxRetries: MAX_RETRIES });
  const choice = response.choices[0];
  if (choice?.finish_reason === 'content_filter' || choice?.message?.refusal) throw new Error('The model declined to classify these counterparties.');
  return choice?.message?.content ?? '';
}

/** The classifier of this server, or null when no model is configured (then nothing is decided by a model, and the page says so). */
export function serverCounterpartyClassifier(env: Record<string, string | undefined> = process.env): CounterpartyClassifierPort | null {
  const provider = classifierProvider(env);
  if (provider === 'anthropic_web_search') {
    const model = env.ANTHROPIC_COUNTERPARTY_MODEL || DEFAULT_ANTHROPIC_MODEL;
    const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, maxRetries: MAX_RETRIES });
    return { model, classify: (counterparties) => classifyWithAnthropic(client, model, counterparties) };
  }
  if (provider === 'openrouter') {
    return {
      model: getChatModel(),
      classify: async (counterparties) => parseModelVerdicts(await askOpenRouter(counterparties), counterparties.map((c) => c.key)),
    };
  }
  return null;
}
