/**
 * Thin Google Sheets API v4 client (read-only) plus pure helpers. The two
 * network calls are mockable via fetch; parseSpreadsheetId and gridToRows are
 * pure and unit-tested.
 */

export class SheetsApiError extends Error {
  readonly status: number;
  constructor(status: number, detail: string) {
    super(`Google Sheets API error ${status}: ${detail}`);
    this.name = 'SheetsApiError';
    this.status = status;
  }
}

/** Extract a spreadsheet id from a full Sheets URL or accept a bare id. */
export function parseSpreadsheetId(input: string): string | null {
  const s = input.trim();
  const inUrl = s.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  if (inUrl) return inUrl[1]!;
  if (/^[a-zA-Z0-9-_]{20,}$/.test(s)) return s;
  return null;
}

/**
 * Turn a raw values grid into headers + row objects keyed by header name.
 * `headerRow` is 1-based (the sheet's header line). Rows above it are ignored;
 * short rows are padded so every header key exists.
 */
export function gridToRows(
  values: string[][],
  headerRow = 1,
): { headers: string[]; rows: Record<string, string>[] } {
  const headerIdx = Math.max(0, headerRow - 1);
  const headers = (values[headerIdx] ?? []).map((h) => String(h ?? '').trim());
  const rows: Record<string, string>[] = [];
  for (let i = headerIdx + 1; i < values.length; i++) {
    const raw = values[i] ?? [];
    if (raw.every((c) => String(c ?? '').trim() === '')) continue; // skip blank lines
    const obj: Record<string, string> = {};
    headers.forEach((h, c) => {
      if (h) obj[h] = String(raw[c] ?? '');
    });
    rows.push(obj);
  }
  return { headers, rows };
}

const SHEETS_BASE = 'https://sheets.googleapis.com/v4/spreadsheets';

async function sheetsGet(accessToken: string, path: string): Promise<unknown> {
  const res = await fetch(`${SHEETS_BASE}${path}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new SheetsApiError(res.status, await res.text().catch(() => ''));
  return res.json();
}

/** Tab (sheet) titles within a spreadsheet. */
export async function listSheetTabs(accessToken: string, spreadsheetId: string): Promise<string[]> {
  const data = (await sheetsGet(
    accessToken,
    `/${encodeURIComponent(spreadsheetId)}?fields=sheets.properties.title`,
  )) as { sheets?: { properties?: { title?: string } }[] };
  return (data.sheets ?? []).map((s) => s.properties?.title ?? '').filter(Boolean);
}

/** Raw values for a range (e.g. a whole tab by its title). */
export async function readSheetValues(
  accessToken: string,
  spreadsheetId: string,
  range: string,
): Promise<string[][]> {
  const data = (await sheetsGet(
    accessToken,
    `/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}`,
  )) as { values?: string[][] };
  return data.values ?? [];
}
