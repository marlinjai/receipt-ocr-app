import { NextRequest, NextResponse } from 'next/server';
import type { AppSession } from '@marlinjai/auth-brain-nextjs';
import { auth } from '@/lib/auth';
import { sessionWorkspaceId } from '@/lib/auth-workspace';
import { runSheetImport, SheetImportError } from '@/lib/sheet-import/run';
import { SheetsApiError } from '@/lib/sheet-import/sheets-client';
import { IMPORTABLE_FIELDS, type ColumnMapping, type ImportableField } from '@/lib/sheet-import/normalize';

export const dynamic = 'force-dynamic';

const IS_FIELD = (v: unknown): v is ImportableField => typeof v === 'string' && v in IMPORTABLE_FIELDS;

/** Keep only entries whose key is a real importable field with a non-empty header. */
function cleanMapping(raw: unknown): ColumnMapping {
  const out: ColumnMapping = {};
  if (raw && typeof raw === 'object') {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (IS_FIELD(k) && typeof v === 'string' && v.trim()) out[k] = v;
    }
  }
  return out;
}

const SHEET_ERROR_STATUS: Record<string, number> = {
  invalid_spreadsheet: 400,
  no_tab: 400,
  no_dedup_fields: 400,
  table_not_initialized: 409,
  not_connected: 428, // Precondition Required: connect Google first
};

/**
 * POST /api/sheet-import/run
 * Body: { spreadsheet, tab, headerRow?, columnMapping, dedupKeyFields }
 * Imports the sheet into the active workspace's Receipts table (idempotent).
 */
export async function POST(req: NextRequest) {
  let principal: AppSession;
  try {
    principal = await auth.requireAction('receipts.import');
  } catch (e) {
    return NextResponse.json({ error: 'forbidden' }, { status: (e as { status?: number }).status ?? 403 });
  }

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const columnMapping = cleanMapping(body.columnMapping);
  const dedupKeyFields = Array.isArray(body.dedupKeyFields) ? body.dedupKeyFields.filter(IS_FIELD) : [];

  if (Object.keys(columnMapping).length === 0) {
    return NextResponse.json({ error: 'empty_mapping' }, { status: 400 });
  }

  try {
    const result = await runSheetImport({
      authWorkspaceId: sessionWorkspaceId(principal),
      authUserId: principal.userId,
      spreadsheet: String(body.spreadsheet ?? ''),
      tab: String(body.tab ?? ''),
      headerRow: Number(body.headerRow) || 1,
      columnMapping,
      dedupKeyFields,
    });
    return NextResponse.json(result);
  } catch (e) {
    if (e instanceof SheetImportError) {
      return NextResponse.json({ error: e.code }, { status: SHEET_ERROR_STATUS[e.code] ?? 400 });
    }
    if (e instanceof SheetsApiError) {
      const status = e.status === 403 || e.status === 404 ? 400 : 502;
      return NextResponse.json({ error: 'sheets_api', upstreamStatus: e.status }, { status });
    }
    throw e;
  }
}
