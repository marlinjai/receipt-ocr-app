export interface ClassificationRule {
  id: string;
  label: string;
  type: 'vendor' | 'keyword' | 'freetext';
  matchValue: string;
  zuordnung: string;
  categoryOverride?: string;
}

const STORAGE_KEY = 'receipt-ocr-classification-rules';

export function getRules(): ClassificationRule[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

export function saveRules(rules: ClassificationRule[]): void {
  if (typeof window === 'undefined') return;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(rules));
}

export function addRule(rule: Omit<ClassificationRule, 'id'>): ClassificationRule {
  const rules = getRules();
  const newRule: ClassificationRule = {
    ...rule,
    id: crypto.randomUUID(),
  };
  rules.push(newRule);
  saveRules(rules);
  return newRule;
}

export function deleteRule(id: string): void {
  const rules = getRules().filter((r) => r.id !== id);
  saveRules(rules);
}

export function rulesToPromptText(rules: ClassificationRule[]): string {
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
