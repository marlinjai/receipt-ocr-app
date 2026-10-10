import { describe, it, expect, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import {
  COMPANY_KEYED_MODELS,
  MOVE_REQUEST_MAX_AGE_MS,
  WorkspaceMoveIncompleteError,
  receiveWorkspaceMove,
  stampedModels,
  type WorkspaceMoveReport,
  type WorkspaceMoveRequest,
} from '../workspace-move';

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
  const counts = { rows: 5, restamp: 5, alreadyAtTarget: 0, otherCompany: 0 };
  return {
    dryRun: true,
    written: false,
    blocked: [],
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
    const move = vi.fn<Move>(async () => {
      throw new WorkspaceMoveIncompleteError(3, new Error('connection to 10.0.0.5 refused'));
    });
    const { result } = await receive(call({ mode: 'apply' }), { move, lines });
    expect(result).toEqual({
      status: 502,
      body: { error: 'Move incomplete; repeat the call to finish it', step: 'rows', contactsMoved: 3 },
    });
    expect(lines.join('\n')).toContain('repeat the call');
    expect(lines.join('\n')).not.toContain('10.0.0.5');
  });

  it('answers 502 on any other failure without leaking the error text', async () => {
    const lines: string[] = [];
    const move = vi.fn<Move>(async () => {
      throw new Error('connection to 10.0.0.5 refused');
    });
    const { result } = await receive(call({ mode: 'apply' }), { move, lines });
    expect(result).toEqual({ status: 502, body: { error: 'Move failed' } });
    expect(lines.join('\n')).not.toContain('10.0.0.5');
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
