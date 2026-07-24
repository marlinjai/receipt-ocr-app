import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { sessionWorkspaceId } from '@/lib/auth-workspace';
import { prisma } from '@/lib/prisma';

export const dynamic = 'force-dynamic';

/**
 * GET /api/sheet-import/config
 *
 * The workspace's most recently used import config, so the import page can
 * prefill the sheet, mapping, dedup identity, and attach preferences for a
 * returning user. `config: null` when nothing was imported yet.
 */
export async function GET() {
  let principal;
  try {
    principal = await auth.requireAction('receipts.import');
  } catch (e) {
    return NextResponse.json({ error: 'forbidden' }, { status: (e as { status?: number }).status ?? 403 });
  }

  const config = await prisma.sheetImportConfig.findFirst({
    where: { authWorkspaceId: sessionWorkspaceId(principal) },
    orderBy: { lastRunAt: 'desc' },
  });
  if (!config) return NextResponse.json({ config: null });

  return NextResponse.json({
    config: {
      spreadsheetId: config.spreadsheetId,
      sheetName: config.sheetName,
      columnMapping: config.columnMapping,
      dedupKeyFields: config.dedupKeyFields,
      attachFolderId: config.attachFolderId,
      attachFolderName: config.attachFolderName,
      sourceFileHeader: config.sourceFileHeader,
    },
  });
}
