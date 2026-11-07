import { afterAll, describe, expect, it } from 'vitest';
import { saveTaxSettings } from '@/lib/meals/service';
import type { BooksDocument } from '../../books-mirror';
import { loadStatement } from '../../service';
import { BooksPullError } from '../client';
import { claimBooksPull, loadBooksMirrorView, pullBooksMirror, resolveCompanyWorkspace, type BooksPullDeps } from '../service';
import { createWorkspace, db } from '../../../../../test/db-helpers';

/**
 * The pull from the Books against a real database (migration 0050): the
 * schedule finds the company's workspace by itself, the button acts in the
 * active company only, every outcome is recorded where the "Einnahmen" tab
 * reads it, and a failed pull keeps the last report that landed. Run with
 * `pnpm test:db`. All data is synthetic.
 */

afterAll(async () => {
  await db.$disconnect();
});

const doc = (o: Partial<BooksDocument> = {}): BooksDocument => ({
  id: 'doc-90',
  docType: 'invoice',
  status: 'issued',
  number: '90',
  issueDate: '2026-10-28',
  dueDate: '2026-11-11',
  currencyCode: 'EUR',
  kleinunternehmer: true,
  reverseCharge: false,
  totalCents: 10_000,
  taxCents: 0,
  taxSummary: [{ rateBp: 0, netCents: 10_000, taxCents: 0 }],
  correctsDocumentId: null,
  replacesDocumentId: null,
  ...o,
});

async function company() {
  const ws = await createWorkspace();
  const ctx = { workspaceId: ws.workspaceId, tenantId: ws.tenantId };
  await saveTaxSettings(db, ctx, { smallBusiness: true });
  return { ws, ctx };
}

const books = (companyId: string, documents: unknown[]): BooksPullDeps => ({
  fetchDocuments: async () => ({ companyId, documents }),
  log: () => undefined,
});

describe('the pull from the Books', () => {
  it('schedule: finds the company workspace, lands the documents, records the report, and again changes nothing', async () => {
    const { ws, ctx } = await company();
    const deps = books(ctx.tenantId, [doc(), doc({ id: 'doc-91', number: '91', totalCents: 5_000, taxSummary: [{ rateBp: 0, netCents: 5_000, taxCents: 0 }] })]);
    const first = await pullBooksMirror(db, deps, { trigger: 'schedule' });
    expect(first).toMatchObject({ ok: true, workspaceId: ws.workspaceId, report: { created: 2, conflicts: [] } });
    const view = await loadStatement(db, ws.workspaceId, 2026);
    expect(view.revenue.invoices.map((i) => [i.number, i.source])).toEqual([['90', 'books'], ['91', 'books']]);

    const again = await pullBooksMirror(db, deps, { trigger: 'schedule' });
    expect(again).toMatchObject({ ok: true, report: { created: 0, unchanged: 2 } });
    const mirror = await loadBooksMirrorView(db, ws.workspaceId, true);
    expect(mirror.last).toMatchObject({ trigger: 'schedule', ok: true, error: null, report: { unchanged: 2 } });
    expect(mirror.last?.successAt).toBe(mirror.last?.at);
  });

  it('records the conflicts a person must settle, with the invoice number', async () => {
    const { ws, ctx } = await company();
    const out = await pullBooksMirror(db, books(ctx.tenantId, [doc({ id: 'cn-1', docType: 'credit_note', number: 'GS-1', correctsDocumentId: 'nowhere' })]), { trigger: 'schedule' });
    expect(out).toMatchObject({ ok: true, report: { conflicts: [{ number: 'GS-1', reason: 'credit_note_without_invoice' }] } });
    expect((await loadBooksMirrorView(db, ws.workspaceId, true)).last?.report?.conflicts).toEqual([{ number: 'GS-1', reason: 'credit_note_without_invoice' }]);
  });

  it('button: acts in the active company, and refuses a key of another company there (recorded, nothing written)', async () => {
    const a = await company();
    const b = await company();
    const ok = await pullBooksMirror(db, books(a.ctx.tenantId, [doc()]), { trigger: 'manual', ctx: a.ctx });
    expect(ok).toMatchObject({ ok: true, workspaceId: a.ws.workspaceId });
    const other = await pullBooksMirror(db, books(a.ctx.tenantId, [doc()]), { trigger: 'manual', ctx: b.ctx });
    expect(other).toEqual({ ok: false, code: 'other_company', workspaceId: b.ws.workspaceId });
    expect(await db.taxIssuedInvoice.count({ where: { authWorkspaceId: b.ws.workspaceId } })).toBe(0);
    expect((await loadBooksMirrorView(db, b.ws.workspaceId, true)).last).toMatchObject({ trigger: 'manual', ok: false, error: 'other_company', successAt: null });
  });

  it('a failed pull is recorded and keeps the report and time of the last one that landed', async () => {
    const { ws, ctx } = await company();
    await pullBooksMirror(db, books(ctx.tenantId, [doc()]), { trigger: 'manual', ctx });
    const before = await loadBooksMirrorView(db, ws.workspaceId, true);
    const refused: BooksPullDeps = {
      fetchDocuments: async () => {
        throw new BooksPullError('books_key_refused', 401);
      },
    };
    expect(await pullBooksMirror(db, refused, { trigger: 'manual', ctx })).toEqual({ ok: false, code: 'books_key_refused', workspaceId: ws.workspaceId });
    const after = await loadBooksMirrorView(db, ws.workspaceId, true);
    expect(after.last).toMatchObject({ ok: false, error: 'books_key_refused', successAt: before.last?.successAt, report: before.last?.report });
    // The invoice of the earlier pull is still there.
    expect(await db.taxIssuedInvoice.count({ where: { authWorkspaceId: ws.workspaceId } })).toBe(1);
  });

  it('schedule: refuses a company with no workspace here, or with several, instead of guessing', async () => {
    expect(await pullBooksMirror(db, books('test-tenant-nobody', [doc()]), { trigger: 'schedule' })).toEqual({ ok: false, code: 'no_workspace', workspaceId: null });
    const a = await company();
    const second = await createWorkspace();
    await saveTaxSettings(db, { workspaceId: second.workspaceId, tenantId: a.ctx.tenantId }, { smallBusiness: true });
    expect(await resolveCompanyWorkspace(db, a.ctx.tenantId)).toEqual({ ok: false, code: 'ambiguous_workspace' });
    expect(await pullBooksMirror(db, books(a.ctx.tenantId, [doc()]), { trigger: 'schedule' })).toMatchObject({ ok: false, code: 'ambiguous_workspace' });
    expect(await db.taxIssuedInvoice.count({ where: { authTenantId: a.ctx.tenantId } })).toBe(0);
  });

  it('without a key nothing runs, and the button records why', async () => {
    const { ws, ctx } = await company();
    expect(await pullBooksMirror(db, null, { trigger: 'manual', ctx })).toEqual({ ok: false, code: 'not_configured', workspaceId: ws.workspaceId });
    expect((await loadBooksMirrorView(db, ws.workspaceId, false))).toMatchObject({ configured: false, last: { error: 'not_configured' } });
  });

  it('claims a scheduled call once: the same or an older time is refused', async () => {
    const ts = Math.floor(Date.now() / 1000) + 10_000 + Math.floor(Math.random() * 1000);
    expect(await claimBooksPull(db, ts)).toBe(true);
    expect(await claimBooksPull(db, ts)).toBe(false);
    expect(await claimBooksPull(db, ts - 1)).toBe(false);
    expect(await claimBooksPull(db, ts + 1)).toBe(true);
  });
});
