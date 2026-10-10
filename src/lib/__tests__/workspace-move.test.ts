import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHmac } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { ContactError } from '@marlinjai/contacts-core';
import {
  COMPANY_KEYED_MODELS,
  MOVE_REQUEST_MAX_AGE_MS,
  WorkspaceMoveIncompleteError,
  moveWorkspace,
  receiveWorkspaceMove,
  stampedModels,
  type WorkspaceMoveReport,
  type WorkspaceMoveRequest,
} from '../workspace-move';

const companyContactsMock = vi.hoisted(() => vi.fn());
vi.mock('../contacts/db', () => ({ companyContacts: companyContactsMock }));

const SECRET = 'test-secret-not-real';
const NOW = new Date('2026-10-10T12:00:00Z');

function signed(body: string, secret = SECRET): string {
  return `sha256=${createHmac('sha256', secret).update(body, 'utf8').digest('hex')}`;
}

function call(payload: Record<string, unknown> = {}) {
  return JSON.stringify({
    workspace_id: 'ws_1',
    from_tenant_id: 'tnt_a',
    to_tenant_id: 'tnt_b',
    mode: 'dry_run',
    issued_at: NOW.toISOString(),
    ...payload,
  });
}

function report(overrides: Partial<WorkspaceMoveReport> = {}): WorkspaceMoveReport {
  const counts = { rows: 5, restamp: 5, unstamped: 0, alreadyAtTarget: 0, otherCompany: 0 };
  return {
    dryRun: true,
    written: false,
    blocked: [],
    sourceConfirmed: true,
    rows: { ...counts, tables: { meal_guests: counts } },
    contacts: {
      guests: 2,
      alsoRequested: 0,
      move: 2,
      linkedAlong: 0,
      alreadyAtTarget: 0,
      notFound: 0,
      identityConflicts: 0,
      guestRowsRepointed: 0,
      guestRowsFolded: 0,
      refused: {},
      usedByOtherWorkspaces: 0,
      sourceBefore: 2,
      targetBefore: 0,
      sourceAfter: 0,
      targetAfter: 2,
    },
    ...overrides,
  };
}

type Move = (request: WorkspaceMoveRequest, apply: boolean) => Promise<WorkspaceMoveReport>;

async function receive(body: string, opts: { secret?: string | undefined; signature?: string | null; move?: Move; lines?: string[] } = {}) {
  const move = opts.move ?? vi.fn<Move>(async () => report());
  const result = await receiveWorkspaceMove({
    rawBody: body,
    signature: opts.signature === undefined ? signed(body) : opts.signature,
    secret: 'secret' in opts ? opts.secret : SECRET,
    move,
    now: NOW,
    log: (line) => opts.lines?.push(line),
  });
  return { result, move };
}

