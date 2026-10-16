import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { db } from '../../../test/db-helpers';
import { deleteRule, importRules, listRules, saveRule } from '../classification-rules-store';

/** The classification rules store against a real database (`pnpm test:db`). */

const ctx = () => ({ workspaceId: `test-ws-${randomUUID()}`, tenantId: `test-tenant-${randomUUID()}` });

afterAll(async () => {
  await db.$disconnect();
});

describe('classification rules store', () => {
  it('saves, lists and deletes the rules of one company', async () => {
    const a = ctx();
    const saved = await saveRule(db, a, { type: 'vendor', matchValue: 'Netflix', zuordnung: 'Privat' });
    expect(await listRules(db, a.workspaceId)).toEqual([saved]);
    expect(await deleteRule(db, a.workspaceId, saved.id)).toBe(true);
    expect(await listRules(db, a.workspaceId)).toEqual([]);
    // Deleting again is a no-op, not an error.
    expect(await deleteRule(db, a.workspaceId, saved.id)).toBe(false);
  });

  it('a second rule for the same vendor replaces the first instead of competing with it', async () => {
    const a = ctx();
    await saveRule(db, a, { type: 'vendor', matchValue: 'Bahn', zuordnung: 'Privat' });
    await saveRule(db, a, { type: 'vendor', matchValue: 'Bahn', zuordnung: 'Geschäftlich', categoryOverride: 'Reisekosten' });
    expect(await listRules(db, a.workspaceId)).toEqual([expect.objectContaining({ matchValue: 'Bahn', zuordnung: 'Geschäftlich', categoryOverride: 'Reisekosten' })]);
  });

  it('company isolation: another company neither sees nor deletes a rule', async () => {
    const a = ctx();
    const b = ctx();
    const rule = await saveRule(db, a, { type: 'keyword', matchValue: 'Matrikel', zuordnung: 'Universität' });
    expect(await listRules(db, b.workspaceId)).toEqual([]);
    expect(await deleteRule(db, b.workspaceId, rule.id)).toBe(false);
    expect(await listRules(db, a.workspaceId)).toHaveLength(1);
    const stored = await db.classificationRule.findUnique({ where: { id: rule.id } });
    expect(stored?.authTenantId).toBe(a.tenantId);
  });

  it('the browser import: valid rules come in once, invalid ones are counted, a repeat adds nothing', async () => {
    const a = ctx();
    const browser = [
      { id: 'old-1', label: 'Streaming', type: 'vendor', matchValue: 'Netflix', zuordnung: 'Privat' },
      { id: 'old-2', label: '', type: 'freetext', matchValue: 'Hotels on conference days are university', zuordnung: 'Universität' },
      { id: 'old-3', type: 'vendor', matchValue: '', zuordnung: 'Privat' },
      'not a rule',
    ];
    expect(await importRules(db, a, browser)).toEqual({ imported: 2, alreadyThere: 0, invalid: 2 });
    expect(await importRules(db, a, browser)).toEqual({ imported: 0, alreadyThere: 2, invalid: 2 });
    expect((await listRules(db, a.workspaceId)).map((r) => r.matchValue).sort()).toEqual(['Hotels on conference days are university', 'Netflix']);
  });

  it('the import never overwrites a rule the company already has', async () => {
    const a = ctx();
    await saveRule(db, a, { type: 'vendor', matchValue: 'Netflix', zuordnung: 'Geschäftlich' });
    await importRules(db, a, [{ type: 'vendor', matchValue: 'Netflix', zuordnung: 'Privat' }]);
    expect((await listRules(db, a.workspaceId))[0].zuordnung).toBe('Geschäftlich');
  });

  it('something that is not a list imports nothing', async () => {
    expect(await importRules(db, ctx(), { rules: [] })).toEqual({ imported: 0, alreadyThere: 0, invalid: 0 });
  });
});
