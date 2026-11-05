import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReceiptPage } from '@/lib/receipt-page';

/**
 * The two model calls of the look-alike pass (plan
 * docs/plans/2026-11-05-duplicates-without-asking.md): the number-only reading
 * with the small model, and the comparison of two pages with the strongest
 * one. The provider is replaced; nothing leaves the machine.
 */

const create = vi.fn();
vi.mock('@/lib/ai-client', async (original) => ({
  ...(await original<typeof import('@/lib/ai-client')>()),
  getAiClient: () => ({ chat: { completions: { create: (...a: unknown[]) => create(...a) } } }),
  getClassifyModel: () => 'test/small-model',
}));

import { DEFAULT_DUPLICATE_MODEL, DEFAULT_MODEL, getChatModel, getDuplicateModel } from '@/lib/ai-client';
import {
  ClassifierUnavailableError,
  DEFAULT_ANTHROPIC_DUPLICATE_MODEL,
  UnusableAnswerError,
  judgeSamePurchase,
  parseInvoiceNumberResponse,
  parseSamePurchaseResponse,
  readInvoiceNumberOnly,
  samePurchasePrompt,
  type PairSide,
} from '../receipt-classifier';

const PDF: ReceiptPage = { mediaType: 'application/pdf', base64: 'UERG' };
const PHOTO: ReceiptPage = { mediaType: 'image/jpeg', base64: 'SlBFRw==' };
const completion = (content: string, extra: Record<string, unknown> = {}) => ({
  choices: [{ finish_reason: 'stop', message: { content }, ...extra }],
  usage: { prompt_tokens: 1200, completion_tokens: 40, cost: 0.002 },
});
const providerError = (status: number) => Object.assign(new Error(`provider error ${status}`), { status, name: 'APIError' });
type Sent = { messages: Array<{ role: string; content: unknown }>; model: string; plugins?: unknown };
const sent = (call = 0) => create.mock.calls[call][0] as Sent;
const userParts = (call = 0) => sent(call).messages[1].content as Array<Record<string, unknown>>;

const side = (over: Partial<PairSide> = {}): PairSide => ({ vendor: 'Kiosk Beispiel', date: '2026-01-20', gross: 12.5, currency: 'EUR', invoiceNumber: null, fullText: 'Kiosk Beispiel\nSumme 12,50', page: PHOTO, ...over });

