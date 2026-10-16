import { describe, it, expect } from 'vitest';
import {
  RuleInputError,
  matchRules,
  parseBrowserRules,
  rulesToPromptText,
  validateRuleInput,
  type ClassificationRule,
} from '@/lib/classification-rules';

const rule = (over: Partial<ClassificationRule>): ClassificationRule => ({
  id: 'r',
  label: '',
  type: 'vendor',
  matchValue: 'Amazon',
  zuordnung: 'Geschäftlich',
  categoryOverride: null,
  ...over,
});

describe('validateRuleInput', () => {
  it('normalizes a valid rule: text trimmed and spaces folded, empty category as none', () => {
    expect(validateRuleInput({ type: 'vendor', matchValue: '  Deutsche   Bahn ', zuordnung: 'Privat', categoryOverride: '' })).toEqual({
      type: 'vendor',
      matchValue: 'Deutsche Bahn',
      zuordnung: 'Privat',
      categoryOverride: null,
      label: '',
    });
  });

  it('keeps a known category and a label', () => {
    expect(validateRuleInput({ type: 'keyword', matchValue: 'Hotel', zuordnung: 'Universität', categoryOverride: 'Reisekosten', label: 'Tagung' })).toMatchObject({
      categoryOverride: 'Reisekosten',
      label: 'Tagung',
    });
  });

  it.each([
    [{ type: 'regex', matchValue: 'x', zuordnung: 'Privat' }, 'invalid_type'],
    [{ type: 'vendor', matchValue: '   ', zuordnung: 'Privat' }, 'match_value_required'],
    [{ type: 'vendor', matchValue: 'x'.repeat(301), zuordnung: 'Privat' }, 'match_value_too_long'],
    [{ type: 'vendor', matchValue: 'x', zuordnung: 'Halb' }, 'invalid_zuordnung'],
    [{ type: 'vendor', matchValue: 'x', zuordnung: 'Privat', categoryOverride: 'Kaffee' }, 'invalid_category'],
    [null, 'invalid_type'],
  ])('refuses %j with %s', (raw, code) => {
    expect(() => validateRuleInput(raw)).toThrow(RuleInputError);
    try {
      validateRuleInput(raw);
    } catch (e) {
      expect((e as RuleInputError).code).toBe(code);
    }
  });
});

describe('matchRules', () => {
  it('a vendor rule matches the vendor by substring, ignoring case', () => {
    const rules = [rule({ id: 'a', matchValue: 'netflix', zuordnung: 'Privat' })];
    expect(matchRules(rules, { vendor: 'Netflix International B.V.', fullText: '' })).toMatchObject({ zuordnung: 'Privat', category: null });
  });

  it('a keyword rule matches the recognized text', () => {
    const rules = [rule({ type: 'keyword', matchValue: 'Matrikelnummer', zuordnung: 'Universität', categoryOverride: 'Fachliteratur' })];
    expect(matchRules(rules, { vendor: 'Buchhandlung', fullText: 'Ihre MATRIKELNUMMER 123' })).toMatchObject({ zuordnung: 'Universität', category: 'Fachliteratur' });
  });

  it('a vendor rule goes before a keyword rule, and the longest text wins within a kind', () => {
    const rules = [
      rule({ id: 'k', type: 'keyword', matchValue: 'Amazon', zuordnung: 'Privat' }),
      rule({ id: 'short', matchValue: 'Amazon', zuordnung: 'Privat' }),
      rule({ id: 'long', matchValue: 'Amazon Web Services', zuordnung: 'Geschäftlich' }),
    ];
    expect(matchRules(rules, { vendor: 'Amazon Web Services EMEA', fullText: 'Amazon' })?.rule.id).toBe('long');
    expect(matchRules(rules, { vendor: 'Amazon EU', fullText: '' })?.rule.id).toBe('short');
    expect(matchRules(rules, { vendor: 'Händler', fullText: 'via Amazon Marketplace' })?.rule.id).toBe('k');
  });

  it('a freetext rule never applies by itself, and nothing matches without a vendor or text', () => {
    const rules = [rule({ type: 'freetext', matchValue: 'Amazon', zuordnung: 'Privat' })];
    expect(matchRules(rules, { vendor: 'Amazon', fullText: 'Amazon' })).toBeNull();
    expect(matchRules([rule({})], { vendor: null, fullText: '' })).toBeNull();
  });
});

describe('rulesToPromptText', () => {
  it('is empty without rules', () => {
    expect(rulesToPromptText([])).toBe('');
  });

  it('lists every kind, with the category when given', () => {
    const text = rulesToPromptText([
      rule({ matchValue: 'Amazon' }),
      rule({ type: 'keyword', matchValue: 'coffee', zuordnung: 'Privat' }),
      rule({ type: 'freetext', matchValue: 'any hotel receipt', zuordnung: 'Universität', categoryOverride: 'Reisekosten' }),
    ]);
    expect(text).toContain('User classification rules:');
    expect(text).toContain('When vendor matches "Amazon" → Zuordnung: Geschäftlich');
    expect(text).toContain('When receipt contains keyword "coffee" → Zuordnung: Privat');
    expect(text).toContain('Rule: any hotel receipt → Zuordnung: Universität, Category: Reisekosten');
    expect(text.split('\n')).toHaveLength(4);
  });
});

describe('parseBrowserRules', () => {
  it('reads the list the earlier version stored, and nothing from a missing or broken entry', () => {
    expect(parseBrowserRules(JSON.stringify([{ type: 'vendor' }]))).toEqual([{ type: 'vendor' }]);
    expect(parseBrowserRules(null)).toEqual([]);
    expect(parseBrowserRules('{broken')).toEqual([]);
    expect(parseBrowserRules('{"a":1}')).toEqual([]);
  });
});
