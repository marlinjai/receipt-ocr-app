import { describe, expect, it } from 'vitest';
import { buildAssignmentContext, sameVendorName, vendorHistoryOf, type CorrectionEntry } from '../context';
import { assignmentFingerprint } from '../fingerprint';
import { assignmentPrompt, assignmentText, assignmentUserText, parseAssignmentResponse, type AssignmentReceipt, type PastAnswer } from '../prompt';
import { OWNER_STATEMENTS } from '../seed';
import { RuleInputError, matchRules, rulesToPromptText, statementsOf, validateRuleInput } from '@/lib/classification-rules';
import { preparePrompts, report, type ExportedReceipt } from '../../../../scripts/assignment-replay';
import { getAssignmentModel } from '@/lib/ai-client';
import { directAssignmentModel } from '@/lib/receipt-classifier';

const OPTIONS = ['Universität', 'Geschäftlich', 'Privat'];
const receipt = (over: Partial<AssignmentReceipt> = {}): AssignmentReceipt => ({ vendor: 'Rossmann', date: '2026-11-06', category: 'Sonstige Ausgaben', item: 'Schokolade', gross: 4.99, currency: 'EUR', lines: [{ text: 'Schokolade', grossCents: 499, kind: 'groceries' }], text: 'Rossmann\nSchokolade 4,99', ...over });
const past = (over: Partial<PastAnswer> = {}): PastAnswer => ({ rowId: 'p1', vendor: 'dm', date: '2026-10-01', category: 'Sonstige Ausgaben', item: 'Zahnpasta', lines: [], assignment: 'Privat', ...over });

describe('parseAssignmentResponse', () => {
  it('takes an option of the workspace, its confidence and the reason', () => {
    expect(parseAssignmentResponse('{"assignment":"Privat","confidence":0.97,"reason":"Drogerie, bisher privat."}', OPTIONS)).toEqual({ assignment: 'Privat', confidence: 0.97, reason: 'Drogerie, bisher privat.' });
  });
  it('matches an option regardless of case and keeps the workspace spelling', () => {
    expect(parseAssignmentResponse('{"assignment":"privat","confidence":0.9,"reason":""}', OPTIONS).assignment).toBe('Privat');
  });
  it('an option the workspace has not is no answer, and carries no confidence', () => {
    expect(parseAssignmentResponse('{"assignment":"Gemischt","confidence":0.99,"reason":"x"}', OPTIONS)).toMatchObject({ assignment: null, confidence: 0 });
  });
  it('null is an answer: the model would not decide', () => {
    expect(parseAssignmentResponse('{"assignment":null,"confidence":0.4,"reason":"Unklar."}', OPTIONS)).toEqual({ assignment: null, confidence: 0, reason: 'Unklar.' });
  });
  it('clamps the confidence and tolerates text around the object', () => {
    expect(parseAssignmentResponse('Antwort: {"assignment":"Geschäftlich","confidence":3,"reason":"a"} fertig', OPTIONS).confidence).toBe(1);
  });
  it('anything malformed throws: nothing is ever set on it', () => {
    expect(() => parseAssignmentResponse('no json', OPTIONS)).toThrow();
    expect(() => parseAssignmentResponse('{"assignment": "Privat",', OPTIONS)).toThrow();
  });
});

describe('the prompt', () => {
  it('names every option of the workspace, and asks for null where nothing settles it', () => {
    const prompt = assignmentPrompt(OPTIONS);
    for (const o of OPTIONS) expect(prompt).toContain(`"${o}"`);
    expect(prompt).toContain('answer null');
  });
  it('gives the receipt and the context, and says so when there is none yet', () => {
    const text = assignmentUserText(receipt(), { statements: [], vendorHistory: null, similar: [], corrections: [] });
    expect(text).toContain('Vendor: Rossmann');
    expect(text).toContain('Schokolade (4.99, groceries)');
    expect(text).toContain('(none yet)');
    expect(text).toContain('(never answered for this vendor)');
  });
  it('cuts a long text but keeps its head and its end', () => {
    const long = `HEAD ${'x'.repeat(5000)} TAIL`;
    const cut = assignmentText(long);
    expect(cut.length).toBeLessThan(long.length);
    expect(cut.startsWith('HEAD')).toBe(true);
    expect(cut.endsWith('TAIL')).toBe(true);
  });
  it('carries no long dash', () => {
    const all = assignmentPrompt(OPTIONS) + assignmentUserText(receipt(), { statements: [], vendorHistory: null, similar: [], corrections: [] }) + OWNER_STATEMENTS.map((s) => s.text).join('');
    expect(all).not.toMatch(/[–—]/);
  });
});

