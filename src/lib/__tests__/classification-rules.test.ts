/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  getRules,
  saveRules,
  addRule,
  deleteRule,
  rulesToPromptText,
  type ClassificationRule,
} from '@/lib/classification-rules';

// ── Mock crypto.randomUUID ───────────────────────────────────────────

let uuidCounter = 0;
vi.stubGlobal('crypto', {
  ...globalThis.crypto,
  randomUUID: () => `test-uuid-${++uuidCounter}`,
});

beforeEach(() => {
  localStorage.clear();
  uuidCounter = 0;
});

// ── getRules ─────────────────────────────────────────────────────────

describe('getRules', () => {
  it('returns empty array when localStorage is empty', () => {
    expect(getRules()).toEqual([]);
  });

  it('returns parsed rules from localStorage', () => {
    const rules: ClassificationRule[] = [
      {
        id: 'r1',
        label: 'Test Rule',
        type: 'vendor',
        matchValue: 'Amazon',
        zuordnung: 'Geschäftlich',
      },
    ];
    localStorage.setItem('receipt-ocr-classification-rules', JSON.stringify(rules));
    expect(getRules()).toEqual(rules);
  });

  it('returns empty array on invalid JSON', () => {
    localStorage.setItem('receipt-ocr-classification-rules', '{broken json');
    expect(getRules()).toEqual([]);
  });
});

// ── saveRules ────────────────────────────────────────────────────────

describe('saveRules', () => {
  it('persists rules to localStorage', () => {
    const rules: ClassificationRule[] = [
      {
        id: 'r1',
        label: 'Test',
        type: 'keyword',
        matchValue: 'coffee',
        zuordnung: 'Privat',
      },
    ];
    saveRules(rules);
    const stored = localStorage.getItem('receipt-ocr-classification-rules');
    expect(stored).toBe(JSON.stringify(rules));
  });
});

// ── addRule ──────────────────────────────────────────────────────────

describe('addRule', () => {
  it('adds a rule with a generated id', () => {
    const newRule = addRule({
      label: 'Starbucks',
      type: 'vendor',
      matchValue: 'Starbucks',
      zuordnung: 'Geschäftlich',
    });

    expect(newRule.id).toBe('test-uuid-1');
    expect(newRule.label).toBe('Starbucks');
    expect(newRule.type).toBe('vendor');
    expect(newRule.matchValue).toBe('Starbucks');
    expect(newRule.zuordnung).toBe('Geschäftlich');
  });

  it('appends to existing rules', () => {
    addRule({
      label: 'Rule A',
      type: 'vendor',
      matchValue: 'A',
      zuordnung: 'Privat',
    });
    addRule({
      label: 'Rule B',
      type: 'keyword',
      matchValue: 'B',
      zuordnung: 'Universität',
    });

    const rules = getRules();
    expect(rules).toHaveLength(2);
    expect(rules[0].label).toBe('Rule A');
    expect(rules[1].label).toBe('Rule B');
  });

  it('preserves categoryOverride when provided', () => {
    const newRule = addRule({
      label: 'Override Test',
      type: 'freetext',
      matchValue: 'any hotel',
      zuordnung: 'Geschäftlich',
      categoryOverride: 'Reisekosten',
    });

    expect(newRule.categoryOverride).toBe('Reisekosten');
    const stored = getRules();
    expect(stored[0].categoryOverride).toBe('Reisekosten');
  });
});

// ── deleteRule ───────────────────────────────────────────────────────

