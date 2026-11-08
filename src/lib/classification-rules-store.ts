import 'server-only';
import type { PrismaClient } from '@prisma/client';
import { RuleInputError, WHAT_MAX_LENGTH, subjectKey, validateRuleInput, type ClassificationRule, type RuleType } from './classification-rules';

/**
 * The classification rules of one workspace (company), stored in
 * `classification_rules`. Every read and write is scoped by the workspace id
 * the caller resolved from the verified session; a rule of another workspace
 * is never read, changed or deleted.
 */

export interface RuleContext {
  workspaceId: string;
  tenantId: string | null;
}

type StoredRule = {
  id: string;
  type: string;
  matchValue: string;
  zuordnung: string | null;
  categoryOverride: string | null;
  label: string;
  subject: string | null;
};

function toRule(row: StoredRule): ClassificationRule {
  return {
    id: row.id,
    type: row.type as RuleType,
    matchValue: row.matchValue,
    zuordnung: row.zuordnung,
    categoryOverride: row.categoryOverride,
    label: row.label,
    subject: row.subject,
  };
}

export async function listRules(db: PrismaClient, workspaceId: string): Promise<ClassificationRule[]> {
  const rows = await db.classificationRule.findMany({
    where: { authWorkspaceId: workspaceId },
    orderBy: [{ type: 'asc' }, { matchValue: 'asc' }],
  });
  return rows.map(toRule);
}

/**
 * Add a rule, or replace the one of the same kind and text (a second rule for
 * the same vendor would only make the outcome depend on the order).
 */
export async function saveRule(db: PrismaClient, ctx: RuleContext, raw: unknown): Promise<ClassificationRule> {
  const input = validateRuleInput(raw);
  const data = { zuordnung: input.zuordnung, categoryOverride: input.categoryOverride ?? null, label: input.label };
  const row = await db.classificationRule.upsert({
    where: { authWorkspaceId_type_matchValue: { authWorkspaceId: ctx.workspaceId, type: input.type, matchValue: input.matchValue } },
    create: { authWorkspaceId: ctx.workspaceId, authTenantId: ctx.tenantId, type: input.type, matchValue: input.matchValue, ...data },
    update: data,
  });
  return toRule(row);
}

/** False when the workspace holds no rule with this id (already gone, or another workspace's). */
export async function deleteRule(db: PrismaClient, workspaceId: string, ruleId: string): Promise<boolean> {
  if (typeof ruleId !== 'string' || !ruleId) return false;
  const { count } = await db.classificationRule.deleteMany({ where: { id: ruleId, authWorkspaceId: workspaceId } });
  return count > 0;
}

export interface ImportResult {
  /** Rules that are new in the workspace. */
  imported: number;
  /** Rules the workspace already had with the same kind and text: left as they are. */
  alreadyThere: number;
  /** Entries that are not a valid rule (unknown kind, empty text, an assignment that does not exist). */
  invalid: number;
}

/**
 * The one-time move of the rules a browser held. A rule the workspace already
 * has (same kind and text) is left as it is: what is on the server was set
 * later or by someone else and wins. Repeating the import adds nothing.
 */
export async function importRules(db: PrismaClient, ctx: RuleContext, raw: unknown): Promise<ImportResult> {
  const result: ImportResult = { imported: 0, alreadyThere: 0, invalid: 0 };
  if (!Array.isArray(raw)) return result;
  for (const entry of raw.slice(0, 500)) {
    let input;
    try {
      input = validateRuleInput(entry);
    } catch (err) {
      if (err instanceof RuleInputError) {
        result.invalid += 1;
        continue;
      }
      throw err;
    }
    const created = await db.classificationRule.createMany({
      data: [{ authWorkspaceId: ctx.workspaceId, authTenantId: ctx.tenantId, type: input.type, matchValue: input.matchValue, zuordnung: input.zuordnung, categoryOverride: input.categoryOverride ?? null, label: input.label }],
      skipDuplicates: true,
    });
    if (created.count > 0) result.imported += 1;
    else result.alreadyThere += 1;
  }
  return result;
}

/**
 * "Was ist das?" (plan docs/plans/2026-11-07-learned-assignment.md, decision 8): the person's short answer
 * about one vendor or counterparty ("Getränkelieferdienst, Wasser"), stored as one of their statements, so
 * the assignment model and the counterparty classifier are both given it, and the rules page lists it. One
 * statement per subject: a new answer replaces it, an empty one deletes it. Returns the statement, or null
 * once it is deleted.
 */
export async function saveSubjectStatement(db: PrismaClient, ctx: RuleContext, raw: { name: unknown; answer: unknown }): Promise<ClassificationRule | null> {
  const name = typeof raw.name === 'string' ? raw.name.replace(/\s+/g, ' ').trim() : '';
  const subject = subjectKey(name);
  if (!subject) throw new RuleInputError('match_value_required');
  const answer = typeof raw.answer === 'string' ? raw.answer.replace(/\s+/g, ' ').trim() : '';
  if (answer.length > WHAT_MAX_LENGTH) throw new RuleInputError('match_value_too_long');
  const existing = await db.classificationRule.findFirst({ where: { authWorkspaceId: ctx.workspaceId, type: 'freetext', subject } });
  if (!answer) {
    if (existing) await db.classificationRule.deleteMany({ where: { id: existing.id, authWorkspaceId: ctx.workspaceId } });
    return null;
  }
  // The same checks a statement typed on the rules page passes.
  const input = validateRuleInput({ type: 'freetext', matchValue: `${name}: ${answer}`, zuordnung: null, label: answer });
  const data = { matchValue: input.matchValue, label: answer, zuordnung: null, categoryOverride: null };
  const row = existing
    ? await db.classificationRule.update({ where: { id: existing.id }, data })
    : await db.classificationRule.create({ data: { authWorkspaceId: ctx.workspaceId, authTenantId: ctx.tenantId, type: 'freetext', subject, ...data } });
  return toRule(row);
}
