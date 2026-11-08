import { CATEGORY_OPTIONS, ZUORDNUNG_OPTIONS } from './receipts-constants';

/**
 * Classification rules a person writes for one workspace (company): "this
 * vendor is private", "a receipt that mentions X is university". They live on
 * the server (table `classification_rules`) and apply when a receipt is read:
 *
 *  - a `vendor` rule matches the receipt's vendor by case-insensitive substring;
 *  - a `keyword` rule matches the recognized text by case-insensitive substring;
 *  - a `freetext` rule is never applied by the app itself: it is what the person
 *    states about themselves ("since May 2026 no university"), given to the chat
 *    assistant and to the model that decides who bears a receipt's cost (plan
 *    docs/plans/2026-11-07-learned-assignment.md). It may name no single
 *    assignment ("Amazon is mixed: decide by what was bought"): `zuordnung` null.
 *
 * A match sets the assignment ("Zuordnung") and, when the rule names one, the
 * category. These are READING rules. How a vendor's receipts are taxed is a
 * vendor rule of the finance area (`TaxVendorRule`), which also needs a line of
 * the statement that a reading rule never carries.
 *
 * Pure: shared by the server store, the upload path, the chat route and tests.
 */

export type RuleType = 'vendor' | 'keyword' | 'freetext';
export const RULE_TYPES: readonly RuleType[] = ['vendor', 'keyword', 'freetext'];

export interface ClassificationRule {
  id: string;
  label: string;
  type: RuleType;
  matchValue: string;
  /** Null only for a freetext statement that names no single assignment. */
  zuordnung: string | null;
  categoryOverride?: string | null;
  /**
   * For a freetext statement about one vendor or counterparty ("Was ist das?"), its compared key
   * (`subjectKey`); the statement's text then reads "<name>: <answer>" and `label` holds the answer alone.
   * Absent or null for a statement about the person in general and for every other rule.
   */
  subject?: string | null;
}

export type RuleInput = Omit<ClassificationRule, 'id' | 'subject'>;

/** A "Was ist das?" answer: a few words, like a label. */
export const WHAT_MAX_LENGTH = 120;

/** The key a vendor or counterparty is compared by: lower case, letters and digits only. */
export function subjectKey(name: string | null | undefined): string {
  return (name ?? '').toLocaleLowerCase('de-DE').replace(/[^\p{L}\p{N}]+/gu, '');
}

/** Two subjects that are the same business: equal, or one inside the other where it is long enough. Never two empty ones. */
export function sameSubject(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = subjectKey(a);
  const y = subjectKey(b);
  if (!x || !y) return false;
  return x === y || (x.length >= 4 && y.includes(x)) || (y.length >= 4 && x.includes(y));
}

/** The answer of a statement about a subject, from the statements: the one whose subject is the same business. */
export function whatOf(rules: readonly ClassificationRule[], name: string | null | undefined): string | null {
  const own = rules.find((r) => r.type === 'freetext' && r.subject && sameSubject(r.subject, name));
  return own ? own.label || null : null;
}

export type RuleErrorCode = 'invalid_type' | 'match_value_required' | 'match_value_too_long' | 'invalid_zuordnung' | 'invalid_category';

export class RuleInputError extends Error {
  readonly code: RuleErrorCode;
  constructor(code: RuleErrorCode) {
    super(code);
    this.name = 'RuleInputError';
    this.code = code;
  }
}

const MAX_MATCH_LENGTH = 300;
const MAX_LABEL_LENGTH = 120;

