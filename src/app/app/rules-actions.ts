'use server';

import { auth } from '@/lib/auth';
import { sessionWorkspaceId, tenantIdForWorkspace, workspaceLabel } from '@/lib/auth-workspace';
import { prisma } from '@/lib/prisma';
import { RuleInputError, type ClassificationRule, type RuleErrorCode } from '@/lib/classification-rules';
import { deleteRule, importRules, listRules, saveRule, type ImportResult } from '@/lib/classification-rules-store';

/**
 * Server actions for the classification rules of the ACTIVE workspace (the
 * company the header shows), like every other setting of the app. Results are
 * values, not thrown errors: a thrown server-action error reaches the browser
 * of a production build without its message.
 */

export type RulesResult<T> = { ok: true; value: T } | { ok: false; error: RuleErrorCode | 'failed' };

async function context() {
  const session = await auth.requireAction('receipts.row.write');
  const workspaceId = sessionWorkspaceId(session);
  const active = session.memberships.find((m) => m.id === workspaceId);
  return {
    workspaceId,
    tenantId: tenantIdForWorkspace(session, workspaceId),
    companyLabel: active ? active.tenantName?.trim() || workspaceLabel(active.slug) : null,
  };
}

async function run<T>(work: () => Promise<T>): Promise<RulesResult<T>> {
  try {
    return { ok: true, value: await work() };
  } catch (err) {
    if (err instanceof RuleInputError) return { ok: false, error: err.code };
    console.error('[rules] action failed:', err instanceof Error ? err.name : 'error');
    return { ok: false, error: 'failed' };
  }
}

export async function listClassificationRules(): Promise<RulesResult<{ rules: ClassificationRule[]; companyLabel: string | null }>> {
  return run(async () => {
    const ctx = await context();
    return { rules: await listRules(prisma, ctx.workspaceId), companyLabel: ctx.companyLabel };
  });
}

export async function saveClassificationRule(input: unknown): Promise<RulesResult<ClassificationRule>> {
  return run(async () => saveRule(prisma, await context(), input));
}

export async function deleteClassificationRule(ruleId: string): Promise<RulesResult<boolean>> {
  return run(async () => deleteRule(prisma, (await context()).workspaceId, ruleId));
}

/** The one-time move of the rules this browser held into the active company. */
export async function importBrowserRules(rules: unknown): Promise<RulesResult<ImportResult & { companyLabel: string | null }>> {
  return run(async () => {
    const ctx = await context();
    return { ...(await importRules(prisma, ctx, rules)), companyLabel: ctx.companyLabel };
  });
}