describe('the context the model is given', () => {
  it('counts how the person answered the vendor, with the latest day', () => {
    const history = [past({ rowId: 'a', vendor: 'Rossmann', date: '2026-01-02' }), past({ rowId: 'b', vendor: 'ROSSMANN GmbH', date: '2026-05-02' }), past({ rowId: 'c', vendor: 'Rossmann', assignment: 'Geschäftlich', date: '2026-03-01' })];
    expect(vendorHistoryOf('Rossmann', history)?.answers).toEqual([
      { assignment: 'Privat', count: 2, latest: '2026-05-02' },
      { assignment: 'Geschäftlich', count: 1, latest: '2026-03-01' },
    ]);
  });
  it('never takes two empty vendors for the same one', () => {
    expect(sameVendorName('', '')).toBe(false);
    expect(vendorHistoryOf(null, [past({ vendor: '' })])).toBeNull();
  });
  it('shows the same vendor first, then the same category, never the receipt itself', () => {
    const history = [past({ rowId: 'self', vendor: 'Rossmann' }), past({ rowId: 'v', vendor: 'Rossmann' }), past({ rowId: 'c', vendor: 'Aldi' }), past({ rowId: 'x', vendor: 'Hetzner', category: 'Software & Lizenzen' })];
    const ctx = buildAssignmentContext({ rowId: 'self', vendor: 'Rossmann', category: 'Sonstige Ausgaben' }, history, [], []);
    expect(ctx.similar.map((p) => p.rowId)).toEqual(['v', 'c']);
  });
  it('shows corrections of the same vendor first and never one of the receipt itself', () => {
    const corr = (rowId: string, vendor: string, date: string): CorrectionEntry => ({ rowId, vendor, date, category: null, item: null, modelSaid: 'Privat', how: 'set', personSaid: 'Geschäftlich' });
    const ctx = buildAssignmentContext({ rowId: 'self', vendor: 'Apple', category: null }, [], [], [corr('o', 'Amazon', '2026-10-01'), corr('a', 'Apple', '2026-01-01'), corr('self', 'Apple', '2026-11-01')]);
    expect(ctx.corrections.map((c) => c.vendor)).toEqual(['Apple', 'Amazon']);
    expect(ctx.corrections[0]).not.toHaveProperty('rowId');
  });
});

describe('the fingerprint', () => {
  it('changes with every fact the decision rests on, and with nothing else', () => {
    const base = assignmentFingerprint(receipt());
    expect(assignmentFingerprint(receipt({ gross: 9 }))).toBe(base);
    expect(assignmentFingerprint(receipt({ vendor: 'dm' }))).not.toBe(base);
    expect(assignmentFingerprint(receipt({ item: 'Kabel' }))).not.toBe(base);
    expect(assignmentFingerprint(receipt({ text: 'anders' }))).not.toBe(base);
    expect(assignmentFingerprint(receipt({ lines: [] }))).not.toBe(base);
    expect(assignmentFingerprint(receipt({ category: 'Hardware & IT' }))).not.toBe(base);
    expect(assignmentFingerprint(receipt({ date: '2026-11-07' }))).not.toBe(base);
  });
});

describe('statements: freetext rules may name no single assignment', () => {
  it('a statement without an assignment is valid, a vendor rule without one is not', () => {
    expect(validateRuleInput({ type: 'freetext', matchValue: 'Amazon ist gemischt.', zuordnung: null })).toMatchObject({ zuordnung: null });
    expect(validateRuleInput({ type: 'freetext', matchValue: 'Amazon ist gemischt.', zuordnung: '' })).toMatchObject({ zuordnung: null });
    expect(() => validateRuleInput({ type: 'vendor', matchValue: 'Amazon', zuordnung: null })).toThrow(RuleInputError);
    expect(() => validateRuleInput({ type: 'freetext', matchValue: 'x', zuordnung: 'Gemischt' })).toThrow(RuleInputError);
  });
  it('a statement never matches a receipt, and the chat prompt shows it as a statement', () => {
    const rules = [{ id: '1', label: '', type: 'freetext' as const, matchValue: 'Amazon ist gemischt.', zuordnung: null }];
    expect(matchRules(rules, { vendor: 'Amazon', fullText: 'Amazon ist gemischt.' })).toBeNull();
    expect(statementsOf(rules)).toHaveLength(1);
    expect(rulesToPromptText(rules)).toContain('Statement: Amazon ist gemischt.');
  });
  it('every seed statement passes the checks a typed one passes', () => {
    for (const s of OWNER_STATEMENTS) expect(() => validateRuleInput({ type: 'freetext', matchValue: s.text, zuordnung: s.zuordnung })).not.toThrow();
  });
});

