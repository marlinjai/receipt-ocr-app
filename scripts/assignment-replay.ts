/**
 * The replay of plan docs/plans/2026-11-07-learned-assignment.md, decision 6:
 * before the assignment model is switched on, it decides every receipt whose
 * assignment a person set, per workspace, in date order, seeing only the
 * context that existed before that receipt (the earlier answers and the
 * statements, the owner's seed statements counted as stated from the start),
 * never the receipt's own answer.
 *
 * Three steps, so the receipts never leave the machines they are on and the
 * model key never reaches this one:
 *
 *   1. prepare: from a read-only export of the receipts (JSON, see `ExportedReceipt`),
 *      writes one prompt per receipt to decide, built by the app's own code
 *      (src/lib/assignment/prompt.ts and context.ts), into a JSONL file.
 *        npx tsx scripts/assignment-replay.ts prepare --receipts r.json --rules rules.json --tax-vendor-rules t.json --out prompts.jsonl
 *   2. call: scripts/assignment-replay-call.mjs sends each prompt to the model and
 *      writes one answer per line (run where the key is, through the secrets proxy).
 *   3. report: compares the answers with the person's, per option and per threshold.
 *        npx tsx scripts/assignment-replay.ts report --prompts prompts.jsonl --results results.jsonl
 *
 * Every output is counts only: never a vendor, an amount, a text or a reason.
 * The export and the files it writes hold personal data: keep them in a scratch
 * directory, never in the repository.
 *
 * Which receipts count. Every existing assignment was set by a person or by a
 * rule (the model never set one before this plan). A receipt a reading rule
 * (vendor or keyword) matches is no evidence of the person and is left out
 * altogether. Receipts the app would not decide (a meal, which the meal
 * register judges; a receipt a finance decision or a finance vendor rule
 * settles) are not decided in the replay either, but their answers are the
 * person's and count as context for the receipts after them.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { buildAssignmentContext } from '../src/lib/assignment/context';
import { assignmentPrompt, assignmentUserText, type PastAnswer, type Statement } from '../src/lib/assignment/prompt';
import { OWNER_STATEMENTS, OWNER_WORKSPACE_ID } from '../src/lib/assignment/seed';
import { matchRules, type ClassificationRule } from '../src/lib/classification-rules';
import { MEAL_CATEGORY, ZUORDNUNG_OPTIONS } from '../src/lib/receipts-constants';
import { ruleInForce, vendorKey as taxVendorKey } from '../src/lib/tax/decisions';

/** One receipt as the read-only export gives it. */
export interface ExportedReceipt {
  workspaceId: string;
  rowId: string;
  createdAt: string | null;
  vendor: string | null;
  date: string | null;
  category: string | null;
  zuordnung: string | null;
  item: string | null;
  text: string | null;
  lines: Array<{ text: string; grossCents: number; kind: string }> | null;
  /** True when a finance decision settles the receipt. */
  taxDecision: boolean;
}

interface ExportedRule {
  workspaceId: string;
  type: ClassificationRule['type'];
  matchValue: string;
  zuordnung: string | null;
  category: string | null;
}

interface ExportedTaxVendorRule {
  workspaceId: string;
  vendorKey: string;
  effectiveFrom: string;
}

export interface ReplayPrompt {
  id: string;
  workspace: string;
  truth: string;
  system: string;
  user: string;
}

export interface ReplayResult {
  id: string;
  assignment: string | null;
  confidence: number;
  error?: string;
}

const day = (value: string | null) => (value ? value.slice(0, 10) : null);
/** Date order; a receipt without a day goes after every dated one, by when it was stored. */
const orderKey = (r: ExportedReceipt) => `${day(r.date) ?? '9999-99-99'}|${r.createdAt ?? ''}|${r.rowId}`;

export function preparePrompts(receipts: readonly ExportedReceipt[], rules: readonly ExportedRule[], taxVendorRules: readonly ExportedTaxVendorRule[]): { prompts: ReplayPrompt[]; counts: Record<string, number> } {
  const counts: Record<string, number> = { receipts: receipts.length, answered: 0, ruleSet: 0, contextOnly: 0, decided: 0 };
  const prompts: ReplayPrompt[] = [];
  const workspaces = [...new Set(receipts.map((r) => r.workspaceId))];
  for (const workspace of workspaces) {
    const own = receipts.filter((r) => r.workspaceId === workspace && r.zuordnung).sort((a, b) => orderKey(a).localeCompare(orderKey(b)));
    const readingRules: ClassificationRule[] = rules
      .filter((r) => r.workspaceId === workspace)
      .map((r, i) => ({ id: `rule-${i}`, label: '', type: r.type, matchValue: r.matchValue, zuordnung: r.zuordnung, categoryOverride: r.category }));
    const vendorRules = taxVendorRules.filter((r) => r.workspaceId === workspace).map((r) => ({ vendorKey: r.vendorKey, effectiveFrom: r.effectiveFrom }));
    const statements: Statement[] = [
      ...(workspace === OWNER_WORKSPACE_ID ? OWNER_STATEMENTS.map((s) => ({ id: `seed-${s.key}`, text: s.text, assignment: s.zuordnung })) : []),
      ...readingRules.filter((r) => r.type === 'freetext').map((r) => ({ id: r.id, text: r.matchValue, assignment: r.zuordnung })),
    ];
    const history: Array<PastAnswer & { key: string }> = [];
    for (const r of own) {
      counts.answered++;
      if (matchRules(readingRules, { vendor: r.vendor, fullText: r.text ?? '' })) {
        counts.ruleSet++;
        continue;
      }
      const past: PastAnswer & { key: string } = {
        key: orderKey(r),
        rowId: r.rowId,
        vendor: r.vendor ?? '',
        date: day(r.date),
        category: r.category,
        item: r.item,
        lines: (r.lines ?? []).map((l) => l.text),
        assignment: r.zuordnung!,
      };
      const settled =
        r.category === MEAL_CATEGORY ||
        r.taxDecision ||
        // VendorRule's other fields are not read by ruleInForce.
        ruleInForce(vendorRules as unknown as Parameters<typeof ruleInForce>[0], taxVendorKey(r.vendor), day(r.date)) !== null;
      if (settled) {
        counts.contextOnly++;
      } else {
        counts.decided++;
        // Only what existed before this receipt: earlier answers, never its own.
        const context = buildAssignmentContext({ rowId: r.rowId, vendor: r.vendor, category: r.category }, history, statements, []);
        prompts.push({
          id: r.rowId,
          workspace: workspace.slice(-6),
          truth: r.zuordnung!,
          system: assignmentPrompt(ZUORDNUNG_OPTIONS),
          user: assignmentUserText(
            { vendor: r.vendor, date: day(r.date), category: r.category, item: r.item, gross: null, currency: 'EUR', lines: r.lines ?? [], text: r.text ?? '' },
            context,
          ),
        });
      }
      history.push(past);
    }
  }
  return { prompts, counts };
}

