import { describe, it, expect } from 'vitest';
import {
  parseMapArgs,
  repointPair,
  type RepointClient,
  type RepointTx,
} from './migrate-workspace-to-tenant-workspace';

describe('parseMapArgs', () => {
  it('parses a single --map pair', () => {
    expect([...parseMapArgs(['--map', 'old1=new1'])]).toEqual([['old1', 'new1']]);
  });

  it('parses multiple pairs and the --map=old=new form', () => {
    const map = parseMapArgs(['--map', 'a=1', '--map=b=2']);
    expect([...map]).toEqual([
      ['a', '1'],
      ['b', '2'],
    ]);
  });

  it('trims surrounding whitespace in ids', () => {
    expect([...parseMapArgs(['--map', ' old = new '])]).toEqual([['old', 'new']]);
  });

  it('refuses an unknown flag rather than skipping it', () => {
    expect(() => parseMapArgs(['--map', 'a=1', '--force'])).toThrow(/unknown argument/);
  });

  it('refuses a bare positional argument', () => {
    expect(() => parseMapArgs(['a=1'])).toThrow(/unknown argument/);
  });

  it('rejects a --map with no value', () => {
    expect(() => parseMapArgs(['--map'])).toThrow(/requires an oldId=newId/);
  });

  it('rejects a malformed pair (no `=`)', () => {
    expect(() => parseMapArgs(['--map', 'oldonly'])).toThrow(/invalid --map pair/);
  });

  it('rejects an empty side', () => {
    expect(() => parseMapArgs(['--map', 'old='])).toThrow(/invalid --map pair/);
    expect(() => parseMapArgs(['--map', '=new'])).toThrow(/invalid --map pair/);
  });

  it('rejects a self-map (old === new)', () => {
    expect(() => parseMapArgs(['--map', 'same=same'])).toThrow(/identical/);
  });

  it('rejects a duplicate source id', () => {
    expect(() => parseMapArgs(['--map', 'a=1', '--map', 'a=2'])).toThrow(/duplicate --map source/);
  });

  it('requires at least one pair', () => {
    expect(() => parseMapArgs([])).toThrow(/at least one --map/);
  });
});

/**
 * Minimal ephemeral in-memory stand-in for the Prisma client: one array per
 * migrated table, each `updateMany` mutating rows whose partition field matches
 * `where` and reporting the count. This exercises the real transaction body of
 * `repointPair` (all five tables, one atomic pass) without a live database.
 */
interface FakeDb {
  dtTables: Array<{ workspaceId: string }>;
  sheetImportConfigs: Array<{ authWorkspaceId: string }>;
  vendorAttribution: Array<{ authWorkspaceId: string }>;
  overviewSelections: Array<{ authWorkspaceId: string }>;
  workspaceNotes: Array<{ authWorkspaceId: string }>;
}

function delegate<T extends Record<string, string>>(rows: T[], field: keyof T & string) {
  return {
    async updateMany({
      where,
      data,
    }: {
      where: Record<string, string>;
      data: Record<string, string>;
    }): Promise<{ count: number }> {
      let count = 0;
      for (const row of rows) {
        if (row[field] === where[field]) {
          (row as Record<string, string>)[field] = data[field];
          count++;
        }
      }
      return { count };
    },
  };
}

function fakeClient(db: FakeDb): RepointClient {
  const tx: RepointTx = {
    dtTable: delegate(db.dtTables, 'workspaceId'),
    sheetImportConfig: delegate(db.sheetImportConfigs, 'authWorkspaceId'),
    workspaceVendorAttribution: delegate(db.vendorAttribution, 'authWorkspaceId'),
    overviewSelection: delegate(db.overviewSelections, 'authWorkspaceId'),
    workspaceNotes: delegate(db.workspaceNotes, 'authWorkspaceId'),
  };
  return {
    $transaction: async (fn) => fn(tx),
  };
}

describe('repointPair', () => {
  function seed(): FakeDb {
    return {
      dtTables: [{ workspaceId: 'old' }, { workspaceId: 'old' }, { workspaceId: 'unrelated' }],
      sheetImportConfigs: [{ authWorkspaceId: 'old' }],
      vendorAttribution: [{ authWorkspaceId: 'old' }, { authWorkspaceId: 'old' }],
      overviewSelections: [{ authWorkspaceId: 'unrelated' }],
      workspaceNotes: [{ authWorkspaceId: 'old' }],
    };
  }

  it('repoints every table for the pair and reports per-table counts', async () => {
    const db = seed();
    const counts = await repointPair(fakeClient(db), 'old', 'new');

    expect(counts).toEqual({
      dtTables: 2,
      sheetImportConfigs: 1,
      workspaceVendorAttribution: 2,
      overviewSelections: 0,
      workspaceNotes: 1,
    });

    // Matching rows moved; unrelated rows untouched.
    expect(db.dtTables.map((r) => r.workspaceId)).toEqual(['new', 'new', 'unrelated']);
    expect(db.vendorAttribution.every((r) => r.authWorkspaceId === 'new')).toBe(true);
    expect(db.overviewSelections[0].authWorkspaceId).toBe('unrelated');
  });

  it('is idempotent: a second run finds nothing under the old id (all counts 0)', async () => {
    const db = seed();
    await repointPair(fakeClient(db), 'old', 'new');
    const second = await repointPair(fakeClient(db), 'old', 'new');

    expect(second).toEqual({
      dtTables: 0,
      sheetImportConfigs: 0,
      workspaceVendorAttribution: 0,
      overviewSelections: 0,
      workspaceNotes: 0,
    });
  });
});
