'use client';

import { useEffect, useMemo, useState } from 'react';
import type { Column, SelectOption } from '@marlinjai/data-table-core';
import { joinOutcomes, outcomeWording, partsOf, unconfirmed, type BulkSetFailure, type BulkSetOutcome } from './bulk-set';

const inputStyle = {
  background: 'var(--background)',
  border: '1px solid var(--border)',
  color: 'var(--foreground)',
} as const;

const CLEAR = '__clear__';

/** Failures worth another try: the write failed, did not land, or got no answer. The others would fail again. */
const RETRIABLE: ReadonlySet<BulkSetFailure> = new Set<BulkSetFailure>(['failed', 'not_stored', 'unconfirmed']);

/**
 * Batch cell editing for the current row selection: pick a select-type column
 * (Project, Category, Zuordnung, Status, Currency), pick a value (or clear it),
 * apply to every selected row. The server writes the selection in parts, row
 * after row through the same guarded write a cell edit takes, and reads each
 * part back (see `bulk-set.ts`): the bar says how many were really set and why
 * the others were not, and offers another try for those that may still work.
 * The table is loaded again afterwards, so it shows what is stored.
 */
export default function BulkEditBar({
  columns,
  selectOptions,
  loadSelectOptions,
  selectedRows,
  setField,
  onDone,
}: {
  columns: Column[];
  selectOptions: Map<string, SelectOption[]>;
  loadSelectOptions: (columnId: string) => Promise<void>;
  selectedRows: Set<string>;
  /** Sets the column to the value (null clears it) on at most `BULK_SET_PART` rows, and says what came of each. */
  setField: (rowIds: string[], columnId: string, value: string | null) => Promise<BulkSetOutcome>;
  /** After a run: load the table again. (The dashboard's reload shows its own failure in the table's banner; a rejection is said here.) */
  onDone: () => Promise<void> | void;
}) {
  const selectColumns = useMemo(() => columns.filter((c) => c.type === 'select'), [columns]);
  const [columnId, setColumnId] = useState('');
  const [value, setValue] = useState('');
  const [progress, setProgress] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // The rows of the last run that may still be set by another try, with what was asked for them.
  const [retry, setRetry] = useState<{ rowIds: string[]; columnId: string; value: string } | null>(null);

  // Options for select columns load lazily; fetch when a column is chosen.
  useEffect(() => {
    if (columnId && !selectOptions.has(columnId)) void loadSelectOptions(columnId);
  }, [columnId, selectOptions, loadSelectOptions]);

  const options = columnId ? (selectOptions.get(columnId) ?? []) : [];

  const run = async (rowIds: string[], forColumn: string, forValue: string, isRetry = false) => {
    if (busy || rowIds.length === 0) return;
    setBusy(true);
    setRetry(null);
    const parts = partsOf(rowIds);
    const total = parts.reduce((n, p) => n + p.length, 0);
    const outcomes: BulkSetOutcome[] = [];
    let handled = 0;
    setProgress(`0 von ${total} …`);
    for (const part of parts) {
      try {
        outcomes.push(await setField(part, forColumn, forValue === CLEAR ? null : forValue));
      } catch {
        // No answer for this part (a lost connection, an expired session): none of it is counted as set.
        outcomes.push(unconfirmed(part));
      }
      handled += part.length;
      setProgress(`${handled} von ${total} …`);
    }
    const outcome = joinOutcomes(outcomes);
    let said = outcomeWording(outcome, total);
    const again = outcome.failed.filter((f) => RETRIABLE.has(f.reason)).map((f) => f.rowId);
    // A retry on which no part answered at all (an expired session, a lost connection) would only fail the same
    // way again: the page has to be loaded anew instead.
    const allUnanswered = outcome.done.length === 0 && outcome.failed.every((f) => f.reason === 'unconfirmed');
    if (isRetry && allUnanswered) said += ' Bitte die Seite neu laden und dann noch einmal versuchen.';
    setRetry(again.length > 0 && !(isRetry && allUnanswered) ? { rowIds: again, columnId: forColumn, value: forValue } : null);
    try {
      await onDone();
    } catch {
      said += ' Die Tabelle konnte nicht neu geladen werden, bitte die Seite neu laden.';
    } finally {
      setProgress(said);
      setBusy(false);
    }
  };

  // The retry names what it writes: the rows of the last run that were not set, whatever is selected now.
  function retryButton(r: { rowIds: string[]; columnId: string; value: string }) {
    return (
      <button
        type="button"
        onClick={() => void run(r.rowIds, r.columnId, r.value, true)}
        className="px-2.5 py-1 text-xs font-medium rounded-md"
        style={inputStyle}
      >
        {`Erneut versuchen für die ${r.rowIds.length} nicht gesetzten`}
      </button>
    );
  }

  const apply = () => {
    if (!columnId || !value || selectedRows.size === 0) return;
    void run([...selectedRows], columnId, value);
  };

  // The outcome of a run stays in view even when the reload afterwards emptied the selection (a view that
  // filters on the column just set drops those rows): it is the one place that says what was really set.
  if (selectedRows.size === 0) {
    if (!progress && !retry) return null;
    return (
      <div className="inline-flex items-center gap-1.5">
        {progress && (
          <span role="status" className="text-[11px]" style={{ color: 'var(--dt-text-secondary)' }}>{progress}</span>
        )}
        {retry && !busy && retryButton(retry)}
      </div>
    );
  }

  return (
    <div className="inline-flex items-center gap-1.5">
      <select
        value={columnId}
        onChange={(e) => {
          setColumnId(e.target.value);
          setValue('');
          setProgress(null);
          setRetry(null);
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
          onChange={(e) => {
            setValue(e.target.value);
            setProgress(null);
            setRetry(null);
          }}
          className="px-2 py-1 text-xs rounded-md"
          style={inputStyle}
          aria-label="Bulk edit value"
        >
          <option value="">Value…</option>
          {options.map((o) => (
            <option key={o.id} value={o.id}>{o.name}</option>
          ))}
          <option value={CLEAR}>(clear)</option>
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
        <span role="status" className="text-[11px]" style={{ color: 'var(--dt-text-secondary)' }}>{progress}</span>
      )}
      {retry && !busy && retryButton(retry)}
    </div>
  );
}
