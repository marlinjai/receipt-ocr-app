import { describe, expect, it } from 'vitest';
import { CATEGORY_TO_KONTO, ZUORDNUNG_OPTIONS } from '@/lib/receipts-constants';
import { classificationPrompt, classifierProvider, parseClassificationResponse, textForModel, type ClassifyInput } from '../receipt-classifier';

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

describe('the assignment: only what the document shows', () => {
  it('lets the model leave it open and says what each option means', () => {
    const prompt = classificationPrompt(INPUT, { webSearch: false });
    expect(prompt).toContain('one of Universität, Geschäftlich, Privat, or null');
    expect(prompt).toContain('Otherwise null');
    expect(prompt).toContain('a self-employed person is invoiced under their own name');
    expect(prompt).toContain('Never answer "Privat" unless a user classification rule below says so');
    // The answer the model copies from must not suggest an option.
    expect(prompt).toContain('"zuordnung": null');
  });

  it('keeps a rule the user wrote, which is the only source of "Privat"', () => {
    const prompt = classificationPrompt({ ...INPUT, userRules: 'User classification rules:\n- When vendor matches "Kino" → Zuordnung: Privat' }, { webSearch: false });
    expect(prompt.indexOf('Zuordnung: Privat')).toBeGreaterThan(prompt.indexOf('unless a user classification rule below'));
  });

  it('an open assignment stays open, and an option that does not exist never reaches a cell', () => {
    const answer = (zuordnung: unknown) => JSON.stringify({ name: 'x', category: 'Software & Lizenzen', zuordnung, taxRate: 19, confidence: 0.9, reasoning: '' });
    expect(parseClassificationResponse(answer(null), INPUT).zuordnung).toBeNull();
    expect(parseClassificationResponse(answer('Geschäftlich'), INPUT).zuordnung).toBe('Geschäftlich');
    expect(parseClassificationResponse(answer('Private'), INPUT).zuordnung).toBeNull();
    expect(parseClassificationResponse(answer(''), INPUT).zuordnung).toBeNull();
  });

  it('asks for the invoice total where the amount due is zero', () => {
    expect(classificationPrompt(INPUT, { webSearch: false })).toContain('never an amount due of 0');
  });
});

describe('textForModel: what a long invoice keeps', () => {
  it('sends a short text whole', () => {
    expect(textForModel('Cafe\nSumme 5,00')).toBe('Cafe\nSumme 5,00');
    expect(textForModel('x'.repeat(6000))).toHaveLength(6000);
  });

  it('keeps the head and the totals at the end of a long one, and marks the cut', () => {
    const text = `Cursor\nUS$19.22 due October 29, 2025\n${'1\nUS$30.20\nUS$30.20\n'.repeat(500)}Total\nUS$19.22\nAmount due\nUS$19.22`;
    const sent = textForModel(text);
    expect(sent.length).toBeLessThanOrEqual(6010);
    expect(sent.startsWith('Cursor\nUS$19.22 due October 29, 2025')).toBe(true);
    expect(sent.endsWith('Total\nUS$19.22\nAmount due\nUS$19.22')).toBe(true);
    expect(sent).toContain('\n[...]\n');
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