/** The thresholds the report is printed for. */
export const THRESHOLDS = [0.5, 0.6, 0.7, 0.75, 0.8, 0.85, 0.9, 0.95, 0.97, 0.99];

export interface ThresholdRow {
  threshold: number;
  /** Receipts it would set automatically. */
  set: number;
  /** Of those, the right answer. */
  right: number;
  /** "Privat" set on a business receipt, and the business receipts set at all. */
  privateOnBusiness: number;
  businessSet: number;
  /** "Geschäftlich" set on a private receipt, and the private receipts set at all. */
  businessOnPrivate: number;
  privateSet: number;
  /** The same two mistakes as a share of everything set automatically (the plan's bar: below 1 in 100). */
  privateOnBusinessRate: number;
  businessOnPrivateRate: number;
}

export function report(prompts: readonly ReplayPrompt[], results: readonly ReplayResult[]) {
  const answer = new Map(results.map((r) => [r.id, r]));
  const rows = prompts.map((p) => ({ truth: p.truth, workspace: p.workspace, got: answer.get(p.id) ?? null }));
  const answered = rows.filter((r) => r.got && !r.got.error);
  const perOption: Record<string, { receipts: number; right: number; wrong: number; noAnswer: number }> = {};
  for (const r of answered) {
    const o = (perOption[r.truth] ??= { receipts: 0, right: 0, wrong: 0, noAnswer: 0 });
    o.receipts++;
    if (r.got!.assignment === null) o.noAnswer++;
    else if (r.got!.assignment === r.truth) o.right++;
    else o.wrong++;
  }
  const thresholds: ThresholdRow[] = THRESHOLDS.map((threshold) => {
    const set = answered.filter((r) => r.got!.assignment !== null && r.got!.confidence >= threshold);
    const privateOnBusiness = set.filter((r) => r.truth === 'Geschäftlich' && r.got!.assignment === 'Privat').length;
    const businessOnPrivate = set.filter((r) => r.truth === 'Privat' && r.got!.assignment === 'Geschäftlich').length;
    return {
      threshold,
      set: set.length,
      right: set.filter((r) => r.got!.assignment === r.truth).length,
      privateOnBusiness,
      businessSet: set.filter((r) => r.truth === 'Geschäftlich').length,
      businessOnPrivate,
      privateSet: set.filter((r) => r.truth === 'Privat').length,
      privateOnBusinessRate: set.length ? privateOnBusiness / set.length : 0,
      businessOnPrivateRate: set.length ? businessOnPrivate / set.length : 0,
    };
  });
  // The lowest threshold at which both wrong-way rates are below 1 in 100 among what it sets, and it sets something.
  const chosen = thresholds.find((t) => t.set > 0 && t.privateOnBusinessRate < 0.01 && t.businessOnPrivateRate < 0.01) ?? null;
  return { prompts: prompts.length, answered: answered.length, failed: rows.length - answered.length, perOption, thresholds, chosen: chosen?.threshold ?? null };
}

function arg(name: string): string {
  const i = process.argv.indexOf(`--${name}`);
  const value = i >= 0 ? process.argv[i + 1] : undefined;
  if (!value) {
    console.error(`--${name} is required`);
    process.exit(2);
  }
  return value;
}

const readJsonl = <T>(path: string): T[] =>
  readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as T);

if (process.argv[1]?.endsWith('assignment-replay.ts')) {
  const command = process.argv[2];
  if (command === 'prepare') {
    const receipts = JSON.parse(readFileSync(arg('receipts'), 'utf8')) as ExportedReceipt[];
    const rules = JSON.parse(readFileSync(arg('rules'), 'utf8')) as ExportedRule[] | null;
    const vendorRules = JSON.parse(readFileSync(arg('tax-vendor-rules'), 'utf8')) as ExportedTaxVendorRule[] | null;
    const { prompts, counts } = preparePrompts(receipts, rules ?? [], vendorRules ?? []);
    writeFileSync(arg('out'), prompts.map((p) => JSON.stringify(p)).join('\n') + '\n');
    console.log(JSON.stringify(counts));
  } else if (command === 'report') {
    console.log(JSON.stringify(report(readJsonl<ReplayPrompt>(arg('prompts')), readJsonl<ReplayResult>(arg('results'))), null, 2));
  } else {
    console.error('usage: assignment-replay.ts prepare|report ...');
    process.exit(2);
  }
}
