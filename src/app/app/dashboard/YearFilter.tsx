'use client';

import { useRef } from 'react';
import { NO_YEARS, hasYearFilter, selectYearRange, toggleUndated, toggleYear, type YearCount, type YearSelection } from '@/lib/receipt-years';

const receiptsWord = (n: number) => (n === 1 ? '1 Beleg' : `${n} Belege`);

const chipClass = 'px-2.5 py-1 text-xs font-medium rounded-md transition-colors duration-150 tabular-nums';

function chipStyle(pressed: boolean) {
  return pressed
    ? ({ background: 'var(--accent)', color: 'var(--background)', border: '1px solid var(--accent)' } as const)
    : ({ background: 'var(--surface)', color: 'var(--foreground)', border: '1px solid var(--border)' } as const);
}

/**
 * The year filter above the receipts table: one chip per year that has
 * receipts, with how many. A click chooses a year or takes it out again; Shift
 * and a click chooses every year between the last one clicked and this one;
 * "Alle" clears the choice. Several years, or a range, are shown together.
 *
 * Controlled: the choice lives in the dashboard, which filters the rows and
 * keeps it in the address (see `DashboardClient`).
 */
export default function YearFilter({
  years,
  undated,
  selection,
  shown,
  total,
  onChange,
}: {
  /** The years that have receipts, newest first. */
  years: YearCount[];
  /** Receipts without a date. */
  undated: number;
  selection: YearSelection;
  /** How many receipts the choice shows, and how many there are. */
  shown: number;
  total: number;
  onChange: (next: YearSelection) => void;
}) {
  const anchor = useRef<number | null>(null);
  const active = hasYearFilter(selection);
  // A year the address names but no receipt has stays on the bar, so it can be taken out again.
  const present = new Set(years.map((y) => y.year));
  const chips: YearCount[] = [...years, ...[...selection.years].filter((y) => !present.has(y)).map((year) => ({ year, count: 0 }))].sort(
    (a, b) => a.year - b.year,
  );
  const available = chips.map((c) => c.year);

  const click = (year: number, shift: boolean) => {
    onChange(shift ? selectYearRange(selection, anchor.current, year, available) : toggleYear(selection, year));
    anchor.current = year;
  };

  if (chips.length === 0 && undated === 0) return null;

  return (
    <div className="inline-flex flex-wrap items-center gap-1.5" role="group" aria-label="Nach Jahr filtern">
      <span className="text-xs mr-0.5" style={{ color: 'var(--dt-text-secondary)' }}>
        Jahr
      </span>
      <button
        type="button"
        className={chipClass}
        style={chipStyle(!active)}
        aria-pressed={!active}
        onClick={() => {
          onChange(NO_YEARS);
          anchor.current = null;
        }}
      >
        Alle
      </button>
      {chips.map(({ year, count }) => {
        const pressed = selection.years.has(year);
        return (
          <button
            key={year}
            type="button"
            className={chipClass}
            style={chipStyle(pressed)}
            aria-pressed={pressed}
            aria-label={`${year}: ${receiptsWord(count)}`}
            title="Klick wählt das Jahr. Umschalt + Klick wählt alle Jahre bis hierhin."
            onClick={(e) => click(year, e.shiftKey)}
          >
            {year}
            <span className="ml-1.5 opacity-70">{count}</span>
          </button>
        );
      })}
      {undated > 0 && (
        <button
          type="button"
          className={chipClass}
          style={chipStyle(selection.undated)}
          aria-pressed={selection.undated}
          aria-label={`ohne Datum: ${receiptsWord(undated)}`}
          onClick={() => onChange(toggleUndated(selection))}
        >
          ohne Datum
          <span className="ml-1.5 opacity-70">{undated}</span>
        </button>
      )}
      {active && (
        <span className="text-xs ml-1" style={{ color: 'var(--dt-text-secondary)' }} role="status">
          {shown} von {total} Belegen. Gruppen zeigen die Summe der Belege dieser Jahre.
        </span>
      )}
    </div>
  );
}
