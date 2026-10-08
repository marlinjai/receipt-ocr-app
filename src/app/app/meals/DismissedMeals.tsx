'use client';

import { formatDay, formatEuro } from '@/lib/meals/messages';
import type { MealRecord } from '@/lib/meals/types';
import { ActionNotice, useReceiptActions } from './useReceiptActions';

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
 */
export default function DismissedMeals({ records, onRecordsSaved, onRecordsRemoved }: DismissedMealsProps) {
  const actions = useReceiptActions({ onRecordsSaved, onRecordsRemoved, dismissedHint: '' });
  if (records.length === 0 && !actions.notice) return null;

  const sorted = [...records].sort((a, b) => ((a.date ?? '') < (b.date ?? '') ? 1 : -1));

  return (
    <section aria-label="Keine Bewirtung" className="mt-8">
      <ActionNotice notice={actions.notice} className="mb-2" />
      {records.length > 0 && (
        <details className="glass-panel rounded-xl">
          <summary className="cursor-pointer rounded-xl px-4 py-3 text-sm font-semibold" style={{ color: 'var(--foreground)' }}>
            Keine Bewirtung ({records.length})
          </summary>
          <div className="px-4 pb-4">
            <p className="mb-3 max-w-2xl text-xs leading-relaxed" style={{ color: 'var(--muted)' }}>
              Diese Belege sind als Bewirtung kategorisiert, wurden aber als „Keine Bewirtung“ markiert. Sie bleiben im
              Dashboard und zählen nicht ins Verzeichnis. „Wieder aufnehmen“ führt einen Beleg mit den zuvor erfassten
              Angaben wieder als Bewirtung.
            </p>
            <ul className="space-y-1.5">
              {sorted.map((record) => {
                const name = record.vendor || record.name || 'Beleg ohne Namen';
                return (
                  <li key={record.rowId} className="ui-note flex flex-wrap items-center justify-between gap-2">
                    <span className="min-w-0">
                      {formatDay(record.date)} · {name}
                      {record.gross && record.currency === 'EUR' ? ` · ${formatEuro(record.gross)}` : ''}
                    </span>
                    <button
                      type="button"
                      className="ui-btn ui-btn-sm"
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
      )}
    </section>
  );
}
