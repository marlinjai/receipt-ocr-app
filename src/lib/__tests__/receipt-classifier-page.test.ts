import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CATEGORY_TO_KONTO, ZUORDNUNG_OPTIONS } from '@/lib/receipts-constants';
import type { ReceiptPage } from '@/lib/receipt-page';

/**
 * The model call with the page: what is sent, and what happens when the
 * provider is down, slow, refuses the file, declines, or answers nonsense.
 * The provider is replaced; nothing leaves the machine.
 */

const create = vi.fn();
vi.mock('@/lib/ai-client', () => ({
  getAiClient: () => ({ chat: { completions: { create: (...a: unknown[]) => create(...a) } } }),
  getClassifyModel: () => 'test/model',
}));

import { classificationPrompt, classifyReceiptText, parseClassificationResponse, type ClassifyInput } from '../receipt-classifier';

const PDF: ReceiptPage = { mediaType: 'application/pdf', base64: 'UERG', pagesSent: 5, pagesTotal: 12 };
const PHOTO: ReceiptPage = { mediaType: 'image/jpeg', base64: 'SlBFRw==' };

const input = (page: ReceiptPage | null): ClassifyInput => ({
  vendor: 'Example Cloud',
  gross: 20,
  date: '2025-03-03T00:00:00.000Z',
  fullText: 'Example Cloud Inc.\nTotal\n$20.00',
  categoryNames: Object.keys(CATEGORY_TO_KONTO),
  categoryToKonto: CATEGORY_TO_KONTO,
  zuordnungOptions: ZUORDNUNG_OPTIONS,
  page,
});

const ANSWER = {
  name: 'Hosting, Example Cloud', vendor: 'Example Cloud', gross: 20, totalStated: true, net: null, currency: 'usd', date: '2025-03-03',
  category: 'Software & Lizenzen', konto: '4806', zuordnung: null, taxRate: 0, taxLines: [], confidence: 0.9, reasoning: '',
};
const completion = (content: string, extra: Record<string, unknown> = {}) => ({
  choices: [{ finish_reason: 'stop', message: { content }, ...extra }],
  usage: { prompt_tokens: 3100, completion_tokens: 240, cost: 0.0086 },
});
const providerError = (status: number | undefined, name = 'APIError') => Object.assign(new Error(`provider error ${status ?? 'timeout'}`), { status, name });

type Sent = { messages: Array<{ role: string; content: unknown }>; plugins?: unknown; model: string };
const sent = (call = 0) => create.mock.calls[call][0] as Sent;
const userParts = (call = 0) => sent(call).messages[1].content as Array<Record<string, unknown>>;