describe('receiveWorkspaceMove (the decisions, before any data is touched)', () => {
  it('refuses with 503 and moves nothing when the secret is not configured', async () => {
    const { result, move } = await receive(call(), { secret: undefined });
    expect(result.status).toBe(503);
    expect(move).not.toHaveBeenCalled();
  });

  it('refuses an unsigned or wrongly signed call with 401 and moves nothing', async () => {
    const body = call({ mode: 'apply' });
    const unsigned = await receive(body, { signature: null });
    const wrong = await receive(body, { signature: signed(body, 'other') });
    expect(unsigned.result.status).toBe(401);
    expect(wrong.result.status).toBe(401);
    expect(unsigned.move).not.toHaveBeenCalled();
    expect(wrong.move).not.toHaveBeenCalled();
  });

  it('refuses a signed call whose issued_at is too old or too far ahead, so it cannot be replayed later', async () => {
    const old = new Date(NOW.getTime() - MOVE_REQUEST_MAX_AGE_MS - 1000).toISOString();
    const ahead = new Date(NOW.getTime() + MOVE_REQUEST_MAX_AGE_MS + 1000).toISOString();
    const justInside = new Date(NOW.getTime() - MOVE_REQUEST_MAX_AGE_MS + 1000).toISOString();
    const a = await receive(call({ mode: 'apply', issued_at: old }));
    const b = await receive(call({ mode: 'apply', issued_at: ahead }));
    const c = await receive(call({ issued_at: justInside }));
    expect(a.result).toEqual({ status: 401, body: { error: 'Request expired' } });
    expect(b.result.status).toBe(401);
    expect(a.move).not.toHaveBeenCalled();
    expect(b.move).not.toHaveBeenCalled();
    expect(c.result.status).toBe(200);
  });

  it('answers 400 for a signed body that is not a JSON object or lacks a field, and moves nothing', async () => {
    const bodies = [
      'not json',
      '[]',
      call({ issued_at: undefined }),
      call({ issued_at: 'yesterday' }),
      call({ workspace_id: undefined }),
      call({ workspace_id: '' }),
      call({ from_tenant_id: 7 }),
      call({ to_tenant_id: undefined }),
      call({ to_tenant_id: 'x'.repeat(65) }),
      call({ to_tenant_id: 'tnt_a' }),
      call({ mode: undefined }),
      call({ mode: 'APPLY' }),
      call({ also_contact_ids: 'c1' }),
      call({ also_contact_ids: ['c1', 7] }),
    ];
    for (const body of bodies) {
      const { result, move } = await receive(body);
      expect(result.status, body).toBe(400);
      expect(move).not.toHaveBeenCalled();
    }
  });

  it('a dry run is passed on as a dry run and answers 200 with the report, blockers included', async () => {
    const blocked = report({ blocked: ['contacts_refused'] });
    const move = vi.fn<Move>(async () => blocked);
    const { result } = await receive(call({ also_contact_ids: ['c9'] }), { move });
    expect(move).toHaveBeenCalledWith(
      { workspaceId: 'ws_1', fromTenantId: 'tnt_a', toTenantId: 'tnt_b', alsoContactIds: ['c9'] },
      false,
    );
    expect(result).toEqual({ status: 200, body: { ok: true, report: blocked } });
  });

  it('an apply is passed on as an apply and answers 200 with what was written', async () => {
    const done = report({ dryRun: false, written: true });
    const move = vi.fn<Move>(async () => done);
    const lines: string[] = [];
    const { result } = await receive(call({ mode: 'apply' }), { move, lines });
    expect(lines.join('\n')).toContain('apply for workspace ws_1: 5 of 5 rows restamped, 2 contacts moved');
    expect(move).toHaveBeenCalledWith(
      { workspaceId: 'ws_1', fromTenantId: 'tnt_a', toTenantId: 'tnt_b', alsoContactIds: [] },
      true,
    );
    expect(result).toEqual({ status: 200, body: { ok: true, report: done } });
  });

  it('an apply that is blocked answers 409 with the report, so it never reads as done', async () => {
    const blocked = report({ dryRun: false, blocked: ['rows_of_another_company'] });
    const { result } = await receive(call({ mode: 'apply' }), { move: vi.fn<Move>(async () => blocked) });
    expect(result.status).toBe(409);
    expect(result.body).toMatchObject({ report: blocked });
    expect(result.body.ok).toBeUndefined();
  });

  it('answers 502 and names the step when the contacts moved but the rows did not follow', async () => {
    const lines: string[] = [];
    const cause = Object.assign(new Error('connection to 10.0.0.5 refused'), { name: 'PrismaClientKnownRequestError', code: 'P2034' });
    const move = vi.fn<Move>(async () => {
      throw new WorkspaceMoveIncompleteError(3, cause);
    });
    const { result } = await receive(call({ mode: 'apply' }), { move, lines });
    expect(result).toEqual({
      status: 502,
      body: { error: 'Move incomplete; repeat the call to finish it', step: 'rows', contactsMoved: 3 },
    });
    expect(lines.join('\n')).toContain('repeat the call');
    // The class and the short code of what went wrong, never its text.
    expect(lines.join('\n')).toContain('PrismaClientKnownRequestError P2034');
    expect(lines.join('\n')).not.toContain('10.0.0.5');
  });

  it('answers 502 on any other failure, says that a repeat is safe, and leaks no error text', async () => {
    const lines: string[] = [];
    const move = vi.fn<Move>(async () => {
      throw Object.assign(new Error('connection to 10.0.0.5 refused'), { code: 'a code with spaces is not a code' });
    });
    const applied = await receive(call({ mode: 'apply' }), { move, lines });
    expect(applied.result).toEqual({
      status: 502,
      body: { error: 'Move failed; run a dry run to see what is left, then repeat the apply. A repeat is safe.' },
    });
    const dry = await receive(call(), { move, lines });
    expect(dry.result).toEqual({ status: 502, body: { error: 'Dry run failed; nothing was written.' } });
    expect(lines.join('\n')).toContain('failed (Error)');
    expect(lines.join('\n')).not.toContain('10.0.0.5');
    expect(lines.join('\n')).not.toContain('spaces');
  });

  it('logs the workspace, counts and codes, and neither company id', async () => {
    const lines: string[] = [];
    await receive(call(), { lines });
    const text = lines.join('\n');
    expect(text).toContain('dry run for workspace ws_1');
    expect(text).toContain('5 of 5 rows to restamp, 2 contacts to move');
    expect(text).toContain('blocked: none');
    expect(text).not.toContain('tnt_a');
    expect(text).not.toContain('tnt_b');
  });
});