describe('deleteRule', () => {
  it('removes a rule by id', () => {
    const rule = addRule({
      label: 'To Delete',
      type: 'vendor',
      matchValue: 'test',
      zuordnung: 'Privat',
    });

    expect(getRules()).toHaveLength(1);
    deleteRule(rule.id);
    expect(getRules()).toHaveLength(0);
  });

  it('does not affect other rules', () => {
    const ruleA = addRule({
      label: 'A',
      type: 'vendor',
      matchValue: 'a',
      zuordnung: 'Privat',
    });
    addRule({
      label: 'B',
      type: 'keyword',
      matchValue: 'b',
      zuordnung: 'Geschäftlich',
    });

    deleteRule(ruleA.id);
    const remaining = getRules();
    expect(remaining).toHaveLength(1);
    expect(remaining[0].label).toBe('B');
  });

  it('is a no-op for non-existent id', () => {
    addRule({
      label: 'Keep',
      type: 'vendor',
      matchValue: 'keep',
      zuordnung: 'Privat',
    });

    deleteRule('non-existent-id');
    expect(getRules()).toHaveLength(1);
  });
});

// ── rulesToPromptText ────────────────────────────────────────────────

describe('rulesToPromptText', () => {
  it('returns empty string for empty rules array', () => {
    expect(rulesToPromptText([])).toBe('');
  });

  it('formats vendor rule correctly', () => {
    const rules: ClassificationRule[] = [
      {
        id: 'r1',
        label: 'Amazon',
        type: 'vendor',
        matchValue: 'Amazon',
        zuordnung: 'Geschäftlich',
      },
    ];
    const text = rulesToPromptText(rules);
    expect(text).toContain('User classification rules:');
    expect(text).toContain('When vendor matches "Amazon"');
    expect(text).toContain('Zuordnung: Geschäftlich');
  });

  it('formats keyword rule correctly', () => {
    const rules: ClassificationRule[] = [
      {
        id: 'r2',
        label: 'Coffee',
        type: 'keyword',
        matchValue: 'coffee',
        zuordnung: 'Privat',
      },
    ];
    const text = rulesToPromptText(rules);
    expect(text).toContain('When receipt contains keyword "coffee"');
    expect(text).toContain('Zuordnung: Privat');
  });

  it('formats freetext rule correctly', () => {
    const rules: ClassificationRule[] = [
      {
        id: 'r3',
        label: 'Hotel',
        type: 'freetext',
        matchValue: 'any hotel receipt',
        zuordnung: 'Universität',
      },
    ];
    const text = rulesToPromptText(rules);
    expect(text).toContain('Rule: any hotel receipt');
    expect(text).toContain('Zuordnung: Universität');
  });

  it('includes categoryOverride when present', () => {
    const rules: ClassificationRule[] = [
      {
        id: 'r4',
        label: 'Override',
        type: 'vendor',
        matchValue: 'SomeVendor',
        zuordnung: 'Geschäftlich',
        categoryOverride: 'Reisekosten',
      },
    ];
    const text = rulesToPromptText(rules);
    expect(text).toContain('Category: Reisekosten');
  });

  it('does not include Category when categoryOverride is absent', () => {
    const rules: ClassificationRule[] = [
      {
        id: 'r5',
        label: 'No Override',
        type: 'vendor',
        matchValue: 'test',
        zuordnung: 'Privat',
      },
    ];
    const text = rulesToPromptText(rules);
    expect(text).not.toContain('Category:');
  });

  it('formats multiple rules as bullet list', () => {
    const rules: ClassificationRule[] = [
      {
        id: 'r1',
        label: 'A',
        type: 'vendor',
        matchValue: 'VendorA',
        zuordnung: 'Privat',
      },
      {
        id: 'r2',
        label: 'B',
        type: 'keyword',
        matchValue: 'keywordB',
        zuordnung: 'Geschäftlich',
      },
      {
        id: 'r3',
        label: 'C',
        type: 'freetext',
        matchValue: 'free text C',
        zuordnung: 'Universität',
      },
    ];
    const text = rulesToPromptText(rules);
    const lines = text.split('\n');
    // First line is the header
    expect(lines[0]).toBe('User classification rules:');
    // Remaining lines are bullet points
    const bullets = lines.filter((l) => l.startsWith('- '));
    expect(bullets).toHaveLength(3);
  });
});
