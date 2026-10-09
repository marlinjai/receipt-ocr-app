import { describe, it, expect } from 'vitest';
import { planMove, type OldContact } from '../../../../scripts/lib/contacts-move';

function old(over: Partial<OldContact> & { id: string }): OldContact {
  return {
    authWorkspaceId: 'ws_1',
    authTenantId: 'tnt_a',
    name: 'Ada',
    companyOrRole: '',
    note: null,
    archivedAt: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    ...over,
  };
}

describe('planMove (which old rows become one contact)', () => {
  it('folds identical entries of one company into one group, the earliest active one winning', () => {
    const plan = planMove(
      [
        old({ id: 'c2', createdAt: new Date('2026-02-01') }),
        old({ id: 'c1', createdAt: new Date('2026-01-01'), authWorkspaceId: 'ws_2' }),
      ],
      new Map(),
    );
    const [group] = plan.groups.get('tnt_a')!;
    expect(group.winner.id).toBe('c1');
    expect(group.losers.map((l) => l.id)).toEqual(['c2']);
  });

  it('prefers an active entry over an earlier archived one', () => {
    const plan = planMove(
      [
        old({ id: 'archived-first', createdAt: new Date('2025-01-01'), archivedAt: new Date('2025-06-01') }),
        old({ id: 'active-later', createdAt: new Date('2026-03-01') }),
      ],
      new Map(),
    );
    expect(plan.groups.get('tnt_a')![0].winner.id).toBe('active-later');
  });

  it('compares identities the way the shared package does (case and spacing do not split them)', () => {
    const plan = planMove(
      [old({ id: 'c1', name: 'Ada  Lovelace', companyOrRole: 'Engines' }), old({ id: 'c2', name: 'ada lovelace', companyOrRole: 'engines' })],
      new Map(),
    );
    expect(plan.groups.get('tnt_a')![0].losers.map((l) => l.id)).toEqual(['c2']);
  });

  it('never merges two companies, even for the same name', () => {
    const plan = planMove(
      [old({ id: 'a1', authTenantId: 'tnt_a' }), old({ id: 'b1', authTenantId: 'tnt_b' })],
      new Map(),
    );
    expect([...plan.groups.keys()]).toEqual(['tnt_a', 'tnt_b']);
    expect(plan.groups.get('tnt_a')![0].losers).toEqual([]);
  });

  it('takes the company of a row that names none from its workspace mapping, and counts the rest', () => {
    const plan = planMove(
      [
        old({ id: 'mapped', authTenantId: null, authWorkspaceId: 'ws_map' }),
        old({ id: 'unmapped', authTenantId: null, authWorkspaceId: 'ws_unknown', name: 'Grace' }),
      ],
      new Map([['ws_map', 'tnt_a']]),
    );
    expect(plan.groups.get('tnt_a')![0].winner.id).toBe('mapped');
    expect(plan.skippedNoTenant).toBe(1);
    expect([...plan.groups.values()].flat().some((g) => g.winner.id === 'unmapped')).toBe(false);
  });

  it('is independent of the order of the input rows', () => {
    const rows = [
      old({ id: 'c3', createdAt: new Date('2026-03-01') }),
      old({ id: 'c1', createdAt: new Date('2026-01-01') }),
      old({ id: 'c2', createdAt: new Date('2026-02-01') }),
    ];
    const forward = planMove(rows, new Map());
    const backward = planMove([...rows].reverse(), new Map());
    expect(forward.groups.get('tnt_a')![0].winner.id).toBe('c1');
    expect(backward.groups.get('tnt_a')![0].winner.id).toBe('c1');
  });
});
