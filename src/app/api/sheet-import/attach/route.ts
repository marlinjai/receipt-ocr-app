import { NextRequest, NextResponse } from 'next/server';
import type { AppSession } from '@marlinjai/auth-brain-nextjs';
import { auth } from '@/lib/auth';
import { sessionWorkspaceId } from '@/lib/auth-workspace';
import { attachSourceFiles, AttachError } from '@/lib/sheet-import/attach';
import { DriveApiError } from '@/lib/sheet-import/drive-client';
import { SheetsApiError } from '@/lib/sheet-import/sheets-client';

export const dynamic = 'force-dynamic';

const ERROR_STATUS: Record<string, number> = {
  no_import_config: 409,
  not_connected: 428,
  drive_scope_missing: 428,
  folder_not_found: 404,
  table_not_initialized: 409,
  image_column_missing: 409,
  storage_brain_unconfigured: 500,
  storage_brain_request_failed: 502,
  storage_brain_put_failed: 502,
};

/**
 * POST /api/sheet-import/attach
 * Body: { sourceFileHeader?, folderName? }
 * Attaches the Drive source PDFs to the workspace's imported rows (idempotent).
 */
export async function POST(req: NextRequest) {
  let principal: AppSession;
  try {
    principal = await auth.requireAction('receipts.import');
  } catch (e) {
    return NextResponse.json({ error: 'forbidden' }, { status: (e as { status?: number }).status ?? 403 });
  }

  const body = (await req.json().catch(() => ({}))) as { sourceFileHeader?: unknown; folderName?: unknown };
  try {
    const result = await attachSourceFiles({
      authWorkspaceId: sessionWorkspaceId(principal),
      authUserId: principal.userId,
      sourceFileHeader: typeof body.sourceFileHeader === 'string' && body.sourceFileHeader.trim() ? body.sourceFileHeader.trim() : undefined,
      folderName: typeof body.folderName === 'string' && body.folderName.trim() ? body.folderName.trim() : undefined,
    });
    return NextResponse.json(result);
  } catch (e) {
    if (e instanceof AttachError) {
      // Upstream detail (e.g. the Storage Brain error body) never reaches the
      // client, but it must reach the logs or failures are undiagnosable.
      if (e.code.startsWith('storage_brain')) console.error('[sheet-import/attach]', e.code, e.message);
      return NextResponse.json({ error: e.code }, { status: ERROR_STATUS[e.code] ?? 400 });
    }
    if (e instanceof DriveApiError || e instanceof SheetsApiError) {
      const status = e.status === 403 || e.status === 404 ? 400 : 502;
      return NextResponse.json({ error: 'google_api', upstreamStatus: e.status }, { status });
    }
    throw e;
  }
}
