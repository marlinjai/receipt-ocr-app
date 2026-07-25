'use client';

import { useState, useEffect, useCallback } from 'react';

/**
 * Minimal Google Drive browser for the import page. Navigates the folder
 * hierarchy (My Drive root, shared drives, and a Shared-with-me pseudo-folder)
 * one level at a time via /api/google/drive/browse. Shared-drive roots are
 * tracked as `drive:<id>` path entries (the API needs the drive corpus); the
 * prefix is stripped before a folder selection leaves this component.
 *
 * Two modes:
 * - `pick="spreadsheet"`: folders navigate, spreadsheets are selectable.
 * - `pick="folder"`: folders navigate, "Use this folder" selects the current
 *   one; invoice files (PDF/PNG/JPEG) are listed for orientation.
 */

export interface DriveEntry {
  id: string;
  name: string;
  mimeType?: string;
}

interface DriveBrowserProps {
  pick: 'spreadsheet' | 'folder';
  selected?: { id: string; name: string } | null;
  onSelect: (entry: { id: string; name: string }) => void;
  /** Bubble up auth-shaped failures (not_connected / drive_scope_missing). */
  onAuthError?: (code: string) => void;
}

const SPREADSHEET_MIME = 'application/vnd.google-apps.spreadsheet';

const rowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  width: '100%',
  textAlign: 'left',
  padding: '6px 8px',
  borderRadius: 6,
  fontSize: 13,
  color: 'var(--foreground)',
  background: 'transparent',
  border: 'none',
  cursor: 'pointer',
};

function EntryIcon({ kind }: { kind: 'folder' | 'sheet' | 'file' }) {
  if (kind === 'folder') {
    return (
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#e2a348" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2z" />
      </svg>
    );
  }
  const color = kind === 'sheet' ? '#34a853' : '#8b8b9a';
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M14 3v4a1 1 0 0 0 1 1h4" />
      <path d="M17 21H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h7l5 5v11a2 2 0 0 1-2 2z" />
    </svg>
  );
}

