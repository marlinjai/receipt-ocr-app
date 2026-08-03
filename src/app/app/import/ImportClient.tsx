'use client';

import { useState, useCallback, useEffect } from 'react';
import Link from 'next/link';
import { IMPORTABLE_FIELD_NAMES, type ImportableField, type ColumnMapping } from '@/lib/sheet-import/fields';
import DriveBrowser from './DriveBrowser';

/**
 * Full-page Sheets import flow (replaces the old toolbar popover):
 * 1. connect Google, 2. pick the spreadsheet by browsing Drive (or paste a
 * URL) and choose a tab, 3. map columns + dedup identity and import,
 * 4. pick the Drive folder holding the source invoices and attach them.
 * A returning workspace's last config prefills everything.
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

interface SavedConfig {
  spreadsheetId: string;
  sheetName: string;
  columnMapping: ColumnMapping;
  dedupKeyFields: ImportableField[];
  attachFolderId: string | null;
  attachFolderName: string | null;
  sourceFileHeader: string | null;
}

const DEFAULT_DEDUP: ImportableField[] = ['Vendor', 'Date', 'Gross'];

// Server error codes → human-readable messages.
const ERROR_LABELS: Record<string, string> = {
  invalid_spreadsheet: 'That does not look like a Google Sheets URL or id.',
  no_tabs: 'That spreadsheet has no tabs.',
  sheets_api: 'Google could not read that sheet. Does the connected Google account have access to it?',
  google_api: 'Google Drive request failed. Try again in a moment.',
  forbidden: 'You lack import permission in this workspace.',
  not_connected: 'Connect your Google account first.',
  empty_mapping: 'Map at least one column before importing.',
  no_dedup_fields: 'Pick at least one dedup field.',
  table_not_initialized: 'The Receipts table is not initialized yet — open the dashboard once first.',
  no_import_config: 'Run an import first — attach works on the imported rows.',
  drive_scope_missing: 'Reconnect Google to grant Drive read access (the connection predates it).',
  folder_not_found: 'That Drive folder does not exist (anymore).',
  image_column_missing: 'The Receipts table has no Receipt Image column.',
};
const errorLabel = (code: string | undefined, fallback: string) =>
  (code && ERROR_LABELS[code]) || (code ? `${fallback} (${code})` : fallback);

const inputStyle = {
  background: 'var(--background)',
  border: '1px solid var(--border)',
  color: 'var(--foreground)',
} as const;

const cardStyle = {
  background: 'var(--surface)',
  border: '1px solid var(--border)',
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

// Best-effort initial mapping: exact (case/space-insensitive) match, then
// substring, then alias. The user adjusts from there.
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

function SectionTitle({ step, children }: { step: number; children: React.ReactNode }) {
  return (
    <h2 className="flex items-center gap-2 text-sm font-semibold mb-3" style={{ color: 'var(--foreground)' }}>
      <span
        className="inline-flex items-center justify-center w-5 h-5 rounded-full text-[11px]"
        style={{ background: 'var(--accent-muted)', color: 'var(--accent)' }}
      >
        {step}
      </span>
      {children}
    </h2>
  );
}

export default function ImportClient() {
  const [preview, setPreview] = useState<PreviewData | null>(null);
  const [spreadsheet, setSpreadsheet] = useState('');
  const [selectedSheet, setSelectedSheet] = useState<{ id: string; name: string } | null>(null);
  const [mapping, setMapping] = useState<ColumnMapping>({});
  const [dedup, setDedup] = useState<ImportableField[]>(DEFAULT_DEDUP);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ imported: number; updated: number; skipped: number; total: number } | null>(null);
  const [connected, setConnected] = useState<boolean | null>(null);
  const [googleEmail, setGoogleEmail] = useState<string | null>(null);
  // Attach step
  const [attachFolder, setAttachFolder] = useState<{ id: string; name: string } | null>(null);
  const [attachColumn, setAttachColumn] = useState('Source File');
  const [attachBusy, setAttachBusy] = useState(false);
  const [attachError, setAttachError] = useState<string | null>(null);
  const [attachResult, setAttachResult] = useState<{
    attached: number;
    alreadyAttached: number;
    missingInDrive: string[];
    unmatchedRows: number;
    noSourceFile: number;
  } | null>(null);

  const refreshStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/google/oauth/status');
      if (!res.ok) return;
      const s = (await res.json()) as { connected: boolean; googleEmail: string | null };
      setConnected(s.connected);
      setGoogleEmail(s.googleEmail);
    } catch {
      /* advisory; load() still handles the not-connected case */
    }
  }, []);

  const load = useCallback(
    async (tab?: string, sheetValue?: string, presetMapping?: ColumnMapping) => {
      const source = (sheetValue ?? spreadsheet).trim();
      if (!source) return;
      setBusy(true);
      setError(null);
      setResult(null);
      try {
        const res = await fetch('/api/sheet-import/preview', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ spreadsheet: source, tab }),
        });
        const data = (await res.json().catch(() => ({}))) as PreviewData & { error?: string };
        if (!res.ok) {
          setError(errorLabel(data.error, 'Failed to load sheet'));
          return;
        }
        setPreview(data);
        setConnected(data.connected);
        if (data.connected && data.headers) {
          setMapping((current) => {
            const base = presetMapping ?? current;
            return Object.keys(base).length > 0 ? base : guessMapping(data.headers!);
          });
        }
      } catch {
        setError('Failed to load sheet (network error)');
      } finally {
        setBusy(false);
      }
    },
    [spreadsheet],
  );

  // Mount: connection status + saved config prefill (sheet, mapping, dedup,
  // attach folder). The saved sheet is loaded straight away so a returning
  // user lands on their working setup, not a blank form.
  useEffect(() => {
    void refreshStatus();
    void (async () => {
      try {
        const res = await fetch('/api/sheet-import/config');
        if (!res.ok) return;
        const { config } = (await res.json()) as { config: SavedConfig | null };
        if (!config) return;
        setSpreadsheet(config.spreadsheetId);
        setMapping(config.columnMapping ?? {});
        if (Array.isArray(config.dedupKeyFields) && config.dedupKeyFields.length > 0) setDedup(config.dedupKeyFields);
        if (config.sourceFileHeader) setAttachColumn(config.sourceFileHeader);
        if (config.attachFolderId) setAttachFolder({ id: config.attachFolderId, name: config.attachFolderName ?? 'Saved folder' });
        void load(config.sheetName, config.spreadsheetId, config.columnMapping ?? undefined);
      } catch {
        /* prefill is best-effort */
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount only
  }, []);

  // Returning from the Google consent screen (?google=connected|error).
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const google = params.get('google');
    if (!google) return;
    if (google === 'connected') {
      setError(null);
    } else {
      const reason = params.get('reason');
      setError(reason === 'access_denied' ? 'Google connection was cancelled.' : `Google connection failed${reason ? ` (${reason})` : ''}.`);
    }
    void refreshStatus();
    params.delete('google');
    params.delete('reason');
    const qs = params.toString();
    window.history.replaceState(null, '', window.location.pathname + (qs ? `?${qs}` : ''));
  }, [refreshStatus]);

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
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(errorLabel(data.error, 'Import failed'));
        return;
      }
      setResult(data);
    } catch {
      setError('Import failed (network error)');
    } finally {
      setBusy(false);
    }
  }, [spreadsheet, preview, mapping, dedup]);

  const runAttach = useCallback(async () => {
    if (!attachFolder) return;
    setAttachBusy(true);
    setAttachError(null);
    setAttachResult(null);
    try {
      const res = await fetch('/api/sheet-import/attach', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ folderId: attachFolder.id, folderName: attachFolder.name, sourceFileHeader: attachColumn }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setAttachError(errorLabel(data.error, 'Attach failed'));
        return;
      }
      setAttachResult(data);
    } catch {
      setAttachError('Attach failed (network error)');
    } finally {
      setAttachBusy(false);
    }
  }, [attachFolder, attachColumn]);

  const onBrowserAuthError = useCallback((code: string) => {
    setConnected(false);
    setError(errorLabel(code, 'Google connection problem'));
  }, []);

  const notConnected = connected === false || preview?.connected === false;
  const headers = preview?.headers ?? [];

  return (
    <div className="min-h-screen" style={{ background: 'var(--background)' }}>
      <div className="max-w-5xl mx-auto px-6 py-8">
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <div>
            <Link href="/app/dashboard" className="text-xs hover:underline" style={{ color: 'var(--dt-text-secondary)' }}>
              ← Receipts
            </Link>
            <h1 className="text-2xl font-bold mt-1" style={{ color: 'var(--foreground)' }}>
              Import from Google Sheets
            </h1>
          </div>
          {connected === true && (
            <div className="text-right text-xs" style={{ color: 'var(--dt-text-secondary)' }}>
              <p>
                <span className="inline-block w-2 h-2 rounded-full mr-1.5" style={{ background: '#34d399' }} />
                Google connected{googleEmail ? ` as ${googleEmail}` : ''}
              </p>
              <a href="/api/google/oauth/start" className="hover:underline" style={{ color: 'var(--accent)' }}>
                Reconnect
              </a>
            </div>
          )}
        </div>

        {/* Connect step (only when needed) */}
        {notConnected && (
          <div className="rounded-lg p-4 mb-6 text-sm" style={{ background: 'var(--accent-muted)', color: 'var(--foreground)' }}>
            <p className="mb-3">
              Connect your Google account so the app can read your Sheets and Drive (both read-only). You&rsquo;ll be sent to
              Google&rsquo;s consent screen and returned here.
            </p>
            <a href="/api/google/oauth/start" className="inline-block px-4 py-2 rounded-md text-sm font-medium bg-blue-600 text-white hover:bg-blue-700">
              Connect Google
            </a>
          </div>
        )}

        {error && (
          <p className="text-sm mb-4 px-4 py-3 rounded-lg" style={{ color: '#f87171', background: 'rgba(248,113,113,0.08)', border: '1px solid rgba(248,113,113,0.25)' }}>
            {error}
          </p>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Step 1: source spreadsheet */}
          <div className="rounded-xl p-5" style={cardStyle}>
            <SectionTitle step={1}>Source spreadsheet</SectionTitle>
            <p className="text-xs mb-3" style={{ color: 'var(--dt-text-secondary)' }}>
              Browse your Drive and pick the spreadsheet, or paste its URL below.
            </p>
            <DriveBrowser
              pick="spreadsheet"
              selected={selectedSheet}
              onSelect={(entry) => {
                setSelectedSheet(entry);
                setSpreadsheet(entry.id);
                void load(undefined, entry.id);
              }}
              onAuthError={onBrowserAuthError}
            />
            <div className="flex gap-2 mt-3">
              <input
                type="text"
                value={spreadsheet}
                onChange={(e) => {
                  setSpreadsheet(e.target.value);
                  setSelectedSheet(null);
                }}
                placeholder="…or paste https://docs.google.com/spreadsheets/d/…"
                className="flex-1 px-3 py-2 text-sm rounded-md"
                style={inputStyle}
              />
              <button
                onClick={() => load()}
                disabled={busy || !spreadsheet.trim()}
                className="px-4 py-2 text-sm rounded-md bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
              >
                {busy ? '…' : 'Load'}
              </button>
            </div>

            {preview?.connected && preview.tabs && (
              <label className="text-xs block mt-4" style={{ color: 'var(--dt-text-secondary)' }}>
                Tab
                <select value={preview.tab} onChange={(e) => load(e.target.value)} className="mt-1 w-full px-3 py-2 text-sm rounded-md" style={inputStyle}>
                  {preview.tabs.map((t) => (
                    <option key={t} value={t}>{t}</option>
                  ))}
                </select>
              </label>
            )}
            {preview?.connected && preview.tab && (
              <p className="text-xs mt-2" style={{ color: 'var(--dt-text-secondary)' }}>
                {preview.totalRows ?? 0} rows in “{preview.tab}”.
              </p>
            )}
          </div>

          {/* Step 3: attach invoices from Drive */}
          <div className="rounded-xl p-5" style={{ ...cardStyle, opacity: connected === true ? 1 : 0.5 }}>
            <SectionTitle step={3}>Attach invoice files from Drive</SectionTitle>
            <p className="text-xs mb-3" style={{ color: 'var(--dt-text-secondary)' }}>
              Pick the Drive folder holding the source invoices (PDF or PNG/JPEG). Each imported row&rsquo;s file column is
              matched against the folder; rows that already have a receipt file are skipped, so re-running is safe.
            </p>
            {connected === true ? (
              <>
                <DriveBrowser pick="folder" selected={attachFolder} onSelect={setAttachFolder} onAuthError={onBrowserAuthError} />
                <div className="flex items-center gap-2 mt-3">
                  <div className="flex-1 text-xs px-3 py-2 rounded-md truncate" style={inputStyle}>
                    {attachFolder ? (
                      <>
                        Folder: <strong>{attachFolder.name}</strong>
                      </>
                    ) : (
                      'No folder selected yet'
                    )}
                  </div>
                  <input
                    value={attachColumn}
                    onChange={(e) => setAttachColumn(e.target.value)}
                    placeholder="Sheet file column"
                    className="w-36 px-3 py-2 text-xs rounded-md"
                    style={inputStyle}
                    aria-label="Sheet source-file column"
                  />
                  <button
                    onClick={runAttach}
                    disabled={attachBusy || !attachFolder}
                    className="px-3 py-2 text-xs font-medium rounded-md bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
                  >
                    {attachBusy ? 'Attaching…' : 'Attach files'}
                  </button>
                </div>
                {attachResult && (
                  <p className="text-xs mt-3" style={{ color: 'var(--dt-text-secondary)' }}>
                    Attached {attachResult.attached}, already had one {attachResult.alreadyAttached}
                    {attachResult.missingInDrive.length > 0 && `, not found in Drive: ${attachResult.missingInDrive.join(', ')}`}
                    {attachResult.unmatchedRows > 0 && `, ${attachResult.unmatchedRows} rows not from this import`}
                    {attachResult.noSourceFile > 0 && `, ${attachResult.noSourceFile} without a file entry`}.
                  </p>
                )}
                {attachError && <p className="text-xs mt-3" style={{ color: '#f87171' }}>{attachError}</p>}
              </>
            ) : (
              <p className="text-xs" style={{ color: 'var(--dt-text-secondary)' }}>Connect Google first.</p>
            )}
          </div>
        </div>

        {/* Step 2: mapping + import (full width, needs the room) */}
        {preview?.connected && headers.length > 0 && (
          <div className="rounded-xl p-5 mt-6" style={cardStyle}>
            <SectionTitle step={2}>Map columns &amp; import</SectionTitle>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-2 mb-4">
              {IMPORTABLE_FIELD_NAMES.map((field) => (
                <div key={field} className="flex items-center gap-3">
                  <span className="text-sm w-32 shrink-0" style={{ color: 'var(--foreground)' }}>{field}</span>
                  <select
                    value={mapping[field] ?? ''}
                    onChange={(e) => setMapping((m) => ({ ...m, [field]: e.target.value || undefined }))}
                    className="flex-1 px-2 py-1.5 text-sm rounded-md"
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

            <p className="text-xs mb-2" style={{ color: 'var(--dt-text-secondary)' }}>
              Dedup identity (fields that make a row unique)
            </p>
            <div className="flex flex-wrap gap-3 mb-4">
              {IMPORTABLE_FIELD_NAMES.filter((f) => mapping[f]).map((field) => (
                <label key={field} className="text-sm inline-flex items-center gap-1.5" style={{ color: 'var(--foreground)' }}>
                  <input
                    type="checkbox"
                    checked={dedup.includes(field)}
                    onChange={(e) => setDedup((d) => (e.target.checked ? [...d, field] : d.filter((x) => x !== field)))}
                  />
                  {field}
                </label>
              ))}
            </div>

            <div className="flex items-center gap-4">
              <button
                onClick={runImport}
                disabled={busy || dedup.filter((f) => mapping[f]).length === 0}
                className="px-5 py-2.5 text-sm font-medium rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
              >
                {busy ? 'Importing…' : 'Import'}
              </button>
              {result && (
                <p className="text-sm" style={{ color: 'var(--dt-text-secondary)' }}>
                  Imported {result.imported}, updated {result.updated}, skipped {result.skipped} of {result.total}.
                </p>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
