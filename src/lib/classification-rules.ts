import { CATEGORY_OPTIONS, ZUORDNUNG_OPTIONS } from './receipts-constants';

/**
 * Classification rules a person writes for one workspace (company): "this
 * vendor is private", "a receipt that mentions X is university". They live on
 * the server (table `classification_rules`) and apply when a receipt is read:
 *
 *  - a `vendor` rule matches the receipt's vendor by case-insensitive substring;
 *  - a `keyword` rule matches the recognized text by case-insensitive substring;
 *  - a `freetext` rule is never applied by the app itself: it is an instruction
 *    for the chat assistant.
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
  zuordnung: string;
  categoryOverride?: string | null;
}

export type RuleInput = Omit<ClassificationRule, 'id'>;

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
  if (typeof input.zuordnung !== 'string' || !ZUORDNUNG_OPTIONS.includes(input.zuordnung)) throw new RuleInputError('invalid_zuordnung');
  const rawCategory = input.categoryOverride;
  let categoryOverride: string | null = null;
  if (rawCategory !== undefined && rawCategory !== null && rawCategory !== '') {
    if (typeof rawCategory !== 'string' || !CATEGORY_OPTIONS.includes(rawCategory)) throw new RuleInputError('invalid_category');
    categoryOverride = rawCategory;
  }
  const label = typeof input.label === 'string' ? input.label.trim().slice(0, MAX_LABEL_LENGTH) : '';
  return { type: input.type as RuleType, matchValue, zuordnung: input.zuordnung, categoryOverride, label };
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
    (vendor ? rules.filter((r) => r.type === 'vendor' && vendor.includes(fold(r.matchValue))).sort(byLength)[0] : undefined) ??
    (text ? rules.filter((r) => r.type === 'keyword' && text.includes(fold(r.matchValue))).sort(byLength)[0] : undefined);
  if (!hit || !hit.matchValue.trim()) return null;
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
        desc = `Rule: ${r.matchValue} → Zuordnung: ${r.zuordnung}`;
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
