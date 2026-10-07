import { buildRegister, exportRefusal } from './register';
import { CSV_BOM, registerCsv } from './register-csv';
import { registerPdf, type ReceiptFileLoader } from './register-pdf';
import type { MealRecord, MealTaxSettings } from './types';

/**
 * The register export, independent of the web framework: parse the request,
 * decide whether an export may be produced, produce it. The route handler
 * supplies the workspace (from the verified session) and the data loaders.
 */

export interface RegisterExportDeps {
  /** From the verified session. Never from the request. */
  workspaceId: string;
  workspaceLabel: string;
  loadRecords: (workspaceId: string) => Promise<MealRecord[]>;
  loadSettings: (workspaceId: string) => Promise<MealTaxSettings>;
  loadFile: ReceiptFileLoader;
  now: () => Date;
}

export interface RegisterExportResponse {
  status: number;
  headers: Record<string, string>;
  body: Uint8Array | string;
}

function json(status: number, payload: unknown): RegisterExportResponse {
  return {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
    body: JSON.stringify(payload),
  };
}

export async function registerExport(
  query: URLSearchParams,
  deps: RegisterExportDeps,
): Promise<RegisterExportResponse> {
  const yearRaw = query.get('year') ?? '';
  const year = /^\d{4}$/.test(yearRaw) ? Number(yearRaw) : NaN;
  if (!Number.isInteger(year) || year < 2000 || year > 2100) {
    return json(400, { error: 'invalid_year' });
  }
  const format = query.get('format');
  if (format !== 'csv' && format !== 'pdf') return json(400, { error: 'invalid_format' });
  const ackRaw = query.get('ack');
  const acknowledged = ackRaw !== null && /^\d+$/.test(ackRaw) ? Number(ackRaw) : null;

  const [records, settings] = await Promise.all([
    deps.loadRecords(deps.workspaceId),
    deps.loadSettings(deps.workspaceId),
  ]);
  const register = buildRegister(records, settings, year);

  const refusal = exportRefusal(register, acknowledged);
  if (refusal) return json(409, { error: refusal.code, ...('incompleteCount' in refusal ? { incompleteCount: refusal.incompleteCount } : {}) });

  const baseName = `bewirtungsverzeichnis-${year}`;
  if (format === 'csv') {
    return {
      status: 200,
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${baseName}.csv"`,
        'Cache-Control': 'no-store',
      },
      body: CSV_BOM + registerCsv(register),
    };
  }

  const { bytes, warnings } = await registerPdf({
    register,
    workspaceLabel: deps.workspaceLabel,
    generatedAt: deps.now(),
    loadFile: deps.loadFile,
  });
  return {
    status: 200,
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${baseName}.pdf"`,
      'Cache-Control': 'no-store',
      // Header values must be ASCII; the page decodes and shows these after the download.
      'X-Register-Warnings': encodeURIComponent(JSON.stringify(warnings)),
    },
    body: bytes,
  };
}
