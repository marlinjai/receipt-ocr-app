import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { getAccessTokenForUser } from '@/lib/sheet-import/google-credentials';
import { listChildren, listSharedDrives, classifyBrowseEntries, DriveApiError } from '@/lib/sheet-import/drive-client';

export const dynamic = 'force-dynamic';

/**
 * GET /api/google/drive/browse?parent=root|shared|<folderId>
 *
 * One level of the user's Drive hierarchy for the import page's pickers:
 * child folders plus the files the flow can use (spreadsheets, PDF/PNG/JPEG).
 * `shared` is the Shared-with-me pseudo-folder; `drive:<id>` is a shared
 * drive's root. At `root`, the response also carries the user's shared drives
 * (they are a separate corpus, invisible from My Drive and Shared-with-me).
 */
export async function GET(req: NextRequest) {
  let principal;
  try {
    principal = await auth.requireAction('receipts.import');
  } catch (e) {
    return NextResponse.json({ error: 'forbidden' }, { status: (e as { status?: number }).status ?? 403 });
  }

  const accessToken = await getAccessTokenForUser(principal.userId);
  if (!accessToken) return NextResponse.json({ error: 'not_connected' }, { status: 428 });

  const parent = req.nextUrl.searchParams.get('parent')?.trim() || 'root';
  // Drive file/drive ids are URL-safe tokens; anything else would end up
  // inside a Drive query string, so reject it up front.
  if (parent !== 'root' && parent !== 'shared' && !/^(drive:)?[A-Za-z0-9_-]+$/.test(parent)) {
    return NextResponse.json({ error: 'invalid_parent' }, { status: 400 });
  }

  try {
    const [entries, sharedDrives] = await Promise.all([
      listChildren(accessToken, parent),
      parent === 'root' ? listSharedDrives(accessToken) : Promise.resolve([]),
    ]);
    return NextResponse.json({ ...classifyBrowseEntries(entries), sharedDrives });
  } catch (e) {
    if (e instanceof DriveApiError) {
      if (e.status === 403) return NextResponse.json({ error: 'drive_scope_missing' }, { status: 428 });
      if (e.status === 404) return NextResponse.json({ error: 'folder_not_found' }, { status: 404 });
      return NextResponse.json({ error: 'google_api', upstreamStatus: e.status }, { status: 502 });
    }
    throw e;
  }
}