describe('the model settings', () => {
  it('follow their own variables, never the reading or the chat model', () => {
    const before = { ...process.env };
    process.env.AI_CLASSIFY_MODEL = 'reader/x';
    process.env.AI_MODEL = 'chat/x';
    delete process.env.AI_ASSIGNMENT_MODEL;
    expect(getAssignmentModel()).toBe('anthropic/claude-sonnet-5.5');
    process.env.AI_ASSIGNMENT_MODEL = 'assign/x';
    expect(getAssignmentModel()).toBe('assign/x');
    expect(directAssignmentModel({ ANTHROPIC_CLASSIFY_MODEL: 'reader' })).toBe('claude-sonnet-5-5');
    expect(directAssignmentModel({ ANTHROPIC_ASSIGNMENT_MODEL: 'claude-opus-5-5' })).toBe('claude-opus-5-5');
    process.env = before;
  });
});

describe('the replay (plan decision 6)', () => {
  const OWNER = '019fa320-8e10-7978-b0a6-0b0d3bad83c3';
  const exported = (over: Partial<ExportedReceipt>): ExportedReceipt => ({ workspaceId: OWNER, rowId: 'r', createdAt: '2026-01-01T00:00:00Z', vendor: 'Rossmann', date: '2026-01-01', category: 'Sonstige Ausgaben', zuordnung: 'Privat', item: null, text: '', lines: [], taxDecision: false, ...over });

  it('the model sees only what came before a receipt, never its own answer or a later one', () => {
    const { prompts } = preparePrompts(
      [exported({ rowId: 'late', date: '2026-03-01', zuordnung: 'Geschäftlich' }), exported({ rowId: 'early', date: '2026-01-01' }), exported({ rowId: 'mid', date: '2026-02-01' })],
      [],
      [],
    );
    const byId = new Map(prompts.map((p) => [p.id, p]));
    expect(byId.get('early')!.user).toContain('(never answered for this vendor)');
    expect(byId.get('mid')!.user).toContain('"Privat": 1 time, latest 2026-01-01');
    expect(byId.get('late')!.user).toContain('"Privat": 2 times');
    expect(byId.get('late')!.user).not.toContain('Geschäftlich": 1');
    // The owner's seed statements count from the start.
    expect(byId.get('early')!.user).toContain(OWNER_STATEMENTS[0].text);
  });

  it('a receipt a rule matches is left out; meals and finance-settled ones are context only', () => {
    const { prompts, counts } = preparePrompts(
      [exported({ rowId: 'rule', vendor: 'Hetzner' }), exported({ rowId: 'meal', category: 'Bewirtung', vendor: 'Lokal' }), exported({ rowId: 'tax', taxDecision: true, vendor: 'X' }), exported({ rowId: 'open', zuordnung: null }), exported({ rowId: 'eval', date: '2026-05-01', vendor: 'Lokal' })],
      [{ workspaceId: OWNER, type: 'vendor', matchValue: 'Hetzner', zuordnung: 'Geschäftlich', category: null }],
      [],
    );
    expect(prompts.map((p) => p.id)).toEqual(['eval']);
    expect(counts).toMatchObject({ ruleSet: 1, contextOnly: 2, decided: 1 });
    expect(prompts[0].user).toContain('"Privat": 1 time');
  });

  it('reports the two wrong-way rates among what each threshold would set, and the lowest that keeps both below 1 in 100', () => {
    const prompts = [
      ...Array.from({ length: 150 }, (_, i) => ({ id: `b${i}`, workspace: 'w', truth: 'Geschäftlich', system: '', user: '' })),
      { id: 'p1', workspace: 'w', truth: 'Privat', system: '', user: '' },
      { id: 'p2', workspace: 'w', truth: 'Privat', system: '', user: '' },
    ];
    const results = [
      ...Array.from({ length: 150 }, (_, i) => ({ id: `b${i}`, assignment: 'Geschäftlich', confidence: 0.96 })),
      { id: 'p1', assignment: 'Geschäftlich', confidence: 0.8 },
      { id: 'p2', assignment: 'Geschäftlich', confidence: 0.8 },
    ];
    const r = report(prompts, results);
    expect(r.perOption.Privat).toEqual({ receipts: 2, right: 0, wrong: 2, noAnswer: 0 });
    expect(r.thresholds.find((t) => t.threshold === 0.75)).toMatchObject({ set: 152, businessOnPrivate: 2 });
    expect(r.chosen).toBe(0.85);
  });
});
