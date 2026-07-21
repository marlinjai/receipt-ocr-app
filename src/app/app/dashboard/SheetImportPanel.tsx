'use client';

import { useState, useCallback } from 'react';
import { IMPORTABLE_FIELD_NAMES, type ImportableField, type ColumnMapping } from '@/lib/sheet-import/fields';

/**
 * "Import from Sheets" toolbar panel: connect Google (per-user OAuth), point at
 * a spreadsheet + tab, map its columns onto the Receipts fields, pick the dedup
 * identity, and import. Re-running is safe (server upserts by the dedup key).
 */

interface PreviewData {
  connected: boolean;
  spreadsheetId?: string;
  tabs?: string[];
  tab?: string;
  headers?: string[];
  sampleRows?: Record<string, string>[];
  totalRows?: number;
}

const DEFAULT_DEDUP: ImportableField[] = ['Vendor', 'Date', 'Gross'];

const inputStyle = {
  background: 'var(--background)',
  border: '1px solid var(--border)',
  color: 'var(--foreground)',
} as const;

// Extra header aliases per field, so common invoice-sheet columns map without
// hand-wiring (e.g. "Amount" -> Gross, "Lola Share" -> Business Share %).
const FIELD_ALIASES: Partial<Record<ImportableField, string[]>> = {
  Gross: ['amount', 'betrag', 'total', 'bruttobetrag', 'gross'],
  Net: ['nettobetrag', 'netamount'],
  'Business Share %': ['share', 'lolashare', 'businessshare', 'anteil'],
  Name: ['invoice', 'invoiceno', 'invoicenumber', 'rechnungsnr', 'description', 'beschreibung'],
  Date: ['rechnungsdatum', 'invoicedate'],
  Vendor: ['lieferant', 'supplier', 'merchant'],
  Konto: ['account', 'konto'],
};

