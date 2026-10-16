import 'server-only';
import type { PrismaClient } from '@prisma/client';
import { RuleInputError, validateRuleInput, type ClassificationRule, type RuleType } from './classification-rules';

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
  zuordnung: string;
  categoryOverride: string | null;
  label: string;
};

function toRule(row: StoredRule): ClassificationRule {
  return {
    id: row.id,
    type: row.type as RuleType,
    matchValue: row.matchValue,
    zuordnung: row.zuordnung,
    categoryOverride: row.categoryOverride,
    label: row.label,
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