describe('moveWorkspace (the write order, with the contacts package and the database faked)', () => {
  const REQ: WorkspaceMoveRequest = { workspaceId: 'ws_1', fromTenantId: 'tnt_a', toTenantId: 'tnt_b', alsoContactIds: [] };

  /** One guest row naming contact c1, stamped with the source company. Every other table is empty. */
  function fakeDb() {
    const updateMany = vi.fn(async () => ({ count: 1 }));
    const mealGuest = {
      groupBy: vi.fn(async () => [{ authTenantId: 'tnt_a', _count: { _all: 1 } }]),
      findMany: vi.fn(async () => [{ contactId: 'c1' }]),
      count: vi.fn(async () => 0),
      updateMany,
    };
    const empty = { groupBy: vi.fn(async () => []), updateMany: vi.fn(async () => ({ count: 0 })) };
    const transaction = vi.fn(async (run: (tx: unknown) => Promise<void>) => run(db));
    const db: unknown = new Proxy(
      {},
      { get: (_t, prop) => (prop === '$transaction' ? transaction : prop === 'mealGuest' ? mealGuest : empty) },
    );
    return { db: db as PrismaClient, transaction, updateMany };
  }

  /** The source company holds c1; the preview says it can move; `transfer` is what the real transfer does. */
  function fakeContacts(transfer: () => Promise<unknown>, list?: () => Promise<unknown[]>) {
    const preview = { written: false, moved: 1, refused: 0, held: 0, items: [{ id: 'c1', status: 'moved' }] };
    const transferTo = vi.fn(async (_to: string, _ids: string[], options?: { dryRun?: boolean }) =>
      options?.dryRun ? preview : transfer(),
    );
    const source = { list: vi.fn(list ?? (async () => [{ id: 'c1', organizationId: null }])), getMany: vi.fn(async () => []), transferTo };
    const target = { list: vi.fn(list ?? (async () => [])), getMany: vi.fn(async () => []), transferTo: vi.fn() };
    companyContactsMock.mockImplementation((tenantId: string) => (tenantId === 'tnt_a' ? source : target));
    return { transferTo };
  }

  beforeEach(() => {
    companyContactsMock.mockReset();
  });

  it('writes the contacts first, then the rows, and reports both', async () => {
    const { db, transaction, updateMany } = fakeDb();
    const { transferTo } = fakeContacts(async () => ({ written: true, moved: 1, refused: 0, held: 0, items: [] }));
    const report = await moveWorkspace(db, REQ, { apply: true });
    expect(report).toMatchObject({ dryRun: false, written: true, blocked: [], sourceConfirmed: true });
    expect(report.rows).toMatchObject({ rows: 1, restamp: 1 });
    expect(report.contacts).toMatchObject({ move: 1 });
    expect(transferTo).toHaveBeenLastCalledWith('tnt_b', ['c1']);
    expect(transferTo.mock.invocationCallOrder.at(-1)!).toBeLessThan(transaction.mock.invocationCallOrder[0]);
    expect(updateMany).toHaveBeenCalledWith({
      where: { authWorkspaceId: 'ws_1', OR: [{ authTenantId: 'tnt_a' }, { authTenantId: null }] },
      data: { authTenantId: 'tnt_b' },
    });
  });

  it('writes nothing but the company stamp, so a receipt keeps its id and its link to its group', async () => {
    // Groups and their receipts are rows of one receipts table, linked by `parent_row_id` in that
    // table. The table belongs to the workspace as a whole (through its `dt_tables` row), so a move
    // must never rewrite, copy or re-create its rows: then ids and links cannot come apart.
    const writes: Array<{ model: string; method: string; data: unknown }> = [];
    const raw = vi.fn();
    const model = (name: string) =>
      new Proxy(
        {},
        {
          get: (_t, method: string) => async (args: { data?: unknown }) => {
            if (method === 'groupBy') return [{ authTenantId: 'tnt_a', _count: { _all: 2 } }];
            if (method === 'findMany') return [];
            if (method === 'count') return 0;
            writes.push({ model: name, method, data: args?.data });
            return { count: 2 };
          },
        },
      );
    const db: unknown = new Proxy(
      {},
      {
        get: (_t, prop: string) => {
          if (prop === '$transaction') return async (run: (tx: unknown) => Promise<void>) => run(db);
          if (prop.startsWith('$')) return raw;
          return model(prop);
        },
      },
    );
    fakeContacts(async () => ({ written: true, moved: 0, refused: 0, held: 0, items: [] }), async () => []);

    const report = await moveWorkspace(db as PrismaClient, REQ, { apply: true });

    expect(report).toMatchObject({ written: true, blocked: [] });
    expect(writes.length).toBeGreaterThan(0);
    expect(writes.map((w) => w.model)).toContain('dtTable');
    for (const write of writes) {
      expect(write.method).toBe('updateMany');
      expect(write.data).toEqual({ authTenantId: 'tnt_b' });
    }
    // No statement outside the models: the rows of the receipts table are never addressed.
    expect(raw).not.toHaveBeenCalled();
  });

  it('a dry run asks the package only for a preview and opens no transaction', async () => {
    const { db, transaction, updateMany } = fakeDb();
    const { transferTo } = fakeContacts(async () => {
      throw new Error('a dry run must not transfer');
    });
    const report = await moveWorkspace(db, REQ, { apply: false });
    expect(report).toMatchObject({ dryRun: true, written: false, blocked: [] });
    expect(transferTo).toHaveBeenCalledTimes(1);
    expect(transferTo).toHaveBeenCalledWith('tnt_b', ['c1'], { dryRun: true, onConflict: 'skip' });
    expect(transaction).not.toHaveBeenCalled();
    expect(updateMany).not.toHaveBeenCalled();
  });

  it('contacts that changed since the plan (the transfer writes nothing): blocked, and no row is touched', async () => {
    const { db, transaction } = fakeDb();
    fakeContacts(async () => ({ written: false, moved: 0, refused: 1, held: 0, items: [] }));
    const report = await moveWorkspace(db, REQ, { apply: true });
    expect(report).toMatchObject({ dryRun: false, written: false, blocked: ['changed_since_plan'] });
    expect(report.contacts).toMatchObject({ move: 0, sourceAfter: 1, targetAfter: 0 });
    expect(transaction).not.toHaveBeenCalled();
  });

  it('a refusal thrown by the package at the write (a race on an identity): blocked, and no row is touched', async () => {
    const { db, transaction } = fakeDb();
    fakeContacts(async () => {
      throw new ContactError('duplicate');
    });
    const report = await moveWorkspace(db, REQ, { apply: true });
    expect(report).toMatchObject({ written: false, blocked: ['changed_since_plan'] });
    expect(transaction).not.toHaveBeenCalled();
  });

  it('any other failure of the transfer is passed on, not read as a refusal, and no row is touched', async () => {
    const { db, transaction } = fakeDb();
    fakeContacts(async () => {
      throw new Error('contacts database went away');
    });
    await expect(moveWorkspace(db, REQ, { apply: true })).rejects.toThrow('contacts database went away');
    expect(transaction).not.toHaveBeenCalled();
  });

  it('when the closing count cannot be read, the finished move is still reported, with the projected counts', async () => {
    const { db } = fakeDb();
    let lists = 0;
    // The plan reads each company once; the reads after the write fail.
    const list = async () => {
      lists += 1;
      if (lists > 2) throw new Error('contacts database went away');
      return lists === 1 ? [{ id: 'c1', organizationId: null }] : [];
    };
    fakeContacts(async () => ({ written: true, moved: 1, refused: 0, held: 0, items: [] }), list);
    const report = await moveWorkspace(db, REQ, { apply: true });
    expect(report).toMatchObject({ written: true, blocked: [] });
    expect(report.contacts).toMatchObject({ move: 1, sourceBefore: 1, targetBefore: 0, sourceAfter: 0, targetAfter: 1 });
  });
});

