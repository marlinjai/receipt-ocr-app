import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { findFileDuplicate, findSimilarReceipt } from '../duplicates';
import { createWorkspace, db, plainMealReceipt, type TestWorkspace } from '../../../../test/db-helpers';

/** Duplicate detection against a real database (`pnpm test:db`). */

let ws: TestWorkspace;
let other: TestWorkspace;

const HASH_A = 'a1'.repeat(32);
const HASH_B = 'b2'.repeat(32);

async function attach(workspace: TestWorkspace, rowId: string, sha256: string | null, fileId: string) {
  const columns = await workspace.adapter.getColumns(workspace.tableId);
  const imageCol = columns.find((c) => c.name === 'Receipt Image')!;
  await workspace.adapter.addFileReference({
    rowId,
    columnId: imageCol.id,
    fileId,
    fileUrl: `/api/files/${fileId}`,
    originalName: 'beleg.jpg',
    mimeType: 'image/jpeg',
    metadata: sha256 ? { source: 'ocr-upload', sha256 } : { source: 'ocr-upload' },
  });
}

beforeAll(async () => {
  ws = await createWorkspace();
  other = await createWorkspace();
});

afterAll(async () => {
  await db.$disconnect();
});

describe('findFileDuplicate', () => {
  it('finds the receipt that already holds exactly this file', async () => {
    const rowId = await ws.addReceipt(plainMealReceipt({ Name: 'Abendessen Beispielwirt' }));
    await attach(ws, rowId, HASH_A, '00000000-0000-4000-8000-00000000000a');
    expect(await findFileDuplicate(db, ws.workspaceId, HASH_A)).toEqual({ rowId, name: 'Abendessen Beispielwirt' });
  });

  it('knows nothing about an unseen hash, or about files stored before hashes were recorded', async () => {
    const rowId = await ws.addReceipt(plainMealReceipt());
    await attach(ws, rowId, null, '00000000-0000-4000-8000-00000000000c');
    expect(await findFileDuplicate(db, ws.workspaceId, 'c3'.repeat(32))).toBeNull();
  });

  it('never reports a match that lives in another workspace', async () => {
    const foreign = await other.addReceipt(plainMealReceipt());
    await attach(other, foreign, HASH_B, '00000000-0000-4000-8000-00000000000b');
    expect(await findFileDuplicate(db, ws.workspaceId, HASH_B)).toBeNull();
    expect(await findFileDuplicate(db, other.workspaceId, HASH_B)).toMatchObject({ rowId: foreign });
  });

  it('a deleted receipt no longer counts as a duplicate', async () => {
    const hash = 'd4'.repeat(32);
    const rowId = await ws.addReceipt(plainMealReceipt());
    await attach(ws, rowId, hash, '00000000-0000-4000-8000-00000000000d');
    await ws.adapter.deleteRow(rowId);
    expect(await findFileDuplicate(db, ws.workspaceId, hash)).toBeNull();
  });
});

describe('findSimilarReceipt', () => {
  it('warns about another receipt with the same vendor, day and total, ignoring case and time of day', async () => {
    const fresh = await createWorkspace();
    const first = await fresh.addReceipt(plainMealReceipt({ Vendor: 'Gasthaus Probe', Date: '2025-04-02', Gross: 48.5 }));
    const second = await fresh.addReceipt(plainMealReceipt({ Vendor: 'Gasthaus Probe', Date: '2025-04-02', Gross: 48.5 }));
    expect(
      await findSimilarReceipt(db, fresh.workspaceId, { vendor: ' gasthaus probe ', date: '2025-04-02T19:30:00.000Z', gross: 48.5 }, second),
    ).toMatchObject({ rowId: first });
  });

  it('does not match the row itself, a different total, a different day or a different vendor', async () => {
    const fresh = await createWorkspace();
    const only = await fresh.addReceipt(plainMealReceipt({ Vendor: 'Gasthaus Probe', Date: '2025-04-02', Gross: 48.5 }));
    const id = { vendor: 'Gasthaus Probe', date: '2025-04-02', gross: 48.5 };
    expect(await findSimilarReceipt(db, fresh.workspaceId, id, only)).toBeNull();
    expect(await findSimilarReceipt(db, fresh.workspaceId, { ...id, gross: 48.6 }, 'new')).toBeNull();
    expect(await findSimilarReceipt(db, fresh.workspaceId, { ...id, date: '2025-04-03' }, 'new')).toBeNull();
    expect(await findSimilarReceipt(db, fresh.workspaceId, { ...id, vendor: 'Anderes Lokal' }, 'new')).toBeNull();
    expect(await findSimilarReceipt(db, fresh.workspaceId, id, 'new')).toMatchObject({ rowId: only });
  });

  it('gives no warning without a basis: vendor, date or total missing', async () => {
    const fresh = await createWorkspace();
    await fresh.addReceipt(plainMealReceipt({ Vendor: 'Gasthaus Probe', Date: '2025-04-02', Gross: 48.5 }));
    expect(await findSimilarReceipt(db, fresh.workspaceId, { vendor: null, date: '2025-04-02', gross: 48.5 }, 'new')).toBeNull();
    expect(await findSimilarReceipt(db, fresh.workspaceId, { vendor: 'Gasthaus Probe', date: null, gross: 48.5 }, 'new')).toBeNull();
    expect(await findSimilarReceipt(db, fresh.workspaceId, { vendor: 'Gasthaus Probe', date: '2025-04-02', gross: null }, 'new')).toBeNull();
  });

  it('never matches across workspaces', async () => {
    const a = await createWorkspace();
    const b = await createWorkspace();
    await a.addReceipt(plainMealReceipt({ Vendor: 'Gasthaus Probe', Date: '2025-04-02', Gross: 48.5 }));
    expect(
      await findSimilarReceipt(db, b.workspaceId, { vendor: 'Gasthaus Probe', date: '2025-04-02', gross: 48.5 }, 'new'),
    ).toBeNull();
  });
});