beforeEach(() => {
  create.mockReset();
  vi.stubEnv('ANTHROPIC_API_KEY', '');
  vi.stubEnv('OPENROUTER_API_KEY', 'test-key');
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'info').mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('classifyReceiptText with the page', () => {
  it('sends the pages of a PDF as a file, pinned to the model\'s own reading of it, before the recognized text', async () => {
    create.mockResolvedValue(completion(JSON.stringify(ANSWER)));
    const result = await classifyReceiptText(input(PDF));
    expect(userParts()[0]).toEqual({ type: 'file', file: { filename: 'receipt.pdf', file_data: 'data:application/pdf;base64,UERG' } });
    expect(userParts()[1]).toMatchObject({ type: 'text' });
    expect(String(userParts()[1].text)).toContain('Recognized text:\nExample Cloud Inc.');
    expect(sent().plugins).toEqual([{ id: 'file-parser', pdf: { engine: 'native' } }]);
    expect(result).toMatchObject({ sawPage: true, provider: 'openrouter', gross: 20, currency: 'USD', date: '2025-03-03T00:00:00.000Z', noTotal: false });
    expect(result.usage).toEqual({ inputTokens: 3100, outputTokens: 240, cost: 0.0086 });
  });

  it('sends a photo as an image, without the PDF parser setting', async () => {
    create.mockResolvedValue(completion(JSON.stringify(ANSWER)));
    await classifyReceiptText(input(PHOTO));
    expect(userParts()[0]).toEqual({ type: 'image_url', image_url: { url: 'data:image/jpeg;base64,SlBFRw==' } });
    expect(sent().plugins).toBeUndefined();
  });

  it('bounds the wait: a timeout and one retry on every call', async () => {
    create.mockResolvedValue(completion(JSON.stringify(ANSWER)));
    await classifyReceiptText(input(PHOTO));
    expect(create.mock.calls[0][1]).toEqual({ timeout: 60_000, maxRetries: 1 });
  });

  it('without a page it reads the text alone and says so', async () => {
    create.mockResolvedValue(completion(JSON.stringify(ANSWER)));
    const result = await classifyReceiptText(input(null));
    expect(userParts()).toHaveLength(1);
    expect(result.sawPage).toBe(false);
  });

  it('a file the provider does not take costs one more call with the text alone', async () => {
    create.mockRejectedValueOnce(providerError(400, 'BadRequestError')).mockResolvedValueOnce(completion(JSON.stringify(ANSWER)));
    const result = await classifyReceiptText(input(PDF));
    expect(create).toHaveBeenCalledTimes(2);
    expect(userParts(1)).toHaveLength(1);
    expect(sent(1).plugins).toBeUndefined();
    expect(result).toMatchObject({ sawPage: false, category: 'Software & Lizenzen' });
  });

  it('provider down, a timeout, no credit, a rate limit: the error surfaces, nothing is asked twice', async () => {
    for (const status of [500, 503, undefined, 401, 402, 429]) {
      create.mockReset();
      create.mockRejectedValue(providerError(status, status === undefined ? 'APIConnectionTimeoutError' : 'APIError'));
      await expect(classifyReceiptText(input(PDF))).rejects.toThrow(/provider error/);
      expect(create).toHaveBeenCalledTimes(1);
    }
  });

  it('a failure without a page is not retried', async () => {
    create.mockRejectedValue(providerError(400));
    await expect(classifyReceiptText(input(null))).rejects.toThrow();
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('a refusal is a failure, never an empty classification', async () => {
    create.mockResolvedValue({ choices: [{ finish_reason: 'content_filter', message: { content: '' } }], usage: {} });
    await expect(classifyReceiptText(input(PHOTO))).rejects.toThrow(/declined/);
    create.mockResolvedValue({ choices: [{ finish_reason: 'stop', message: { content: null, refusal: 'I cannot help with that.' } }], usage: {} });
    await expect(classifyReceiptText(input(PHOTO))).rejects.toThrow(/declined/);
  });

  it('an answer that is no JSON object yields no category, which the caller records as not classified', async () => {
    create.mockResolvedValue(completion('I am sorry, I could not read this document.'));
    const result = await classifyReceiptText(input(PHOTO));
    expect(result).toMatchObject({ category: null, gross: null, date: null, noTotal: false, sawPage: true });
  });

  it('never logs anything of the document', async () => {
    create.mockRejectedValueOnce(providerError(400)).mockResolvedValueOnce(completion('not json Example Cloud Inc. $20.00'));
    await classifyReceiptText(input(PDF));
    const logged = JSON.stringify([...vi.mocked(console.error).mock.calls, ...vi.mocked(console.info).mock.calls]);
    expect(logged).not.toContain('Example Cloud');
    expect(logged).not.toContain('20.00');
    expect(logged).not.toContain('UERG');
  });
});

describe('classificationPrompt with the page', () => {
  it('tells the model it sees the document, that the text is torn, and that its figures are checked', () => {
    const prompt = classificationPrompt(input(PDF), { webSearch: false });
    expect(prompt).toContain('You are given the document itself (its pages as a PDF)');
    expect(prompt).toContain('Only the first and the last pages are attached (5 of 12)');
    expect(prompt).toContain('a figure that is not printed is discarded');
    expect(classificationPrompt(input(PHOTO), { webSearch: false })).toContain('an image of it');
    expect(classificationPrompt(input(null), { webSearch: false })).not.toContain('You are given the document itself');
  });

  it('asks for the invoice date, the currency, the net and whether a total is stated at all', () => {
    const prompt = classificationPrompt(input(PHOTO), { webSearch: false });
    for (const field of ['"date"', '"currency"', '"net"', '"totalStated"']) expect(prompt).toContain(field);
    expect(prompt).toContain('Never the due date');
    expect(prompt).toContain('a monthly rate is not a total');
    expect(prompt).toContain('"Total" and "Grand Total"');
  });
});

describe('parseClassificationResponse: the facts read from the page', () => {
  const parse = (extra: Record<string, unknown>) => parseClassificationResponse(JSON.stringify({ ...ANSWER, ...extra }), input(null));

  it('reads date, currency and net', () => {
    expect(parse({ net: 16.81, currency: 'EUR', date: '2025-12-31' })).toMatchObject({ net: 16.81, currency: 'EUR', date: '2025-12-31T00:00:00.000Z' });
  });

  it('drops a date that is no day, and a currency that is no code', () => {
    for (const date of ['31.12.2025', '2025-02-30', '2025-13-01', 'March 3, 2025', 20250303, null]) expect(parse({ date }).date).toBeNull();
    for (const currency of ['Euro', '€', '', 12, null]) expect(parse({ currency }).currency).toBeNull();
  });

  it('"no total" only when the model says so and names no total', () => {
    expect(parse({ gross: null, totalStated: false }).noTotal).toBe(true);
    expect(parse({ gross: 49.9, totalStated: false }).noTotal).toBe(false);
    expect(parse({ gross: null, totalStated: true }).noTotal).toBe(false);
    expect(parse({ gross: null }).noTotal).toBe(false);
  });
});

describe('a page without recognized text', () => {
  it('the model is told to read everything from the page and to give null rather than guess', () => {
    const prompt = classificationPrompt({ ...input(PHOTO), fullText: '' }, { webSearch: false });
    expect(prompt).toContain('No text could be recognized');
    expect(prompt).toContain('never a guess');
    expect(classificationPrompt(input(PHOTO), { webSearch: false })).not.toContain('No text could be recognized');
  });
});
