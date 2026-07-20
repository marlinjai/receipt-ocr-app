import { NextRequest, NextResponse } from 'next/server';
import type { AppSession } from '@marlinjai/auth-brain-nextjs';
import { auth } from '@/lib/auth';
import { getAccessTokenForUser } from '@/lib/sheet-import/google-credentials';
import {
  parseSpreadsheetId,
  listSheetTabs,
  readSheetValues,
  gridToRows,
  SheetsApiError,
} from '@/lib/sheet-import/sheets-client';

export const dynamic = 'force-dynamic';

/**
 * POST /api/sheet-import/preview
 * Body: { spreadsheet: string (URL or id), tab?: string, headerRow?: number }
 *
 * Reads the chosen tab via the user's Google connection and returns its headers
 * + a sample of rows, so the mapping UI can show the user what they're about to
 * import. Gated by `receipts.import`; returns `{ connected: false }` (not an
 * error) when the user hasn't linked Google yet, so the UI can prompt them.
 */
export async function POST(req: NextRequest) {
  let principal: AppSession;
  try {
    principal = await auth.requireAction('receipts.import');
  } catch (e) {
    const status = (e as { status?: number }).status ?? 403;
    return NextResponse.json({ error: 'forbidden' }, { status });
  }

  const body = (await req.json().catch(() => ({}))) as {
    spreadsheet?: unknown;
    tab?: unknown;
    headerRow?: unknown;
  };
  const spreadsheetId = parseSpreadsheetId(String(body.spreadsheet ?? ''));
  if (!spreadsheetId) return NextResponse.json({ error: 'invalid_spreadsheet' }, { status: 400 });

  const accessToken = await getAccessTokenForUser(principal.userId);
  if (!accessToken) return NextResponse.json({ connected: false }, { status: 200 });

  const headerRow = Number(body.headerRow) || 1;
  try {
    const tabs = await listSheetTabs(accessToken, spreadsheetId);
    if (tabs.length === 0) return NextResponse.json({ error: 'no_tabs' }, { status: 400 });
    const tab = typeof body.tab === 'string' && tabs.includes(body.tab) ? body.tab : tabs[0]!;
    const values = await readSheetValues(accessToken, spreadsheetId, tab);
    const { headers, rows } = gridToRows(values, headerRow);
    return NextResponse.json({
      connected: true,
      spreadsheetId,
      tabs,
      tab,
      headerRow,
      headers,
      sampleRows: rows.slice(0, 10),
      totalRows: rows.length,
    });
  } catch (e) {
    if (e instanceof SheetsApiError) {
      // 403/404 are the user's problem (no access / wrong id) -> 400; anything
      // else is an upstream fault -> 502.
      const status = e.status === 403 || e.status === 404 ? 400 : 502;
      return NextResponse.json({ error: 'sheets_api', upstreamStatus: e.status }, { status });
    }
    throw e;
  }
}
