import 'server-only';
import { PrismaAdapter } from '@marlinjai/data-table-adapter-prisma';
import { prisma } from '@/lib/prisma';
import { getAccessTokenForUser } from './google-credentials';
import { readSheetValues, gridToRows } from './sheets-client';
import { mapRow, computeDedupKey, type ColumnMapping, type ImportableField } from './normalize';
import { listDriveFiles, findFolderByName, matchSourceFile, downloadDriveFile, DriveApiError } from './drive-client';

const TABLE_NAME = 'Receipts';
const STORAGE_BRAIN_URL = process.env.NEXT_PUBLIC_STORAGE_BRAIN_URL || 'https://api.storage-brain.lumitra.co';

export class AttachError extends Error {
  readonly code: string;
  constructor(code: string, message?: string) {
    super(message ?? code);
    this.code = code;
    this.name = 'AttachError';
  }
}

export interface AttachInput {
  authWorkspaceId: string;
  authUserId: string;
  /** Sheet column holding the source filename (default "Source File"). */
  sourceFileHeader?: string;
  /** Drive folder name to search in (default "Rechnungen"). */
  folderName?: string;
}

export interface AttachResult {
  attached: number;
  alreadyAttached: number;
  missingInDrive: string[];
  unmatchedRows: number;
  noSourceFile: number;
}

const contentType = (name: string): string =>
  name.toLowerCase().endsWith('.pdf')
    ? 'application/pdf'
    : name.toLowerCase().match(/\.(jpe?g)$/)
      ? 'image/jpeg'
      : name.toLowerCase().endsWith('.png')
        ? 'image/png'
        : 'application/octet-stream';

/** Upload bytes to Storage Brain (request presigned → PUT), returns the file id. */
async function uploadToStorageBrain(name: string, bytes: ArrayBuffer): Promise<string> {
  const apiKey = process.env.STORAGE_BRAIN_API_KEY;
  if (!apiKey) throw new AttachError('storage_brain_unconfigured');

  const handshake = await fetch(`${STORAGE_BRAIN_URL}/api/v1/upload/request`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      fileName: name,
      fileType: contentType(name),
      fileSizeBytes: bytes.byteLength,
      context: 'receipt',
      tags: ['drive-attach'],
    }),
  });
  if (!handshake.ok) throw new AttachError('storage_brain_request_failed', await handshake.text().catch(() => ''));
  const { presignedUrl, fileId } = (await handshake.json()) as { presignedUrl: string; fileId: string };

  const target = presignedUrl.startsWith('/') ? `${STORAGE_BRAIN_URL}${presignedUrl}` : presignedUrl;
  const put = await fetch(target, {
    method: 'PUT',
    headers: { 'Content-Type': contentType(name) },
    body: bytes,
  });
  if (!put.ok) throw new AttachError('storage_brain_put_failed', String(put.status));
  return fileId;
}

/**
 * Attach the Drive source PDFs to imported ledger rows.
 *
 * Uses the workspace's saved SheetImportConfig: re-reads the sheet, computes
 * each row's dedup key, resolves it to a dt row via the import ledger, reads
 * the row's Source File column, finds the file in the Drive folder (exact then
 * normalized name match), downloads it, uploads to Storage Brain, and sets the
 * row's Receipt Image to /api/files/<id>. Idempotent: rows that already have a
 * Receipt Image are skipped.
 */
export async function attachSourceFiles(input: AttachInput): Promise<AttachResult> {
  const config = await prisma.sheetImportConfig.findFirst({
    where: { authWorkspaceId: input.authWorkspaceId },
    orderBy: { lastRunAt: 'desc' },
  });
  if (!config) throw new AttachError('no_import_config');

  const accessToken = await getAccessTokenForUser(input.authUserId);
  if (!accessToken) throw new AttachError('not_connected');

  // Drive folder + listing (a 403 on Drive = the pre-Drive-scope connection).
  let folder;
  try {
    folder = await findFolderByName(accessToken, input.folderName ?? 'Rechnungen');
  } catch (e) {
    if (e instanceof DriveApiError && e.status === 403) throw new AttachError('drive_scope_missing');
    throw e;
  }
  if (!folder) throw new AttachError('folder_not_found');
  const driveFiles = await listDriveFiles(accessToken, folder.id);

  // Sheet rows + the import ledger.
  const values = await readSheetValues(accessToken, config.spreadsheetId, config.sheetName);
  const { rows } = gridToRows(values, config.headerRow);
  const mapping = config.columnMapping as ColumnMapping;
  const dedupFields = config.dedupKeyFields as ImportableField[];
  const ledger = new Map(
    (await prisma.sheetImportRow.findMany({ where: { configId: config.id }, select: { dedupKey: true, dtRowId: true } })).map(
      (r) => [r.dedupKey, r.dtRowId],
    ),
  );

  // Receipts table columns.
  const adapter = new PrismaAdapter({ prisma });
  const tables = await adapter.listTables(input.authWorkspaceId);
  const table = tables.find((t) => t.name === TABLE_NAME);
  if (!table) throw new AttachError('table_not_initialized');
  const columns = await adapter.getColumns(table.id);
  const imageCol = columns.find((c) => c.name === 'Receipt Image');
  if (!imageCol) throw new AttachError('image_column_missing');

  const sourceHeader = input.sourceFileHeader ?? 'Source File';
  const result: AttachResult = { attached: 0, alreadyAttached: 0, missingInDrive: [], unmatchedRows: 0, noSourceFile: 0 };
  const seen = new Set<string>();

  for (const raw of rows) {
    const key = computeDedupKey(mapRow(raw, mapping), dedupFields);
    if (seen.has(key)) continue;
    seen.add(key);

    const dtRowId = ledger.get(key);
    if (!dtRowId) {
      result.unmatchedRows++;
      continue;
    }
    const sourceFile = (raw[sourceHeader] ?? '').trim();
    if (!sourceFile) {
      result.noSourceFile++;
      continue;
    }

    const row = await adapter.getRow(dtRowId);
    if (!row) {
      result.unmatchedRows++;
      continue;
    }
    const existing = row.cells[imageCol.id];
    if (typeof existing === 'string' && existing.trim()) {
      result.alreadyAttached++;
      continue;
    }

    const driveFile = matchSourceFile(sourceFile, driveFiles);
    if (!driveFile) {
      result.missingInDrive.push(sourceFile);
      continue;
    }

    const bytes = await downloadDriveFile(accessToken, driveFile.id);
    const fileId = await uploadToStorageBrain(driveFile.name, bytes);
    await adapter.updateRow(dtRowId, { [imageCol.id]: `/api/files/${fileId}` });
    result.attached++;
  }

  return result;
}
