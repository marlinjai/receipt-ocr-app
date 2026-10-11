import OpenAI from 'openai';

/**
 * AI client factory — uses OpenRouter by default so you can swap models
 * via env vars without code changes.
 *
 * Env vars:
 *   OPENROUTER_API_KEY  — your OpenRouter key (required)
 *   AI_MODEL            — model for chat/tool-use  (default: anthropic/claude-sonnet-4.6)
 *   AI_CLASSIFY_MODEL   — model that reads one receipt, page and text (falls back to AI_MODEL, then to the default below)
 *   AI_BASE_URL         — override base URL (default: https://openrouter.ai/api/v1)
 */

const DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1';
const DEFAULT_MODEL = 'anthropic/claude-sonnet-4.6';
/**
 * The model that reads a receipt. It is given the page (an image, or PDF
 * pages), so it must accept image and file input. Chosen by measurement on
 * the 2025 documents: docs/plans/2026-10-11-vision-reading.md, "Measured".
 */
export const DEFAULT_CLASSIFY_MODEL = 'anthropic/claude-sonnet-5.5';

export function getAiClient(): OpenAI {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error('OPENROUTER_API_KEY is not configured');
  }
  return new OpenAI({
    apiKey,
    baseURL: process.env.AI_BASE_URL || DEFAULT_BASE_URL,
    defaultHeaders: {
      'HTTP-Referer': process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3004',
      'X-Title': 'Receipt OCR App',
    },
  });
}

export function getChatModel(): string {
  return process.env.AI_MODEL || DEFAULT_MODEL;
}

export function getClassifyModel(): string {
  return process.env.AI_CLASSIFY_MODEL || process.env.AI_MODEL || DEFAULT_CLASSIFY_MODEL;
}
