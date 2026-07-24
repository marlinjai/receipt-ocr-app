/**
 * Minimal Google Drive v3 read-only client for the source-PDF attach step,
 * plus the pure filename matcher. Network calls go through fetch (mockable);
 * the matcher is pure and unit-tested (sheet filenames drift from Drive names
 * in casing, spaces vs hyphens, and separators, e.g. "eleven-labs.pdf" vs
 * "eleven labs.pdf").
 */

export class DriveApiError extends Error {
  readonly status: number;
  constructor(status: number, detail: string) {
    super(`Google Drive API error ${status}: ${detail}`);
    this.name = 'DriveApiError';
    this.status = status;
  }
}

export interface DriveFile {
  id: string;
  name: string;
  mimeType?: string;
  size?: string;
}

const DRIVE_BASE = 'https://www.googleapis.com/drive/v3';

/** List non-trashed files in a folder (or the whole Drive when no folder). */
export async function listDriveFiles(
  accessToken: string,
  folderId?: string,
): Promise<DriveFile[]> {
  const q = folderId ? `'${folderId.replace(/'/g, "\\'")}' in parents and trashed = false` : 'trashed = false';
  const out: DriveFile[] = [];
  let pageToken: string | undefined;
  do {
    const url = new URL(`${DRIVE_BASE}/files`);
    url.searchParams.set('q', q);
    url.searchParams.set('fields', 'nextPageToken, files(id, name, mimeType, size)');
    url.searchParams.set('pageSize', '1000');
    url.searchParams.set('supportsAllDrives', 'true');
    url.searchParams.set('includeItemsFromAllDrives', 'true');
    url.searchParams.set('corpora', 'allDrives');
    if (pageToken) url.searchParams.set('pageToken', pageToken);
    const res = await fetch(url.toString(), { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!res.ok) throw new DriveApiError(res.status, await res.text().catch(() => ''));
    const data = (await res.json()) as { files?: DriveFile[]; nextPageToken?: string };
    out.push(...(data.files ?? []));
    pageToken = data.nextPageToken;
  } while (pageToken);
  return out;
}

/** Find a folder by exact name (first match). */
export async function findFolderByName(accessToken: string, name: string): Promise<DriveFile | null> {
  const url = new URL(`${DRIVE_BASE}/files`);
  url.searchParams.set(
    'q',
    `name = '${name.replace(/'/g, "\\'")}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
  );
  url.searchParams.set('fields', 'files(id, name)');
  url.searchParams.set('pageSize', '5');
  url.searchParams.set('supportsAllDrives', 'true');
  url.searchParams.set('includeItemsFromAllDrives', 'true');
  url.searchParams.set('corpora', 'allDrives');
  const res = await fetch(url.toString(), { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) throw new DriveApiError(res.status, await res.text().catch(() => ''));
  const data = (await res.json()) as { files?: DriveFile[] };
  return data.files?.[0] ?? null;
}

/** Download a file's bytes. */
export async function downloadDriveFile(accessToken: string, fileId: string): Promise<ArrayBuffer> {
  const res = await fetch(`${DRIVE_BASE}/files/${encodeURIComponent(fileId)}?alt=media&supportsAllDrives=true`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new DriveApiError(res.status, await res.text().catch(() => ''));
  return res.arrayBuffer();
}

/** Normalize a filename for fuzzy matching: lowercase, alnum+dots only. */
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9.]/g, '');

/**
 * Match a sheet's Source File value against the Drive folder listing:
 * exact name first, then normalized (case/space/hyphen/separator-insensitive).
 * Returns null when nothing plausibly matches — the caller reports it rather
 * than guessing.
 */
export function matchSourceFile(sourceFile: string, files: DriveFile[]): DriveFile | null {
  const wanted = sourceFile.trim();
  if (!wanted) return null;
  const exact = files.find((f) => f.name === wanted);
  if (exact) return exact;
  const wantedNorm = norm(wanted);
  return files.find((f) => norm(f.name) === wantedNorm) ?? null;
}
