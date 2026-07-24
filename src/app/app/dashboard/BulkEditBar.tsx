'use client';

import { useEffect, useMemo, useState } from 'react';
import type { CellValue, Column, Row, SelectOption } from '@marlinjai/data-table-core';

const inputStyle = {
  background: 'var(--background)',
  border: '1px solid var(--border)',
  color: 'var(--foreground)',
} as const;

const CLEAR = '__clear__';

/**
 * Batch cell editing for the current row selection: pick a select-type column
 * (Project, Category, Zuordnung, Status, Currency), pick a value (or Clear),
 * apply to every selected row. Runs through the same guarded updateCell path a
 * single-cell edit uses, so authorization and live UI updates come for free.
 */
export default function BulkEditBar({
  columns,
  selectOptions,
  loadSelectOptions,
  selectedRows,
  updateCell,
}: {
  columns: Column[];
  selectOptions: Map<string, SelectOption[]>;
  loadSelectOptions: (columnId: string) => Promise<void>;
  selectedRows: Set<string>;
  updateCell: (rowId: string, columnId: string, value: CellValue) => Promise<Row>;
}) {
  const selectColumns = useMemo(() => columns.filter((c) => c.type === 'select'), [columns]);
  const [columnId, setColumnId] = useState('');
  const [value, setValue] = useState('');
  const [progress, setProgress] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Options for select columns load lazily; fetch when a column is chosen.
  useEffect(() => {
    if (columnId && !selectOptions.has(columnId)) void loadSelectOptions(columnId);
  }, [columnId, selectOptions, loadSelectOptions]);

  const options = columnId ? (selectOptions.get(columnId) ?? []) : [];

  const apply = async () => {
    if (!columnId || !value || selectedRows.size === 0) return;
    setBusy(true);
    const ids = [...selectedRows];
    let done = 0;
    let failed = 0;
    for (const rowId of ids) {
      try {
        await updateCell(rowId, columnId, value === CLEAR ? null : value);
        done++;
      } catch {
        failed++;
      }
      setProgress(`${done + failed}/${ids.length}${failed ? ` (${failed} failed)` : ''}`);
    }
    setProgress(failed ? `Done: ${done} set, ${failed} failed` : `Done: ${done} set`);
    setBusy(false);
  };

  if (selectedRows.size === 0) return null;

  return (
    <div className="inline-flex items-center gap-1.5">
      <select
        value={columnId}
        onChange={(e) => {
          setColumnId(e.target.value);
          setValue('');
          setProgress(null);
        }}
        className="px-2 py-1 text-xs rounded-md"
        style={inputStyle}
        aria-label="Bulk edit column"
      >
        <option value="">Set field…</option>
        {selectColumns.map((c) => (
          <option key={c.id} value={c.id}>{c.name}</option>
        ))}
      </select>
      {columnId && (
        <select
          value={value}
          onChange={(e) => setValue(e.target.value)}
          className="px-2 py-1 text-xs rounded-md"
          style={inputStyle}
          aria-label="Bulk edit value"
        >
          <option value="">Value…</option>
          {options.map((o) => (
            <option key={o.id} value={o.id}>{o.name}</option>
          ))}
          <option value={CLEAR}>— Clear —</option>
        </select>
      )}
      {columnId && value && (
        <button
          onClick={apply}
          disabled={busy}
          className="px-2.5 py-1 text-xs font-medium rounded-md bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {busy ? 'Applying…' : `Apply to ${selectedRows.size}`}
        </button>
      )}
      {progress && (
        <span className="text-[11px]" style={{ color: 'var(--dt-text-secondary)' }}>{progress}</span>
      )}
    </div>
  );
}
