import { describe, expect, it } from 'vitest';
import { CATEGORY_TO_KONTO, ZUORDNUNG_OPTIONS } from '@/lib/receipts-constants';
import { classificationPrompt, classifierProvider, parseClassificationResponse, type ClassifyInput } from '../receipt-classifier';

const INPUT: ClassifyInput = {
  vendor: 'Since 2016',
  gross: 916752.88,
  date: '2025-03-21T00:00:00.000Z',
  fullText: 'Since 2016\nFantastic Foodbar Inh.\nTotal 37,70',
  categoryNames: Object.keys(CATEGORY_TO_KONTO),
  categoryToKonto: CATEGORY_TO_KONTO,
  zuordnungOptions: ZUORDNUNG_OPTIONS,
};

describe('classifierProvider: which model access a classification uses', () => {
  it('prefers direct access with web search, falls back to the OpenRouter key, and says when there is none', () => {
    expect(classifierProvider({ ANTHROPIC_API_KEY: 'k', OPENROUTER_API_KEY: 'k' })).toBe('anthropic_web_search');
    // Production, 2026-10: only this key is set. Before, that meant no classification at all.
    expect(classifierProvider({ OPENROUTER_API_KEY: 'k' })).toBe('openrouter');
    expect(classifierProvider({})).toBeNull();
    expect(classifierProvider({ ANTHROPIC_API_KEY: '' })).toBeNull();
  });
});

describe('classificationPrompt', () => {
  it('only tells the model to search when it has the tool', () => {
    expect(classificationPrompt(INPUT, { webSearch: true })).toContain('You have access to web_search');
    const offline = classificationPrompt(INPUT, { webSearch: false });
    expect(offline).not.toContain('You have access to web_search');
    expect(offline).toContain('You cannot look anything up');
  });

  it('asks for the business name and the printed total, and names the mistakes to avoid', () => {
    const prompt = classificationPrompt(INPUT, { webSearch: false });
    expect(prompt).toContain('"vendor"');
    expect(prompt).toContain('"gross"');
    expect(prompt).toContain('Never a receipt number');
    expect(prompt).toContain('Since 2016');
    for (const category of INPUT.categoryNames) expect(prompt).toContain(category);
  });
});

describe('parseClassificationResponse: vendor and total as a second opinion', () => {
  const answer = (extra: Record<string, unknown>) => JSON.stringify({ name: 'x', category: 'Bewirtung', konto: '4650', zuordnung: ZUORDNUNG_OPTIONS[0], taxRate: 19, confidence: 0.9, reasoning: '', ...extra });

  it('reads vendor and total', () => {
    const result = parseClassificationResponse(answer({ vendor: '  Fantastic   Foodbar ', gross: 37.7 }), INPUT);
    expect(result).toMatchObject({ vendor: 'Fantastic Foodbar', gross: 37.7, category: 'Bewirtung', konto: '4650' });
  });

  it('drops a vendor or total that is not usable', () => {
    expect(parseClassificationResponse(answer({ vendor: 'x', gross: '37,70' }), INPUT)).toMatchObject({ vendor: null, gross: null });
    expect(parseClassificationResponse(answer({ vendor: 42, gross: -5 }), INPUT)).toMatchObject({ vendor: null, gross: null });
    expect(parseClassificationResponse(answer({ gross: 5_000_000 }), INPUT).gross).toBeNull();
  });

  it('the account always follows the category: a number the model made up never reaches a cell', () => {
    expect(parseClassificationResponse(answer({ konto: '9999' }), INPUT).konto).toBe('4650');
    expect(parseClassificationResponse(answer({ category: 'Erfunden', konto: '9999' }), INPUT)).toMatchObject({ category: null, konto: null });
  });

  it('an answer that is not the expected object yields nothing, not a guess', () => {
    expect(parseClassificationResponse('I could not read this.', INPUT)).toMatchObject({ category: null, vendor: null, gross: null, confidence: 0 });
  });
});
