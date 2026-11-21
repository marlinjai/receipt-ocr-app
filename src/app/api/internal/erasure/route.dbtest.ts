import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The erasure route against the real company erasure, the real ledger and a
 * real database. Only the file store (an outside service) and the bank service
 * are stand-ins. This is the test that shows what the ROUTE answers when the
 * file store refuses: the error is raised by the real erasure, not built by a mock.
 */

const eraseStoredFile = vi.fn();
vi.mock('next/server', () => ({ NextResponse: { json: (body: unknown, init?: ResponseInit) => Response.json(body, init) } }));
vi.mock('@/lib/stored-files', () => ({ eraseStoredFile: (...a: unknown[]) => eraseStoredFile(...a) }));
vi.mock('@/lib/tax/payments/bank/server', () => ({ serverBankDeps: () => null }));

import { createWorkspace, db, plainMealReceipt } from '../../../../../test/db-helpers';
import { ensureContactsLayout } from '../../../../../test/contacts-db';
import { contactsDb } from '@/lib/contacts/db';
import { ERASURE_SIGNATURE_HEADER } from '@/lib/erasure-signature';
import { prisma } from '@/lib/prisma';
import { POST } from './route';

const secret = randomBytes(16).toString('hex');

beforeAll(async () => {
  await ensureContactsLayout();
});

afterAll(async () => {
  await contactsDb().close();
  await prisma.$disconnect();
  await db.$disconnect();
});

beforeEach(() => {
  vi.stubEnv('RECEIPTS_ERASURE_WEBHOOK_SECRET', secret);
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  eraseStoredFile.mockReset();
});

function signed(payload: Record<string, unknown>) {
  const body = JSON.stringify(payload);
  const signature = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
  return new Request('http://localhost/api/internal/erasure', { method: 'POST', body, headers: { [ERASURE_SIGNATURE_HEADER]: signature } });
}

/** A company with one receipt that shows one stored file. Its receipts table carries no stamp, as in production. */
async function company() {
  const ws = await createWorkspace();
  await db.dtTable.updateMany({ where: { workspaceId: ws.workspaceId }, data: { authTenantId: null } });
  const rowId = await ws.addReceipt(plainMealReceipt());
  const fileId = `file-${randomUUID()}`;
  const image = (await ws.adapter.getColumns(ws.tableId)).find((c) => c.name === 'Receipt Image')!;
  await ws.adapter.addFileReference({ rowId, columnId: image.id, fileId, fileUrl: `/api/files/${fileId}`, originalName: 'beleg.jpg', mimeType: 'image/jpeg', metadata: { source: 'ocr-upload' } });
  await db.receiptReview.create({ data: { rowId, authWorkspaceId: ws.workspaceId, authTenantId: ws.tenantId } });
  const eventId = `evt-${randomUUID()}`;
  const payload = { event_id: eventId, kind: 'tenant.erased', tenant_id: ws.tenantId, workspace_ids: [ws.workspaceId], requested_at: '2026-11-21T00:00:00Z' };
  return { ws, rowId, fileId, eventId, payload };
}

describe('POST /api/internal/erasure with the real erasure', () => {
  it('a file store that refuses: 502 with the reason, the receipt and its table stay, the run is recorded as failed', async () => {
    const c = await company();
    eraseStoredFile.mockRejectedValue(new Error('file store answered 503'));

    const res = await POST(signed(c.payload) as never);

    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: 'Erasure failed; will retry', reason: 'stored_file_not_removed' });
    expect(await db.dtTable.count({ where: { id: c.ws.tableId } })).toBe(1);
    expect(await db.dtFile.count({ where: { fileId: c.fileId } })).toBe(1);
    expect(await db.receiptReview.count({ where: { rowId: c.rowId } })).toBe(1);
    expect(await db.erasureEvent.findUniqueOrThrow({ where: { eventId: c.eventId } })).toMatchObject({ status: 'failed', attempts: 1 });
  });

  it('the same delivery again, with the file store back: 200, everything gone, the answer says what an erasure does not remove', async () => {
    const c = await company();
    eraseStoredFile.mockRejectedValueOnce(new Error('file store answered 503'));
    expect((await POST(signed(c.payload) as never)).status).toBe(502);
    eraseStoredFile.mockResolvedValue('removed');

    const res = await POST(signed(c.payload) as never);

    expect(res.status).toBe(200);
    const answer = await res.json();
    expect(answer.erased.register).toMatchObject({ tables: 1, receipts: 1, storedFiles: 1, records: { receipt_reviews: 1 } });
    expect(answer.notErased.map((n: { what: string }) => n.what)).toEqual(['database_backups', 'uploads_never_attached_to_a_receipt']);
    expect(eraseStoredFile).toHaveBeenLastCalledWith(c.fileId);
    expect(await db.dtTable.count({ where: { id: c.ws.tableId } })).toBe(0);
    expect(await db.dtFile.count({ where: { fileId: c.fileId } })).toBe(0);
    expect(await db.receiptReview.count({ where: { rowId: c.rowId } })).toBe(0);
    const row = await db.erasureEvent.findUniqueOrThrow({ where: { eventId: c.eventId } });
    expect(row).toMatchObject({ status: 'completed', attempts: 2, companyId: c.ws.tenantId });
  });

  it('a body without an event kind is refused and nothing is erased', async () => {
    const c = await company();
    const { kind: _kind, ...withoutKind } = c.payload;
    void _kind;
    const res = await POST(signed(withoutKind) as never);
    expect(res.status).toBe(400);
    expect(eraseStoredFile).not.toHaveBeenCalled();
    expect(await db.dtTable.count({ where: { id: c.ws.tableId } })).toBe(1);
  });
});
