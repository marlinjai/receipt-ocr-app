'use client';

import { formatDay, formatEuro } from '@/lib/meals/messages';
import type { MealRecord } from '@/lib/meals/types';
import { useReceiptActions } from './useReceiptActions';

interface DismissedMealsProps {
  /** "Bewirtung" receipts marked "Keine Bewirtung", in any order. */
  records: MealRecord[];
  onRecordsSaved: (records: MealRecord[]) => void;
  onRecordsRemoved: (rowIds: string[]) => void;
}

/**
 * Where "Keine Bewirtung" is undone. The receipts marked that way are out of
 * queue and register but keep their details; taking one back sets it to a
 * business meal again, and it returns to the register (complete) or the queue
 * (facts missing) exactly as its details stand.
 *
 * It sits below everything else on the page and opens downwards, so opening
 * it moves nothing that was on screen.
 */
export default function DismissedMeals({ records, onRecordsSaved, onRecordsRemoved }: DismissedMealsProps) {
  const actions = useReceiptActions({ onRecordsSaved, onRecordsRemoved, dismissedHint: '' });
  if (records.length === 0) return <>{actions.overlays}</>;

  const sorted = [...records].sort((a, b) => ((a.date ?? '') < (b.date ?? '') ? 1 : -1));

  return (
    <section aria-label="Keine Bewirtung" className="mt-10">
      <details className="ui-disclosure glass-panel rounded-xl">
        <summary>
          <svg className="ui-disclosure-chevron" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
            <path d="M6 3.5 10.5 8 6 12.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <span className="text-sm font-semibold" style={{ color: 'var(--foreground)' }}>
            Keine Bewirtung ({records.length})
          </span>
          <span className="ml-auto hidden text-xs sm:inline" style={{ color: 'var(--muted)' }}>
            Aus dem Verzeichnis genommen, wieder aufnehmbar
          </span>
        </summary>
        <div className="border-t px-4 pb-4 pt-3" style={{ borderColor: 'var(--border-subtle)' }}>
          <p className="mb-3 max-w-2xl text-xs leading-relaxed" style={{ color: 'var(--muted)' }}>
            Diese Belege sind als Bewirtung kategorisiert, wurden aber als „Keine Bewirtung“ markiert. Sie bleiben im
            Dashboard und zählen nicht ins Verzeichnis. „Wieder aufnehmen“ führt einen Beleg mit den zuvor erfassten
            Angaben wieder als Bewirtung.
          </p>
          <ul>
            {sorted.map((record) => {
              const name = record.vendor || record.name || 'Beleg ohne Namen';
              return (
                <li
                  key={record.rowId}
                  className="flex min-h-11 items-center justify-between gap-x-3 border-t py-1 first:border-t-0 max-sm:flex-col max-sm:items-start max-sm:py-2"
                  style={{ borderColor: 'var(--border-subtle)' }}
                >
                  <span className="min-w-0 text-sm sm:truncate" style={{ color: 'var(--foreground)' }}>
                    <span className="tabular-nums" style={{ color: 'var(--muted)' }}>
                      {formatDay(record.date)}
                    </span>
                    {' · '}
                    {name}
                    {record.gross && record.currency === 'EUR' ? ` · ${formatEuro(record.gross)}` : ''}
                  </span>
                  <button
                    type="button"
                    className="ui-btn ui-btn-sm ui-btn-ghost shrink-0 max-sm:-ml-2.5"
                    disabled={actions.busy}
                    aria-label={`Wieder aufnehmen: ${name}, ${formatDay(record.date)}`}
                    onClick={() => actions.restore([record])}
                  >
                    Wieder aufnehmen
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      </details>
      {actions.overlays}
    </section>
  );
}
