import { describe, expect, it } from 'vitest';
import { FORM_LINE_KEYS, RULE_YEARS, formLine, rulesForYear } from '../rules';

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

describe.each(RULE_YEARS)('rule set %i', (year) => {
  const { rules, exact } = rulesForYear(year);

  it('is the exact rule set for its year', () => {
    expect(exact).toBe(true);
    expect(rules.year).toBe(year);
  });

  it('has a catalog entry for every form line key, each key once', () => {
    const keys = rules.formLines.map((l) => l.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const key of FORM_LINE_KEYS) expect(() => formLine(rules, key)).not.toThrow();
  });

  it('never prints the same line number twice on one form', () => {
    for (const form of ['euer', 'employment'] as const) {
      const numbers = rules.formLines.filter((l) => l.form === form && l.line !== null).map((l) => l.line);
      expect(new Set(numbers).size).toBe(numbers.length);
    }
  });

  it('names a source and a check date for every legal value', () => {
    for (const source of [rules.formLinesSource, rules.mealDeductibleShareBp.source]) {
      expect(source.citation.length).toBeGreaterThan(10);
      expect(source.url).toMatch(/^https:\/\//);
      expect(source.checkedOn).toMatch(ISO_DAY);
    }
    expect(rules.reviewedOn).toMatch(ISO_DAY);
  });
});

describe('rulesForYear', () => {
  it('falls back to the nearest rule set and says so', () => {
    const newest = Math.max(...RULE_YEARS);
    const oldest = Math.min(...RULE_YEARS);
    expect(rulesForYear(newest + 3)).toMatchObject({ exact: false, rules: { year: newest } });
    expect(rulesForYear(oldest - 3)).toMatchObject({ exact: false, rules: { year: oldest } });
  });

  // The forcing function for the yearly review: from 1 December the rule set
  // of the coming year has to exist, or every build says so.
  it('has the coming year by 1 December', () => {
    const now = new Date();
    if (now.getUTCMonth() === 11) {
      expect(RULE_YEARS, `add src/lib/tax/rules/${now.getUTCFullYear() + 1}.ts`).toContain(now.getUTCFullYear() + 1);
    }
    expect(RULE_YEARS).toContain(now.getUTCFullYear());
  });
});