export default function DriveBrowser({ pick, selected, onSelect, onAuthError }: DriveBrowserProps) {
  // Breadcrumb path; the tail is the folder currently listed.
  const [path, setPath] = useState<{ id: string; name: string }[]>([{ id: 'root', name: 'My Drive' }]);
  const [folders, setFolders] = useState<DriveEntry[]>([]);
  const [sharedDrives, setSharedDrives] = useState<DriveEntry[]>([]);
  const [files, setFiles] = useState<DriveEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const current = path[path.length - 1];

  const load = useCallback(
    async (parent: string) => {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(`/api/google/drive/browse?parent=${encodeURIComponent(parent)}`);
        const data = (await res.json().catch(() => ({}))) as {
          folders?: DriveEntry[];
          sharedDrives?: DriveEntry[];
          files?: DriveEntry[];
          error?: string;
        };
        if (!res.ok) {
          if (data.error === 'not_connected' || data.error === 'drive_scope_missing') {
            onAuthError?.(data.error);
          }
          setError(data.error ?? 'browse_failed');
          setFolders([]);
          setSharedDrives([]);
          setFiles([]);
          return;
        }
        setFolders(data.folders ?? []);
        setSharedDrives(data.sharedDrives ?? []);
        setFiles(data.files ?? []);
      } catch {
        setError('network_error');
      } finally {
        setLoading(false);
      }
    },
    [onAuthError],
  );

  useEffect(() => {
    void load(current.id);
  }, [current.id, load]);

  const visibleFiles = pick === 'spreadsheet' ? files.filter((f) => f.mimeType === SPREADSHEET_MIME) : files.filter((f) => f.mimeType !== SPREADSHEET_MIME);

  return (
    <div className="rounded-lg" style={{ border: '1px solid var(--border)', background: 'var(--background)' }}>
      {/* Breadcrumb */}
      <div
        className="flex items-center gap-1 flex-wrap px-3 py-2 text-xs"
        style={{ borderBottom: '1px solid var(--border)', color: 'var(--dt-text-secondary)' }}
      >
        {path.map((p, i) => (
          <span key={p.id} className="flex items-center gap-1">
            {i > 0 && <span aria-hidden>/</span>}
            <button
              onClick={() => setPath((prev) => prev.slice(0, i + 1))}
              className="hover:underline"
              style={{ color: i === path.length - 1 ? 'var(--foreground)' : 'inherit', background: 'none', border: 'none', cursor: 'pointer', padding: 0, fontSize: 12 }}
            >
              {p.name}
            </button>
          </span>
        ))}
        {pick === 'folder' && current.id !== 'shared' && (
          <button
            onClick={() => onSelect({ id: current.id.replace(/^drive:/, ''), name: current.name })}
            disabled={selected?.id === current.id.replace(/^drive:/, '')}
            className="ml-auto px-2 py-1 rounded-md text-xs font-medium bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {selected?.id === current.id.replace(/^drive:/, '') ? 'Selected' : 'Use this folder'}
          </button>
        )}
      </div>

      {/* Listing */}
      <div className="max-h-64 overflow-y-auto p-1.5">
        {loading && (
          <p className="px-2 py-2 text-xs" style={{ color: 'var(--dt-text-secondary)' }}>Loading…</p>
        )}
        {!loading && error && (
          <p className="px-2 py-2 text-xs" style={{ color: '#f87171' }}>
            Could not browse Drive ({error}).
          </p>
        )}
        {!loading && !error && (
          <>
            {current.id === 'root' && (
              <button onClick={() => setPath((prev) => [...prev, { id: 'shared', name: 'Shared with me' }])} style={rowStyle} className="hover:bg-white/5">
                <EntryIcon kind="folder" />
                Shared with me
              </button>
            )}
            {current.id === 'root' &&
              sharedDrives.map((d) => (
                <button
                  key={d.id}
                  onClick={() => setPath((prev) => [...prev, { id: `drive:${d.id}`, name: d.name }])}
                  style={rowStyle}
                  className="hover:bg-white/5"
                >
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#60a5fa" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                    <path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2z" />
                    <circle cx="12" cy="13" r="2.5" />
                  </svg>
                  <span className="truncate">{d.name}</span>
                  <span className="ml-auto text-[10px]" style={{ color: 'var(--dt-text-secondary)' }}>Shared drive</span>
                </button>
              ))}
            {folders.map((f) => (
              <button key={f.id} onClick={() => setPath((prev) => [...prev, { id: f.id, name: f.name }])} style={rowStyle} className="hover:bg-white/5">
                <EntryIcon kind="folder" />
                <span className="truncate">{f.name}</span>
              </button>
            ))}
            {visibleFiles.map((f) =>
              pick === 'spreadsheet' ? (
                <button
                  key={f.id}
                  onClick={() => onSelect({ id: f.id, name: f.name })}
                  style={{ ...rowStyle, background: selected?.id === f.id ? 'var(--accent-muted)' : 'transparent' }}
                  className="hover:bg-white/5"
                >
                  <EntryIcon kind="sheet" />
                  <span className="truncate">{f.name}</span>
                  {selected?.id === f.id && <span className="ml-auto text-xs" style={{ color: 'var(--accent)' }}>Selected</span>}
                </button>
              ) : (
                <div key={f.id} style={{ ...rowStyle, cursor: 'default', color: 'var(--dt-text-secondary)' }}>
                  <EntryIcon kind="file" />
                  <span className="truncate">{f.name}</span>
                </div>
              ),
            )}
            {folders.length === 0 && visibleFiles.length === 0 && current.id !== 'root' && (
              <p className="px-2 py-2 text-xs" style={{ color: 'var(--dt-text-secondary)' }}>
                {pick === 'spreadsheet' ? 'No folders or spreadsheets here.' : 'No subfolders or invoice files here.'}
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}
