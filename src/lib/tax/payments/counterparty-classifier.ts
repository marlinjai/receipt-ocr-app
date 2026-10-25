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

async function askAnthropic(apiKey: string, model: string, counterparties: readonly ModelCounterparty[]): Promise<string> {
  const client = new Anthropic({ apiKey, maxRetries: MAX_RETRIES });
  const messages: Anthropic.MessageParam[] = [{ role: 'user', content: classificationRequest(counterparties) }];
  let text = '';
  for (let attempt = 0; attempt <= MAX_RESUMES; attempt++) {
    const response = await client.messages.create(
      {
        model,
        max_tokens: 16000,
        // Telling a supermarket from a software vendor is not a hard problem.
        output_config: { effort: 'low' },
        system: classificationPrompt({ webSearch: true }),
        tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: 5 }],
        messages,
      },
      { timeout: REQUEST_TIMEOUT_MS },
    );
    if (response.stop_reason === 'refusal') throw new Error('The model declined to classify these counterparties.');
    if (response.stop_reason === 'max_tokens') throw new Error('The answer was cut off.');
    const textBlock = response.content.findLast((block) => block.type === 'text');
    if (textBlock && textBlock.type === 'text') text = textBlock.text;
    // A long-running server-tool turn pauses; sending the content back resumes it.
    if (response.stop_reason !== 'pause_turn') break;
    messages.push({ role: 'assistant', content: response.content });
  }
  return text;
}

async function askOpenRouter(counterparties: readonly ModelCounterparty[]): Promise<string> {
  const request: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming = {
    model: getChatModel(),
    max_tokens: 8000,
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
    return {
      model,
      classify: async (counterparties) => parseModelVerdicts(await askAnthropic(env.ANTHROPIC_API_KEY as string, model, counterparties), counterparties.map((c) => c.key)),
    };
  }
  if (provider === 'openrouter') {
    return {
      model: getChatModel(),
      classify: async (counterparties) => parseModelVerdicts(await askOpenRouter(counterparties), counterparties.map((c) => c.key)),
    };
  }
  return null;
}
