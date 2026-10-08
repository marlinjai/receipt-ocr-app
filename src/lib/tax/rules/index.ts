import { RULES_2025 } from './2025';
import { RULES_2026 } from './2026';
import type { FormLine, FormLineKey, YearRules } from './types';

export * from './types';

const RULE_SETS: readonly YearRules[] = [RULES_2025, RULES_2026];

export const RULE_YEARS: readonly number[] = RULE_SETS.map((r) => r.year);

export interface ResolvedRules {
  rules: YearRules;
  /**
   * False when no rule set exists for the requested year and another year's
   * was used. Every surface that shows a figure must then say which year's
   * rules it was computed with.
   */
  exact: boolean;
}

/**
 * The rule set for a year. A year after the newest rule set gets the newest
 * one, a year before the oldest gets the oldest, both marked as not exact:
 * never a silent substitution, never a crash on 1 January.
 */
export function rulesForYear(year: number): ResolvedRules {
  const exact = RULE_SETS.find((r) => r.year === year);
  if (exact) return { rules: exact, exact: true };
  const sorted = [...RULE_SETS].sort((a, b) => a.year - b.year);
  const fallback = year > sorted[sorted.length - 1].year ? sorted[sorted.length - 1] : sorted[0];
  return { rules: fallback, exact: false };
}

export function formLine(rules: YearRules, key: FormLineKey): FormLine {
  const line = rules.formLines.find((l) => l.key === key);
  // A key missing from a year's catalog is a defect in the rule set, caught by
  // the catalog test; failing loudly beats printing a nameless line.
  if (!line) throw new Error(`Form line ${key} is missing from the ${rules.year} rule set`);
  return line;
}