// Best-effort initial mapping: match each field to a header by (case/space-
// insensitive) equality, then a substring hit, then a known alias. The user
// adjusts from there; the mapping is saved server-side on first import.
function guessMapping(headers: string[]): ColumnMapping {
  const norm = (s: string) => s.toLowerCase().replace(/[\s._%#()-]/g, '');
  const used = new Set<string>();
  const out: ColumnMapping = {};
  const pick = (h: string | undefined, field: ImportableField) => {
    if (h && !used.has(h)) {
      out[field] = h;
      used.add(h);
    }
  };
  for (const field of IMPORTABLE_FIELD_NAMES) {
    const nf = norm(field);
    const exact = headers.find((h) => norm(h) === nf && !used.has(h));
    const partial = exact ?? headers.find((h) => !used.has(h) && (norm(h).includes(nf) || nf.includes(norm(h))));
    const aliases = FIELD_ALIASES[field] ?? [];
    const aliased = partial ?? headers.find((h) => !used.has(h) && aliases.some((a) => norm(h).includes(a)));
    pick(aliased, field);
  }
  return out;
}

export default function SheetImportPanel() {
  const [open, setOpen] = useState(false);
  const [preview, setPreview] = useState<PreviewData | null>(null);
  const [spreadsheet, setSpreadsheet] = useState('');
  const [mapping, setMapping] = useState<ColumnMapping>({});
  const [dedup, setDedup] = useState<ImportableField[]>(DEFAULT_DEDUP);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ imported: number; updated: number; skipped: number; total: number } | null>(null);

  const load = useCallback(
    async (tab?: string) => {
      if (!spreadsheet.trim()) return;
      setBusy(true);
      setError(null);
      setResult(null);
      try {
        const res = await fetch('/api/sheet-import/preview', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ spreadsheet, tab }),
        });
        const data = (await res.json()) as PreviewData & { error?: string };
        if (!res.ok) {
          setError(data.error ?? 'Failed to load sheet');
          return;
        }
        setPreview(data);
        if (data.connected && data.headers && Object.keys(mapping).length === 0) {
          setMapping(guessMapping(data.headers));
        }
      } catch {
        setError('Failed to load sheet');
      } finally {
        setBusy(false);
      }
    },
    [spreadsheet, mapping],
  );

  const runImport = useCallback(async () => {
    if (!preview?.tab) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch('/api/sheet-import/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          spreadsheet,
          tab: preview.tab,
          headerRow: 1,
          columnMapping: mapping,
          dedupKeyFields: dedup.filter((f) => mapping[f]),
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? 'Import failed');
        return;
      }
      setResult(data);
    } catch {
      setError('Import failed');
    } finally {
      setBusy(false);
    }
  }, [spreadsheet, preview, mapping, dedup]);

  const notConnected = preview?.connected === false;
  const headers = preview?.headers ?? [];

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium rounded-lg transition-all duration-200"
        style={{
          background: open ? 'var(--accent-muted)' : 'var(--surface)',
          color: open ? 'var(--accent)' : 'var(--foreground)',
          border: `1px solid ${open ? 'rgba(226, 163, 72, 0.4)' : 'var(--border)'}`,
        }}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M14 3v4a1 1 0 0 0 1 1h4" />
          <path d="M17 21H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h7l5 5v11a2 2 0 0 1-2 2z" />
          <path d="M9 13h6M9 17h6" />
        </svg>
        Import from Sheets
      </button>

      {open && (
        <div
          className="absolute right-0 top-full mt-2 z-30 w-96 rounded-lg p-4 shadow-xl max-h-[80vh] overflow-y-auto"
          style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}
        >
          {/* Step 1: connect / point at a sheet */}
          <label className="text-xs block mb-1" style={{ color: 'var(--dt-text-secondary)' }}>
            Google Sheet URL
          </label>
          <div className="flex gap-2 mb-3">
            <input
              type="text"
              value={spreadsheet}
              onChange={(e) => setSpreadsheet(e.target.value)}
              placeholder="https://docs.google.com/spreadsheets/d/…"
              className="flex-1 px-2 py-1.5 text-sm rounded-md"
              style={inputStyle}
            />
            <button
              onClick={() => load()}
              disabled={busy || !spreadsheet.trim()}
              className="px-3 py-1.5 text-sm rounded-md bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
            >
              {busy ? '…' : 'Load'}
            </button>
          </div>

          {notConnected && (
            <div className="rounded-md p-3 mb-3 text-xs" style={{ background: 'var(--accent-muted)', color: 'var(--foreground)' }}>
              <p className="mb-2">Connect your Google account to read your Sheets (read-only).</p>
              <a
                href="/api/google/oauth/start"
                className="inline-block px-3 py-1.5 rounded-md bg-blue-600 text-white hover:bg-blue-700"
              >
                Connect Google
              </a>
            </div>
          )}

          {/* Step 2: tab + mapping */}
          {preview?.connected && headers.length > 0 && (
            <>
              {preview.tabs && preview.tabs.length > 1 && (
                <label className="text-xs block mb-3" style={{ color: 'var(--dt-text-secondary)' }}>
                  Tab
                  <select
                    value={preview.tab}
                    onChange={(e) => load(e.target.value)}
                    className="mt-1 w-full px-2 py-1.5 text-sm rounded-md"
                    style={inputStyle}
                  >
                    {preview.tabs.map((t) => (
                      <option key={t} value={t}>{t}</option>
                    ))}
                  </select>
                </label>
              )}

              <p className="text-xs mb-1" style={{ color: 'var(--dt-text-secondary)' }}>
                Map columns ({preview.totalRows ?? 0} rows in “{preview.tab}”)
              </p>
              <div className="flex flex-col gap-1 mb-3">
                {IMPORTABLE_FIELD_NAMES.map((field) => (
                  <div key={field} className="flex items-center gap-2">
                    <span className="text-xs w-28 shrink-0" style={{ color: 'var(--foreground)' }}>{field}</span>
                    <select
                      value={mapping[field] ?? ''}
                      onChange={(e) => setMapping((m) => ({ ...m, [field]: e.target.value || undefined }))}
                      className="flex-1 px-2 py-1 text-xs rounded-md"
                      style={inputStyle}
                    >
                      <option value="">— none —</option>
                      {headers.map((h) => (
                        <option key={h} value={h}>{h}</option>
                      ))}
                    </select>
                  </div>
                ))}
              </div>

              <p className="text-xs mb-1" style={{ color: 'var(--dt-text-secondary)' }}>
                Dedup identity (fields that make a row unique)
              </p>
              <div className="flex flex-wrap gap-2 mb-3">
                {IMPORTABLE_FIELD_NAMES.filter((f) => mapping[f]).map((field) => (
                  <label key={field} className="text-xs inline-flex items-center gap-1" style={{ color: 'var(--foreground)' }}>
                    <input
                      type="checkbox"
                      checked={dedup.includes(field)}
                      onChange={(e) =>
                        setDedup((d) => (e.target.checked ? [...d, field] : d.filter((x) => x !== field)))
                      }
                    />
                    {field}
                  </label>
                ))}
              </div>

              <button
                onClick={runImport}
                disabled={busy || dedup.filter((f) => mapping[f]).length === 0}
                className="w-full px-3 py-2 text-sm font-medium rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
              >
                {busy ? 'Importing…' : 'Import'}
              </button>
            </>
          )}

          {result && (
            <p className="text-xs mt-2" style={{ color: 'var(--dt-text-secondary)' }}>
              Imported {result.imported}, updated {result.updated}, skipped {result.skipped} of {result.total}.
            </p>
          )}
          {error && <p className="text-xs mt-2" style={{ color: '#f87171' }}>{error}</p>}
        </div>
      )}
    </div>
  );
}
