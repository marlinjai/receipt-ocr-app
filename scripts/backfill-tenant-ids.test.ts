import { describe, it, expect } from 'vitest';
import {
  parseMaps,
  backfillPair,
  type BackfillClient,
  type BackfillTx,
} from './backfill-tenant-ids';

describe('parseMaps', () => {
  it('parses a single --map pair', () => {
    expect(parseMaps(['--map', 'ws1=tnt1'])).toEqual([{ workspaceId: 'ws1', tenantId: 'tnt1' }]);
  });

  it('parses multiple pairs and the --map=ws=tnt form', () => {
    expect(parseMaps(['--map', 'a=1', '--map=b=2'])).toEqual([
      { workspaceId: 'a', tenantId: '1' },
      { workspaceId: 'b', tenantId: '2' },
    ]);
  });

  it('trims surrounding whitespace in ids', () => {
    expect(parseMaps(['--map', ' ws = tnt '])).toEqual([{ workspaceId: 'ws', tenantId: 'tnt' }]);
  });

  it('tolerates the --dry-run and --list flags alongside pairs', () => {
    expect(parseMaps(['--map', 'a=1', '--dry-run'])).toEqual([
      { workspaceId: 'a', tenantId: '1' },
    ]);
  });

  it('refuses an unknown flag rather than skipping it', () => {
    expect(() => parseMaps(['--map', 'a=1', '--force'])).toThrow(/unknown argument/);
  });

  it('refuses a bare positional argument', () => {
    expect(() => parseMaps(['a=1'])).toThrow(/unknown argument/);
  });

  it('rejects a --map with no value', () => {
    expect(() => parseMaps(['--map'])).toThrow(/requires a workspaceId=tenantId/);
  });

  it('rejects a malformed pair and an empty side', () => {
    expect(() => parseMaps(['--map', 'wsonly'])).toThrow(/invalid --map pair/);
    expect(() => parseMaps(['--map', 'ws='])).toThrow(/invalid --map pair/);
    expect(() => parseMaps(['--map', '=tnt'])).toThrow(/invalid --map pair/);
  });

  it('rejects an empty argument list rather than silently doing nothing', () => {
    expect(() => parseMaps([])).toThrow(/no --map pairs/);
  });
});

/** Records every updateMany call so the test can assert the exact predicates. */
function recordingClient(counts: Record<string, number> = {}) {
  const calls: Array<{ model: string; where: Record<string, unknown>; data: Record<string, string> }> = [];
  const delegate = (model: string) => ({
    updateMany: async (args: { where: Record<string, unknown>; data: Record<string, string> }) => {
      calls.push({ model, where: args.where, data: args.data });
      return { count: counts[model] ?? 0 };
    },
  });
  const tx: BackfillTx = {
    dtTable: delegate('dtTable'),
    sheetImportConfig: delegate('sheetImportConfig'),
    workspaceVendorAttribution: delegate('workspaceVendorAttribution'),
    overviewSelection: delegate('overviewSelection'),
    workspaceNotes: delegate('workspaceNotes'),
  };
  const client: BackfillClient = { $transaction: (fn) => fn(tx) };
  return { client, calls };
}

describe('backfillPair', () => {
  it('stamps the company on all five tables and reports per-table counts', async () => {
    const { client } = recordingClient({
      dtTable: 3,
      sheetImportConfig: 1,
      workspaceVendorAttribution: 7,
      overviewSelection: 2,
      workspaceNotes: 1,
    });
    expect(await backfillPair(client, 'ws1', 'tnt1')).toEqual({
      dtTables: 3,
      sheetImportConfigs: 1,
      workspaceVendorAttribution: 7,
      overviewSelections: 2,
      workspaceNotes: 1,
    });
  });

  it('NEVER overwrites a row that already names a company', async () => {
    // The guard that makes this safe to re-run, and the one thing a backfill
    // must never get wrong: silently re-attributing an owned row.
    const { client, calls } = recordingClient();
    await backfillPair(client, 'ws1', 'tnt1');
    expect(calls).toHaveLength(5);
    for (const c of calls) {
      expect(c.where.authTenantId).toBeNull();
      expect(c.data).toEqual({ authTenantId: 'tnt1' });
    }
  });

  it('keys dt_tables on workspaceId and the four side tables on authWorkspaceId', async () => {
    const { client, calls } = recordingClient();
    await backfillPair(client, 'ws1', 'tnt1');
    const byModel = Object.fromEntries(calls.map((c) => [c.model, c.where]));
    expect(byModel.dtTable).toMatchObject({ workspaceId: 'ws1' });
    for (const m of [
      'sheetImportConfig',
      'workspaceVendorAttribution',
      'overviewSelection',
      'workspaceNotes',
    ]) {
      expect(byModel[m]).toMatchObject({ authWorkspaceId: 'ws1' });
    }
  });

  it('reports all zeroes on a second run (idempotent)', async () => {
    const { client } = recordingClient();
    expect(await backfillPair(client, 'ws1', 'tnt1')).toEqual({
      dtTables: 0,
      sheetImportConfigs: 0,
      workspaceVendorAttribution: 0,
      overviewSelections: 0,
      workspaceNotes: 0,
    });
  });
});