/** The tables the plan of 2026-10-10 named by hand. The derivation must find at least these. */
const PLANNED_TABLES = [
  'dt_tables',
  'meal_guests',
  'overview_selections',
  'receipt_reviews',
  'sheet_import_configs',
  'tax_accounts',
  'tax_asset_parts',
  'tax_assets',
  'tax_counterparty_rules',
  'tax_import_batches',
  'tax_invoice_payments',
  'tax_issued_invoices',
  'tax_item_decisions',
  'tax_payment_links',
  'tax_payments',
  'tax_receipt_lines',
  'tax_status_changes',
  'tax_vat_settlements',
  'tax_vendor_rules',
  'tax_year_boundary_answers',
  'workspace_notes',
  'workspace_tax_settings',
  'workspace_vendor_attribution',
];

describe('stampedModels (which tables a move restamps)', () => {
  it('finds every table of the plan in the real Prisma data model', () => {
    const tables = stampedModels().map((m) => m.table);
    expect(tables).toEqual(expect.arrayContaining(PLANNED_TABLES));
    expect(new Set(tables).size).toBe(tables.length);
  });

  it('keys dt_tables by workspaceId and the others by authWorkspaceId', () => {
    const byTable = new Map(stampedModels().map((m) => [m.table, m]));
    expect(byTable.get('dt_tables')).toMatchObject({ delegate: 'dtTable', workspaceField: 'workspaceId' });
    expect(byTable.get('meal_guests')).toMatchObject({ delegate: 'mealGuest', workspaceField: 'authWorkspaceId' });
    expect(byTable.get('tax_vat_settlements')).toMatchObject({ delegate: 'taxVatSettlement' });
  });

  it('leaves out company_exports, which belongs to the company and not to one workspace', () => {
    expect(COMPANY_KEYED_MODELS).toContain('CompanyExport');
    expect(stampedModels().map((m) => m.table)).not.toContain('company_exports');
  });

  it('picks up a model added later, and ignores models without a company stamp', () => {
    const models = [
      { name: 'NewThing', dbName: 'new_things', fields: [{ name: 'id' }, { name: 'authWorkspaceId' }, { name: 'authTenantId' }] },
      { name: 'FxRate', dbName: 'fx_rates', fields: [{ name: 'id' }, { name: 'rate' }] },
      { name: 'Unmapped', dbName: null, fields: [{ name: 'workspaceId' }, { name: 'authTenantId' }] },
    ];
    expect(stampedModels(models)).toEqual([
      { model: 'NewThing', table: 'new_things', delegate: 'newThing', workspaceField: 'authWorkspaceId' },
      { model: 'Unmapped', table: 'Unmapped', delegate: 'unmapped', workspaceField: 'workspaceId' },
    ]);
  });

  it('fails closed on a company stamp without a workspace column, and on a data model without any stamp', () => {
    const orphan = [{ name: 'CompanyThing', dbName: 'company_things', fields: [{ name: 'authTenantId' }] }];
    expect(() => stampedModels(orphan)).toThrow(/CompanyThing/);
    expect(() => stampedModels([{ name: 'FxRate', dbName: 'fx_rates', fields: [{ name: 'id' }] }])).toThrow(/no stamped model/);
  });
});