beforeEach(() => {
  create.mockReset();
  vi.stubEnv('ANTHROPIC_API_KEY', '');
  vi.stubEnv('OPENROUTER_API_KEY', 'test-key');
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('the models of the look-alike pass and of the chat', () => {
  it('compares two pages with the strongest model by default, or the one AI_DUPLICATE_MODEL names', () => {
    vi.stubEnv('AI_DUPLICATE_MODEL', '');
    expect(getDuplicateModel()).toBe(DEFAULT_DUPLICATE_MODEL);
    expect(DEFAULT_DUPLICATE_MODEL).toBe('anthropic/claude-opus-5.5');
    expect(DEFAULT_ANTHROPIC_DUPLICATE_MODEL).toBe('claude-opus-5-5');
    vi.stubEnv('AI_DUPLICATE_MODEL', 'some/other-model');
    expect(getDuplicateModel()).toBe('some/other-model');
  });

  it('chats with Sonnet 5.5 unless AI_MODEL says otherwise', () => {
    vi.stubEnv('AI_MODEL', '');
    expect(getChatModel()).toBe(DEFAULT_MODEL);
    expect(DEFAULT_MODEL).toBe('anthropic/claude-sonnet-5.5');
  });
});

describe('readInvoiceNumberOnly', () => {
  it('sends the page and the text to the small model and gives the number unchecked', async () => {
    create.mockResolvedValue(completion('{ "invoiceNumber": "IEN2026004022987" }'));
    const answer = await readInvoiceNumberOnly({ vendor: 'Adobe', fullText: 'Adobe\nIEN2026004022987', page: PDF });
    expect(sent().model).toBe('test/small-model');
    expect(userParts()[0]).toEqual({ type: 'file', file: { filename: 'receipt.pdf', file_data: 'data:application/pdf;base64,UERG' } });
    expect(String(userParts()[1].text)).toContain('Recognized text:\nAdobe');
    expect(sent().plugins).toEqual([{ id: 'file-parser', pdf: { engine: 'native' } }]);
    expect(answer).toMatchObject({ invoiceNumber: 'IEN2026004022987', sawPage: true, model: 'test/small-model' });
  });

  it('reads from the text alone where the provider will not take the page', async () => {
    create.mockRejectedValueOnce(providerError(400)).mockResolvedValueOnce(completion('{ "invoiceNumber": null }'));
    const answer = await readInvoiceNumberOnly({ vendor: null, fullText: 'Kiosk', page: PHOTO });
    expect(answer).toMatchObject({ invoiceNumber: null, sawPage: false });
    expect(userParts(1)).toHaveLength(1);
  });

  it('throws for an answer that is no object, a cut answer, and a provider that is not configured', async () => {
    create.mockResolvedValue(completion('Ich sehe keine Nummer.'));
    await expect(readInvoiceNumberOnly({ vendor: null, fullText: 'Kiosk', page: null })).rejects.toBeInstanceOf(UnusableAnswerError);
    create.mockResolvedValue({ ...completion('{'), choices: [{ finish_reason: 'length', message: { content: '{' } }] });
    await expect(readInvoiceNumberOnly({ vendor: null, fullText: 'Kiosk', page: null })).rejects.toBeInstanceOf(UnusableAnswerError);
    vi.stubEnv('OPENROUTER_API_KEY', '');
    await expect(readInvoiceNumberOnly({ vendor: null, fullText: 'Kiosk', page: null })).rejects.toBeInstanceOf(ClassifierUnavailableError);
  });

  it('parses only a short string with a digit as a number', () => {
    expect(parseInvoiceNumberResponse('{"invoiceNumber":"R-2026-17"}')).toBe('R-2026-17');
    expect(parseInvoiceNumberResponse('{"invoiceNumber":"keine"}')).toBeNull();
    expect(parseInvoiceNumberResponse('{"invoiceNumber":null}')).toBeNull();
  });
});

describe('judgeSamePurchase', () => {
  it('sends both pages, labelled, and the stored facts of both to the strongest model', async () => {
    create.mockResolvedValue(completion('{ "verdict": "same", "confidence": 0.95, "reason": "Beide zeigen dieselben Positionen." }'));
    const answer = await judgeSamePurchase(side({ page: PDF }), side({ invoiceNumber: 'R-17' }));
    expect(sent().model).toBe(DEFAULT_DUPLICATE_MODEL);
    const parts = userParts();
    expect(parts.map((p) => p.type)).toEqual(['text', 'file', 'text', 'image_url', 'text']);
    expect(parts[0].text).toBe('Document A:');
    expect(parts[2].text).toBe('Document B:');
    expect(String(parts[4].text)).toContain('Document B as stored: vendor Kiosk Beispiel, day 2026-01-20, total 12.5 EUR, invoice number R-17.');
    expect(answer).toMatchObject({ verdict: 'same', confidence: 0.95, reason: 'Beide zeigen dieselben Positionen.', model: DEFAULT_DUPLICATE_MODEL });
  });

  it('tells the model that equal totals and days are no proof', () => {
    expect(samePurchasePrompt()).toContain('equal totals and dates alone are no proof');
  });

  it('throws for a refusal, a cut answer and an answer without a verdict: nothing is decided on a failure', async () => {
    create.mockResolvedValue({ ...completion(''), choices: [{ finish_reason: 'content_filter', message: { content: '' } }] });
    await expect(judgeSamePurchase(side(), side())).rejects.toBeInstanceOf(UnusableAnswerError);
    create.mockResolvedValue(completion('{ "verdict": "vielleicht", "confidence": 0.5 }'));
    await expect(judgeSamePurchase(side(), side())).rejects.toBeInstanceOf(UnusableAnswerError);
    create.mockRejectedValue(providerError(503));
    await expect(judgeSamePurchase(side(), side())).rejects.toMatchObject({ status: 503 });
  });

  it('bounds the confidence to 0..1 and shortens the reason to one line', () => {
    expect(parseSamePurchaseResponse('{"verdict":"different","confidence":7,"reason":"A ist um 12:04,\\n B um 18:30."}')).toEqual({ verdict: 'different', confidence: 1, reason: 'A ist um 12:04, B um 18:30.' });
    expect(parseSamePurchaseResponse('{"verdict":"unsure"}')).toEqual({ verdict: 'unsure', confidence: 0, reason: '' });
  });
});
