import { afterEach, describe, expect, it, vi } from 'vitest';
import { TextRecognitionError, recognizeText } from '../text-recognition';

/** The recognition service is replaced: what is asked of it, and how its answers become one OcrResult. */

const word = (text: string, x: number, y: number) => ({
  description: text,
  boundingPoly: { vertices: [{ x, y }, { x: x + 40, y }, { x: x + 40, y: y + 10 }, { x, y: y + 10 }] },
});
const page = (text: string, confidence: number) => ({
  textAnnotations: [{ description: text }, word(text.split('\n')[0], 5, 7)],
  fullTextAnnotation: { text, pages: [{ confidence }] },
});
const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

afterEach(() => vi.unstubAllGlobals());

describe('recognizeText', () => {
  it('an image: one request, the full text, the words with their boxes', async () => {
    const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async () => answer({ responses: [page('Musterladen\nSumme 5,00', 0.97)] }));
    vi.stubGlobal('fetch', fetchMock);
    const result = await recognizeText('SU1H', false, 'key');
    expect(String(fetchMock.mock.calls[0][0])).toContain('/v1/images:annotate?key=key');
    const sent = JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body));
    expect(sent.requests[0]).toEqual({ image: { content: 'SU1H' }, features: [{ type: 'DOCUMENT_TEXT_DETECTION' }] });
    expect(result).toEqual({
      fullText: 'Musterladen\nSumme 5,00',
      confidence: 0.97,
      blocks: [{ text: 'Musterladen', boundingBox: { x: 5, y: 7, width: 40, height: 10 }, confidence: 0.97 }],
    });
  });

  it('a PDF: the first five pages, their texts joined, the confidence averaged over pages with text', async () => {
    const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async () => answer({ responses: [{ responses: [page('Seite eins', 0.9), {}, page('Seite drei\nGesamt 9,00', 0.7)] }] }));
    vi.stubGlobal('fetch', fetchMock);
    const result = await recognizeText('UERG', true, 'key');
    expect(String(fetchMock.mock.calls[0][0])).toContain('/v1/files:annotate?key=key');
    const sent = JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body));
    expect(sent.requests[0]).toMatchObject({ inputConfig: { content: 'UERG', mimeType: 'application/pdf' }, pages: [1, 2, 3, 4, 5] });
    expect(result.fullText).toBe('Seite eins\nSeite drei\nGesamt 9,00');
    expect(result.confidence).toBeCloseTo(0.8);
    expect(result.blocks.map((b) => b.text)).toEqual(['Seite eins', 'Seite drei']);
  });

  it('an error status of the service carries its status and its answer to the caller', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => answer({ error: { message: 'quota' } }, 429)));
    const error = await recognizeText('SU1H', false, 'key').catch((e) => e);
    expect(error).toBeInstanceOf(TextRecognitionError);
    expect(error).toMatchObject({ status: 429 });
    expect(error.details).toContain('quota');
  });

  it('an error inside an image answer is an error, not an empty text', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => answer({ responses: [{ error: { message: 'Bad image data.' } }] })));
    await expect(recognizeText('SU1H', false, 'key')).rejects.toThrow('Vision API error: Bad image data.');
  });
});