/** Check and normalize a rule from untrusted input (a form, a browser's old storage). */
export function validateRuleInput(raw: unknown): RuleInput {
  const input = (raw ?? {}) as Record<string, unknown>;
  if (typeof input.type !== 'string' || !(RULE_TYPES as readonly string[]).includes(input.type)) throw new RuleInputError('invalid_type');
  const matchValue = typeof input.matchValue === 'string' ? input.matchValue.trim().replace(/\s+/g, ' ') : '';
  if (!matchValue) throw new RuleInputError('match_value_required');
  if (matchValue.length > MAX_MATCH_LENGTH) throw new RuleInputError('match_value_too_long');
  // A statement may name no single assignment; a vendor or keyword rule exists to set one.
  const noAssignment = input.zuordnung === null || input.zuordnung === undefined || input.zuordnung === '';
  if (noAssignment && input.type !== 'freetext') throw new RuleInputError('invalid_zuordnung');
  if (!noAssignment && (typeof input.zuordnung !== 'string' || !ZUORDNUNG_OPTIONS.includes(input.zuordnung))) throw new RuleInputError('invalid_zuordnung');
  const rawCategory = input.categoryOverride;
  let categoryOverride: string | null = null;
  if (rawCategory !== undefined && rawCategory !== null && rawCategory !== '') {
    if (typeof rawCategory !== 'string' || !CATEGORY_OPTIONS.includes(rawCategory)) throw new RuleInputError('invalid_category');
    categoryOverride = rawCategory;
  }
  const label = typeof input.label === 'string' ? input.label.trim().slice(0, MAX_LABEL_LENGTH) : '';
  return { type: input.type as RuleType, matchValue, zuordnung: noAssignment ? null : (input.zuordnung as string), categoryOverride, label };
}

/** The person's statements about themselves: the freetext rules, in the order given. */
export function statementsOf(rules: readonly ClassificationRule[]): ClassificationRule[] {
  return rules.filter((r) => r.type === 'freetext' && r.matchValue.trim() !== '');
}

export interface RuleMatch {
  rule: ClassificationRule;
  zuordnung: string;
  category: string | null;
}

const fold = (text: string) => text.toLocaleLowerCase('de-DE');

/**
 * The rule that applies to a receipt, or null. Vendor rules are asked first
 * (the vendor is the most specific fact), then keyword rules; inside a kind the
 * longest match text wins, so "Amazon Web Services" beats "Amazon".
 */
export function matchRules(rules: readonly ClassificationRule[], receipt: { vendor: string | null; fullText: string }): RuleMatch | null {
  const vendor = receipt.vendor ? fold(receipt.vendor) : '';
  const text = fold(receipt.fullText ?? '');
  const byLength = (a: ClassificationRule, b: ClassificationRule) => b.matchValue.length - a.matchValue.length;
  const hit =
    (vendor ? rules.filter((r) => r.type === 'vendor' && r.zuordnung && vendor.includes(fold(r.matchValue))).sort(byLength)[0] : undefined) ??
    (text ? rules.filter((r) => r.type === 'keyword' && r.zuordnung && text.includes(fold(r.matchValue))).sort(byLength)[0] : undefined);
  if (!hit || !hit.matchValue.trim() || !hit.zuordnung) return null;
  return { rule: hit, zuordnung: hit.zuordnung, category: hit.categoryOverride || null };
}

export function rulesToPromptText(rules: readonly ClassificationRule[]): string {
  if (rules.length === 0) return '';
  const lines = rules.map((r) => {
    let desc = '';
    switch (r.type) {
      case 'vendor':
        desc = `When vendor matches "${r.matchValue}" → Zuordnung: ${r.zuordnung}`;
        break;
      case 'keyword':
        desc = `When receipt contains keyword "${r.matchValue}" → Zuordnung: ${r.zuordnung}`;
        break;
      case 'freetext':
        desc = r.zuordnung ? `Rule: ${r.matchValue} → Zuordnung: ${r.zuordnung}` : `Statement: ${r.matchValue}`;
        break;
    }
    if (r.categoryOverride) desc += `, Category: ${r.categoryOverride}`;
    return `- ${desc}`;
  });
  return `User classification rules:\n${lines.join('\n')}`;
}

/** Where rules lived in the browser before they moved to the server. */
export const BROWSER_RULES_KEY = 'receipt-ocr-classification-rules';
/** The same rules after they were handed to the server once: kept, never read again. */
export const BROWSER_RULES_IMPORTED_KEY = 'receipt-ocr-classification-rules-imported';

/** The rules stored in a browser by the earlier version, as plain values (no validation yet). */
export function parseBrowserRules(raw: string | null): unknown[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
