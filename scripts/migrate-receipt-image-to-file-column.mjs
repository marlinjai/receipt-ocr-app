/**
 * One-shot data migration: Receipt Image `url` columns → native `file` columns.
 *
 * For every column named "Receipt Image" with type 'url':
 *   1. read each row's cell, parse `/api/files/<id>(/thumbnail)?`,
 *   2. fetch file metadata from Storage Brain (best-effort fallback),
 *   3. insert a dt_files reference (skip when one already exists),
 *   4. clear the cell,
 *   5. flip the column to type 'file' with the receipts config.
 *
 * Idempotent: after the flip, the column no longer matches step 0's filter and
 * the whole script no-ops. Run from start.sh after `prisma migrate deploy`;
 * failures are logged loudly but do NOT block boot (the app degrades to
 * url-cell display, it does not break). Remove this script once prod logs
 * confirm "converted" for every workspace.
 *
 * Unresolvable cells (dead fileId, foreign URL) are logged with their content
 * and cleared — the log preserves the pointer.
 */
import { randomUUID } from 'node:crypto';

const STORAGE_BRAIN_URL = process.env.NEXT_PUBLIC_STORAGE_BRAIN_URL || 'https://api.storage-brain.lumitra.co';
const API_KEY = process.env.STORAGE_BRAIN_API_KEY;
const TAG = '[migrate-file-column]';

// Mirrors @marlinjai/data-table-adapter-shared safeTableName/safeColumnName.
const safeName = (prefix, id) => prefix + id.replace(/-/g, '');

export function parseCellUrl(value) {
  if (typeof value !== 'string') return null;
  const m = value.trim().match(/^\/api\/files\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(\/thumbnail)?$/i);
  if (!m) return null;
  return { fileId: m[1], wasPdfThumb: Boolean(m[2]) };
}

async function fileMetadata(fileId, wasPdfThumb) {
  const fallback = {
    originalName: wasPdfThumb ? 'receipt.pdf' : 'receipt',
    mimeType: wasPdfThumb ? 'application/pdf' : 'application/octet-stream',
    sizeBytes: null,
  };
  if (!API_KEY) return fallback;
  try {
    const res = await fetch(`${STORAGE_BRAIN_URL}/api/v1/files/${fileId}`, {
      headers: { Authorization: `Bearer ${API_KEY}` },
    });
    if (!res.ok) return fallback;
    const data = await res.json();
    const f = data.file ?? data;
    return {
      originalName: f.originalName ?? f.fileName ?? fallback.originalName,
      mimeType: f.mimeType ?? f.fileType ?? fallback.mimeType,
      sizeBytes: f.sizeBytes ?? f.fileSizeBytes ?? null,
    };
  } catch {
    return fallback;
  }
}

async function migrateColumn(prisma, col) {
  const table = await prisma.dtTable.findUnique({ where: { id: col.tableId }, select: { migrated: true } });
  if (!table) return;

  // (rowId, cellValue) pairs from whichever layout the table uses.
  let rows;
  if (table.migrated) {
    const t = safeName('tbl_', col.tableId);
    const c = safeName('col_', col.id);
    rows = (await prisma.$queryRawUnsafe(`SELECT id, ${c} AS value FROM ${t} WHERE ${c} IS NOT NULL AND ${c} <> ''`)).map(
      (r) => ({ rowId: r.id, value: r.value }),
    );
  } else {
    const legacy = await prisma.$queryRawUnsafe(
      `SELECT id, cells->>'${col.id}' AS value FROM dt_rows WHERE table_id = $1 AND cells->>'${col.id}' IS NOT NULL AND cells->>'${col.id}' <> ''`,
      col.tableId,
    );
    rows = legacy.map((r) => ({ rowId: r.id, value: r.value }));
  }

  let converted = 0;
  let skipped = 0;
  let unresolvable = 0;
  for (const { rowId, value } of rows) {
    const parsed = parseCellUrl(value);
    if (!parsed) {
      unresolvable++;
      console.warn(`${TAG} unresolvable cell on row ${rowId}: ${JSON.stringify(value)} — cleared`);
    } else {
      const exists = await prisma.dtFile.findFirst({
        where: { rowId, columnId: col.id, fileId: parsed.fileId },
        select: { id: true },
      });
      if (exists) {
        skipped++;
      } else {
        const meta = await fileMetadata(parsed.fileId, parsed.wasPdfThumb);
        await prisma.dtFile.create({
          data: {
            id: randomUUID(),
            rowId,
            columnId: col.id,
            fileId: parsed.fileId,
            fileUrl: `/api/files/${parsed.fileId}`,
            originalName: meta.originalName,
            mimeType: meta.mimeType,
            sizeBytes: meta.sizeBytes,
            position: 0,
            metadata: { source: 'url-column-migration' },
          },
        });
        converted++;
      }
    }
    // Clear the cell either way: nothing reads url cells anymore.
    if (table.migrated) {
      await prisma.$executeRawUnsafe(
        `UPDATE ${safeName('tbl_', col.tableId)} SET ${safeName('col_', col.id)} = NULL WHERE id = $1`,
        rowId,
      );
    } else {
      await prisma.$executeRawUnsafe(
        `UPDATE dt_rows SET cells = cells - '${col.id}' WHERE id = $1`,
        rowId,
      );
    }
  }

  await prisma.dtColumn.update({
    where: { id: col.id },
    data: {
      type: 'file',
      config: {
        maxFiles: 10,
        allowedTypes: ['application/pdf', 'image/png', 'image/jpeg'],
        maxSizeBytes: 20 * 1024 * 1024,
      },
    },
  });
  console.log(
    `${TAG} converted column ${col.id} (table ${col.tableId}): ${converted} refs created, ${skipped} already present, ${unresolvable} unresolvable`,
  );
}

async function main() {
  const { PrismaClient } = await import('@prisma/client');
  const prisma = new PrismaClient();
  try {
    const cols = await prisma.dtColumn.findMany({
    where: { name: 'Receipt Image', type: 'url' },
    select: { id: true, tableId: true },
  });
  if (cols.length === 0) {
    console.log(`${TAG} nothing to do (no url-typed Receipt Image columns)`);
    return;
  }
  for (const col of cols) await migrateColumn(prisma, col);
  } finally {
    await prisma.$disconnect();
  }
}

// Only run when executed directly (tests import parseCellUrl).
if (process.argv[1] && process.argv[1].endsWith('migrate-receipt-image-to-file-column.mjs')) {
  main().catch((e) => {
    console.error(`${TAG} FAILED:`, e);
    process.exitCode = 1;
  });
}
