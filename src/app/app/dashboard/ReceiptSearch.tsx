'use client';

import { useEffect, useRef } from 'react';

/**
 * The search field above the receipts table. The table package's own search
 * bar counts its hits from the rows it was given, which no longer carry the
 * recognized text; a search that also asks the server for the text has to say
 * its own count, so the field is this one. Cmd+F or Ctrl+F focuses it, Escape
 * clears it.
 */
export default function ReceiptSearch({
  term,
  onTermChange,
  count,
  truncated,
  textFailed,
}: {
  term: string;
  onTermChange: (term: string) => void;
  /** How many receipts the search shows; null while nothing is searched. */
  count: number | null;
  /** True when the text search found more receipts than it returns. */
  truncated: boolean;
  /** True when the server search of the recognized text failed: only names, vendors and amounts were searched. */
  textFailed: boolean;
}) {
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        input.current?.focus();
        input.current?.select();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div
      className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg"
      style={{ background: 'var(--surface)', border: '1px solid var(--border)', minWidth: '16rem' }}
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden style={{ color: 'var(--dt-text-secondary)' }}>
        <circle cx="11" cy="11" r="7" />
        <path d="M20 20l-3.5-3.5" />
      </svg>
      <input
        ref={input}
        value={term}
        onChange={(e) => onTermChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onTermChange('');
        }}
        placeholder="Search..."
        aria-label="Belege durchsuchen"
        className="flex-1 bg-transparent outline-none text-sm"
        style={{ color: 'var(--foreground)' }}
      />
      {count !== null && (
        <span className="text-xs whitespace-nowrap" style={{ color: count > 0 ? 'var(--dt-text-secondary)' : 'var(--dt-accent-danger)' }} role="status">
          {count} {count === 1 ? 'Treffer' : 'Treffer'}
          {truncated ? ' (im Text nur die neuesten, bitte genauer suchen)' : ''}
          {textFailed ? ' (der erkannte Text konnte nicht durchsucht werden, nur Name, Händler und Betrag)' : ''}
        </span>
      )}
      {term && (
        <button type="button" onClick={() => onTermChange('')} aria-label="Suche leeren" className="text-sm" style={{ color: 'var(--dt-text-secondary)' }}>
          ×
        </button>
      )}
    </div>
  );
}
